import { Events } from "discord.js";
import { config } from "../config.ts";
import { audit, sessions } from "../db.ts";
import { isDelta, isToolPart, type AgentEvent } from "../agent/events.ts";
import { models } from "../agent/models.ts";
import { Runtime } from "../agent/runtime.ts";
import { Supervisor } from "../agent/supervisor.ts";
import { startBridge } from "../bridge/server.ts";
import { attachMessageHandler, createDiscordClient } from "../discord/client.ts";
import { services } from "../discord/services.ts";
import { log } from "../log.ts";

const logger = log("e2e");
const DEADLINE_MS = 180_000;

/**
 * Live-surface check with the real gateway connection: the model must reach a Discord capability through the
 * generated workspace tool → bridge → policy gate → discord.js, and come back with the tool's real output.
 * This is the only test that proves bridge identity binding, not just the opencode plumbing.
 */
async function main(): Promise<void> {
  const client = createDiscordClient();
  let runtime: Runtime | undefined;
  const supervisor = new Supervisor((guildId, event) => runtime?.handleEvent(guildId, event));
  runtime = new Runtime(client, supervisor);
  services.set({ client, supervisor, runtime });
  const bridge = startBridge(client);

  const { promise: ready, resolve: onReady } = Promise.withResolvers<void>();
  client.once(Events.ClientReady, () => onReady());
  await client.login(config.discord.token);
  await ready;
  logger.info("logged in", { user: client.user?.tag });
  await supervisor.start();

  const guild = client.guilds.cache.first();
  if (!guild) throw new Error("the bot is in no guilds; invite it first");
  const channel = guild.channels.cache.find((entry) => entry.isTextBased() && !entry.isThread());
  if (!channel) throw new Error("guild has no text channel");
  if (!config.guild(guild.id)?.enabled) {
    logger.warn("guild was not enabled; enabling it", { guild: guild.name });
    config.setGuild(guild.id, { enabled: true, shell: config.shellDefaults, roles: { admin: [], trusted: [] } });
  }

  attachMessageHandler(client, runtime);
  const server = await supervisor.ensure(guild.id, guild.name);
  const session = await server.opencode.createSession("e2e");
  sessions.set({
    chat_key: `${guild.id}:${channel.id}`,
    guild_id: guild.id,
    channel_id: channel.id,
    session_id: session,
    actor_id: config.discord.ownerId,
  });
  logger.info("session bound", { guild: guild.name, channel: channel.id, session });

  const events: AgentEvent[] = [];
  const controller = new AbortController();
  server.opencode.subscribe((event) => events.push(event), controller.signal);

  await server.opencode.prompt(
    session,
    "Use the discord_channels_list tool to list this server's channels, then reply with one line: " +
      "`total=<number of channels listed>` and the name of the first channel.",
    models.primary(),
  );

  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === "session.idle")) break;
    await Bun.sleep(250);
  }
  controller.abort();

  const text = await server.opencode.lastText(session);
  const toolCalls = events.filter(isToolPart).map((event) => event.properties.part);
  const bridgeCall = toolCalls.find((part) => part.tool === "discord_channels_list");
  const errors = events.filter((event) => event.type === "session.error");
  const auditRow = audit.recent(guild.id, 5).find((row) => row.tool === "channels_list");

  logger.info("tool calls", { calls: toolCalls.map((part) => `${part.tool}:${part.state?.status}`).join(", ") || "none" });
  logger.info("audit", { verdict: auditRow?.verdict ?? "missing", layer: auditRow?.layer ?? "-" });
  logger.info("final text", { text: text.slice(0, 300) });
  if (errors.length > 0) logger.warn("session errors", { detail: JSON.stringify(errors).slice(0, 400) });

  const passed = Boolean(bridgeCall) && auditRow?.verdict === "allow" && /total=\d+/.test(text);
  logger.info(passed ? "e2e PASSED" : "e2e FAILED", { deltas: events.filter(isDelta).length });

  controller.abort();
  bridge.stop(true);
  await supervisor.stopAll();
  client.destroy();
  process.exit(passed ? 0 : 1);
}

await main().catch((error) => {
  logger.error("e2e crashed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
