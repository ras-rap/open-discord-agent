import { Events, IntentsBitField, Partials, TextChannel, type ApplicationCommandDataResolvable } from "discord.js";
import { Client } from "discordx";
import { log } from "../log.ts";
import type { Runtime } from "../agent/runtime.ts";
import { config } from "../config.ts";
import "./commands.ts";

const logger = log("discord");

/** discordx Client: same as discord.js, but it dispatches decorated slash/button handlers. */
export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      IntentsBitField.Flags.Guilds,
      IntentsBitField.Flags.GuildMessages,
      IntentsBitField.Flags.GuildMembers,
      IntentsBitField.Flags.MessageContent,
      IntentsBitField.Flags.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
    silent: false,
  });

  /**
   * discordx dispatches decorated handlers; anything that throws before acknowledging leaves Discord showing
   * "The application did not respond" with no trace in our logs. Both failure modes are made visible here:
   * exceptions are logged and reported to the user, and a handler that returns without replying is caught.
   */
  client.on(Events.InteractionCreate, async (interaction) => {
    const label = interaction.isChatInputCommand()
      ? `/${interaction.commandName}`
      : interaction.isButton()
        ? `button ${interaction.customId}`
        : `type ${interaction.type}`;
    const latency = Date.now() - interaction.createdTimestamp;
    logger.info("interaction received", { label, guild: interaction.guildId ?? "dm", latencyMs: latency });
    if (latency > 2500) {
      logger.warn("interaction arrived late; the gateway session is unhealthy", {
        label,
        latencyMs: latency,
        hint: "Discord expires interactions after 3s. Usual cause: a second process using the same bot token (check `ps aux | grep src/index.ts`), or a paused/throttled host.",
      });
    }
    try {
      await client.executeInteraction(interaction);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const expired = typeof error === "object" && error !== null && "code" in error && error.code === 10062;
      if (expired) {
        logger.error("interaction expired before we could answer", {
          label,
          latencyMs: Date.now() - interaction.createdTimestamp,
          hint: "Discord drops interactions older than 3s. Look for a second bot process or a paused host, and check clock skew with `bun run doctor`.",
        });
        return;
      }
      logger.error("interaction handler threw", { label, error: message.slice(0, 400) });
      if (!interaction.isRepliable()) return;
      const payload = { content: `⚠️ internal error: ${message.slice(0, 300)}`, flags: ["Ephemeral"] as const };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch (nested) {
        logger.error("could not report interaction error", { label, error: String(nested).slice(0, 200) });
      }
      return;
    }

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      logger.warn("handler returned without replying", { label, guild: interaction.guildId ?? "dm" });
      await interaction
        .reply({ content: "⚠️ handler finished without a reply — check the bot logs", flags: ["Ephemeral"] as const })
        .catch(() => undefined);
    }
  });

  client.once(Events.ClientReady, async () => {
    logger.info("logged in", { user: client.user?.tag, guilds: client.guilds.cache.size });
    await client.initApplicationCommands();
    logger.info("application commands registered");

    // Discord shows global and guild-scoped commands as separate entries, so exactly one scope may hold them.
    // REGISTER_GUILD_ID publishes guild-scoped (instant) and clears the global set; otherwise the reverse.
    const application = client.application;
    if (!application) return;
    const guildId = Bun.env.REGISTER_GUILD_ID;
    try {
      if (guildId) {
        const global = await application.commands.fetch();
        const guild = await client.guilds.fetch(guildId);
        // discord.js types toJSON() as unknown; the payload matches what the REST call expects.
        const payload = [...global.values()].map((command) => command.toJSON() as ApplicationCommandDataResolvable);
        await guild.commands.set(payload);
        await application.commands.set([]);
        logger.info("commands are guild-scoped", { guild: guild.name, count: payload.length, globalsCleared: global.size });
      } else {
        for (const guild of client.guilds.cache.values()) {
          const scoped = await guild.commands.fetch();
          if (scoped.size === 0) continue;
          await guild.commands.set([]);
          logger.info("cleared guild-scoped duplicates", { guild: guild.name, removed: scoped.size });
        }
      }
    } catch (error) {
      logger.warn("command scope reconciliation failed", { error: String(error).slice(0, 300) });
    }
  });

  return client;
}

/**
 * A mention or a reply to the bot is a prompt. Guild allowlisting happens before any model call, and the
 * channel must be a normal text channel so the streaming renderer has somewhere to write.
 */
export function attachMessageHandler(client: Client, runtime: Runtime): void {
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.inGuild()) return;
    const mentioned = message.mentions.users.has(client.user?.id ?? "");
    const replied = message.mentions.repliedUser?.id === client.user?.id;
    if (!mentioned && !replied) return;

    const guildConfig = config.guild(message.guildId);
    if (!guildConfig?.enabled) {
      await message.reply("this server is not enabled yet — the owner can run `/enable`").catch(() => undefined);
      return;
    }
    if (!(message.channel instanceof TextChannel)) return;

    const text = message.content
      .replace(new RegExp(`<@!?${client.user?.id}>`, "g"), "")
      .trim();
    if (text.length === 0) {
      await message.reply("what should I do?").catch(() => undefined);
      return;
    }

    await runtime.ask({
      guildId: message.guildId,
      guildName: message.guild?.name ?? "guild",
      channel: message.channel,
      actorId: message.author.id,
      actorName: message.author.username,
      member: message.member,
      text,
    });
  });
}
