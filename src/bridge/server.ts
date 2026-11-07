import { z } from "zod";
import type { Client, Guild, GuildMember } from "discord.js";
import { capabilities, type ParamSpec } from "./capabilities.ts";
import { capabilityByName } from "./lookup.ts";
import { config } from "../config.ts";
import { audit, sessions, toolStats, workspaces } from "../db.ts";
import { log } from "../log.ts";
import { decide } from "../policy/gate.ts";
import { requestApproval } from "../discord/approvals.ts";

const logger = log("bridge");

export type BridgeServer = ReturnType<typeof Bun.serve>;

const RpcRequest = z.object({
  guild: z.string().min(1),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  sessionID: z.string().min(1),
});

const zodFor = (param: ParamSpec): z.ZodTypeAny => {
  const base =
    param.kind === "number"
      ? z.number()
      : param.kind === "boolean"
        ? z.boolean()
        : param.kind === "string[]"
          ? z.array(z.string())
          : z.string();
  return param.required ? base : base.optional();
};

const schemas: Record<string, z.ZodTypeAny> = Object.fromEntries(
  capabilities.map((capability) => [
    capability.name,
    z.object(Object.fromEntries(capability.params.map((param) => [param.name, zodFor(param)]))).strict(),
  ]),
);

const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

async function memberOf(guild: Guild, actorId: string | null): Promise<GuildMember | null> {
  if (!actorId) return null;
  const cached = guild.members.cache.get(actorId);
  if (cached) return cached;
  try {
    return await guild.members.fetch(actorId);
  } catch {
    return null;
  }
}

/**
 * The bridge is the only path from the agent to Discord. Identity (guild, channel, actor) comes from the
 * bot's own session binding — never from tool arguments — so the model cannot impersonate a rank, and every
 * call is authorised, audited and counted here.
 */
export function startBridge(client: Client): BridgeServer {
  return Bun.serve({
    hostname: config.bridge.host,
    port: config.bridge.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, tools: capabilities.length });
      }
      if (request.method !== "POST" || url.pathname !== "/rpc") return json("not found", 404);

      const workspaceToken = request.headers.get("x-bridge-token");
      if (!workspaceToken) return json("missing bridge token", 401);

      const parsed = RpcRequest.safeParse(await request.json().catch(() => undefined));
      if (!parsed.success) return json(`bad request: ${parsed.error.message}`, 400);
      const { guild: guildId, name, args, sessionID } = parsed.data;

      const workspace = workspaces.get(guildId);
      if (!workspace?.bridge_token || workspace.bridge_token !== workspaceToken) return json("invalid bridge token", 401);

      let capability;
      try {
        capability = capabilityByName(name);
      } catch {
        return json(`unknown capability: ${name}`, 404);
      }

      const session = sessions.byOpenCodeId(sessionID);
      if (!session || session.guild_id !== guildId) return json("session not bound to this guild", 403);

      const guild = client.guilds.cache.get(guildId);
      if (!guild) return json("guild unavailable", 503);

      const validated = schemas[name]?.safeParse(args);
      if (!validated || !validated.success) {
        const detail = validated ? validated.error.message : "no schema";
        audit.write({ guildId, actorId: session.actor_id ?? "unknown", channelId: session.channel_id, tool: name, args, verdict: "invalid", layer: "schema", detail });
        return json(`invalid arguments: ${detail}`, 400);
      }

      const member = await memberOf(guild, session.actor_id);
      const decision = await decide(guildId, member, capability, validated.data);
      audit.write({
        guildId,
        actorId: session.actor_id ?? "unknown",
        channelId: session.channel_id,
        tool: name,
        args: validated.data,
        verdict: decision.verdict,
        layer: decision.layer,
        detail: JSON.stringify({ reason: decision.reason, jev: decision.jev ?? null }).slice(0, 2000),
      });

      if (decision.verdict === "deny") return json(`denied by policy (${decision.layer}): ${decision.reason}`, 403);

      if (decision.verdict === "ask") {
        const actor = member?.user.username ?? session.actor_id ?? "unknown";
        const outcome = await requestApproval({
          client,
          guildId,
          chatKey: session.chat_key,
          channelId: session.channel_id,
          actorId: session.actor_id ?? "unknown",
          kind: "bridge",
          title: `${name} for ${actor}`,
          detail: [`risk: ${capability.risk}`, `reason: ${decision.reason}`, "arguments:", `\`\`\`json\n${JSON.stringify(validated.data, null, 2).slice(0, 1200)}\n\`\`\``].join("\n"),
          sessionId: sessionID,
        });
        audit.write({ guildId, actorId: session.actor_id ?? "unknown", channelId: session.channel_id, tool: name, args: validated.data, verdict: outcome, layer: "human" });
        if (outcome === "denied" || outcome === "expired") return json(`not approved (${outcome})`, 403);
      }

      const started = Date.now();
      try {
        const output = await capability.run(
          { client, guild, actorId: session.actor_id ?? "unknown", channelId: session.channel_id },
          validated.data,
        );
        toolStats.bump(guildId, name, true, Date.now() - started);
        return json(output);
      } catch (error) {
        toolStats.bump(guildId, name, false, Date.now() - started);
        const message = error instanceof Error ? error.message : String(error);
        audit.write({ guildId, actorId: session.actor_id ?? "unknown", channelId: session.channel_id, tool: name, args: validated.data, verdict: "error", layer: "execution", detail: message.slice(0, 400) });
        logger.warn("capability failed", { guildId, name, error: message.slice(0, 200) });
        return json(`error: ${message}`, 400);
      }
    },
  });
}
