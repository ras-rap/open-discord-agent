import {
  ApplicationCommandOptionType,
  EmbedBuilder,
  type ButtonInteraction,
  type CommandInteraction,
  type GuildMember,
  type TextChannel,
} from "discord.js";
import { ButtonComponent, Discord, Slash, SlashOption } from "discordx";
import { config, isOwner } from "../config.ts";
import { approvals, audit, sessions } from "../db.ts";
import { log } from "../log.ts";
import { writeDigest } from "../memory/inject.ts";
import { memory as memoryStore } from "../memory/store.ts";
import { jevMode } from "../policy/jev.ts";
import { tierOf } from "../policy/gate.ts";
import { shellStatus } from "../workspace/shell.ts";
import { resolveApproval } from "./approvals.ts";
import { services } from "./services.ts";

const logger = log("commands");

const guarded = async (interaction: CommandInteraction): Promise<boolean> => {
  if (!interaction.guildId || !interaction.channel || !interaction.channel.isTextBased()) {
    await interaction.reply({ content: "This command only works in a server text channel.", flags: ["Ephemeral"] as const });
    return false;
  }
  return true;
};

@Discord()
export class Commands {
  private async startPrompt(interaction: CommandInteraction, text: string): Promise<void> {
    const { runtime } = services.get();
    const guild = interaction.guild;
    const channel = interaction.channel as TextChannel;
    const member = interaction.member as GuildMember | null;
    if (!guild) return;
    await runtime.ask({
      guildId: guild.id,
      guildName: guild.name,
      channel,
      actorId: interaction.user.id,
      actorName: interaction.user.username,
      member,
      text,
    });
  }

  @Slash({ name: "ask", description: "Ask the agent to do something (code, Discord admin, research)" })
  async ask(
    @SlashOption({
      name: "prompt",
      description: "what you want done",
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    prompt: string,
    interaction: CommandInteraction,
  ): Promise<void> {
    if (!(await guarded(interaction))) return;
    await interaction.deferReply({ flags: ["Ephemeral"] as const });
    await interaction.editReply({ content: "🧠 working — progress shows in the channel" });
    await this.startPrompt(interaction, prompt);
  }

  @Slash({ name: "new", description: "Start a fresh conversation in this channel" })
  async fresh(interaction: CommandInteraction): Promise<void> {
    if (!(await guarded(interaction))) return;
    const { runtime } = services.get();
    const channel = interaction.channel as TextChannel;
    const sessionId = await runtime.reset(
      `${interaction.guildId}:${channel.id}`,
      interaction.guildId ?? "",
      interaction.guild?.name ?? "",
      channel.id,
      interaction.user.id,
    );
    await interaction.reply({ content: `🆕 new session \`${sessionId}\``, flags: ["Ephemeral"] as const });
  }

  @Slash({ name: "abort", description: "Stop the agent in this channel" })
  async abort(interaction: CommandInteraction): Promise<void> {
    if (!(await guarded(interaction))) return;
    const { runtime } = services.get();
    const channel = interaction.channel as TextChannel;
    const stopped = await runtime.abort(`${interaction.guildId}:${channel.id}`);
    await interaction.reply({ content: stopped ? "🛑 abort sent" : "nothing running in this channel", flags: ["Ephemeral"] as const });
  }

  @Slash({ name: "status", description: "Bot, server, sandbox, and policy status" })
  async status(interaction: CommandInteraction): Promise<void> {
    const { supervisor, runtime } = services.get();
    const shell = await shellStatus();
    const servers = supervisor
      .stats()
      .map((entry) => `guild ${entry.guildId} · port ${entry.port} · idle ${entry.idleMinutes}m`)
      .join("\n");
    const recent = interaction.guildId ? audit.recent(interaction.guildId, 3) : [];
    const embed = new EmbedBuilder()
      .setTitle("open-discord-agent")
      .setColor(0x5865f2)
      .addFields(
        { name: "servers", value: servers || "none running", inline: false },
        { name: "sessions", value: `${sessions.count()} bound · ${runtime.activeStreams()} streaming`, inline: true },
        { name: "approvals", value: `${approvals.pendingCount()} pending`, inline: true },
        { name: "sandbox", value: `shell=${shell.mode} · docker=${shell.docker ? "up" : `down: ${shell.detail.slice(0, 80)}`}`, inline: true },
        { name: "policy", value: `jev=${jevMode}`, inline: true },
        {
          name: "recent decisions",
          value: recent.map((row) => `${row.tool} → ${row.verdict}`).join("\n") || "none",
          inline: false,
        },
      )
      .setFooter({ text: "models: crouton-alpha-free · beam-free · jev-1.13-free" });
    await interaction.reply({ embeds: [embed], flags: ["Ephemeral"] as const });
  }

  @Slash({ name: "ping", description: "Check that slash commands reach the bot" })
  async ping(interaction: CommandInteraction): Promise<void> {
    const latency = Date.now() - interaction.createdTimestamp;
    const gateway = interaction.client.ws.ping;
    logger.info("ping", { latency, gateway, guild: interaction.guildId ?? "dm" });
    await interaction.reply({
      content: `🏓 pong · interaction ${latency}ms · gateway ${gateway}ms · pid ${process.pid}`,
      flags: ["Ephemeral"] as const,
    });
  }

  @Slash({ name: "enable", description: "Owner only: enable this server for the agent" })
  async enable(interaction: CommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "Run this inside the server you want to enable — a DM has no guild to configure.",
        flags: ["Ephemeral"] as const,
      });
      return;
    }
    if (!isOwner(interaction.user.id)) {
      await interaction.reply({ content: "Only the bot owner can enable a server.", flags: ["Ephemeral"] as const });
      return;
    }
    config.setGuild(interaction.guildId, { enabled: true, shell: config.shellDefaults, roles: { admin: [], trusted: [] } });
    logger.info("guild enabled", { guildId: interaction.guildId, by: interaction.user.id });
    await interaction.reply({ content: "✅ this server is enabled", flags: ["Ephemeral"] as const });
  }

  @Slash({ name: "audit", description: "Last tool decisions in this server" })
  async auditLog(interaction: CommandInteraction): Promise<void> {
    if (!(await guarded(interaction))) return;
    const rows = audit.recent(interaction.guildId ?? "", 10);
    const text = rows
      .map((row) => `${new Date(row.ts).toISOString().slice(11, 19)} ${row.tool} ${row.verdict} (${row.layer}) by ${row.actor_id}`)
      .join("\n");
    await interaction.reply({ content: `\`\`\`\n${text || "no decisions recorded"}\n\`\`\``, flags: ["Ephemeral"] as const });
  }

  @Slash({ name: "remember", description: "Store a durable fact about this server" })
  async remember(
    @SlashOption({ name: "text", description: "fact to remember", required: true, type: ApplicationCommandOptionType.String })
    text: string,
    interaction: CommandInteraction,
  ): Promise<void> {
    if (!(await guarded(interaction))) return;
    const guildId = interaction.guildId ?? "";
    const id = memoryStore.add({
      guildId,
      kind: "fact",
      key: text.slice(0, 80),
      text,
      importance: 0.95,
      confidence: 1,
      source: `user:${interaction.user.id}`,
    });
    writeDigest(guildId);
    await interaction.reply({ content: `🧠 remembered as #${id}`, flags: ["Ephemeral"] as const });
  }

  @Slash({ name: "memory", description: "Search, inspect, or forget this server's memory" })
  async memoryCommand(
    @SlashOption({ name: "query", description: "search text", required: false, type: ApplicationCommandOptionType.String })
    query: string | undefined,
    @SlashOption({ name: "forget", description: "memory id to delete", required: false, type: ApplicationCommandOptionType.Integer })
    forget: number | undefined,
    interaction: CommandInteraction,
  ): Promise<void> {
    if (!(await guarded(interaction))) return;
    const guildId = interaction.guildId ?? "";
    if (forget !== undefined) {
      const removed = memoryStore.forget(guildId, forget);
      writeDigest(guildId);
      await interaction.reply({ content: removed ? `🗑️ forgot #${forget}` : `no memory #${forget} in this server`, flags: ["Ephemeral"] as const });
      return;
    }
    if (query) {
      const hits = memoryStore.search(guildId, query, 8);
      const text = hits.map((hit) => `#${hit.id} (${hit.kind}, ${hit.score.toFixed(2)}) ${hit.text}`).join("\n");
      await interaction.reply({ content: `\`\`\`\n${text || "nothing remembered matches that"}\n\`\`\``, flags: ["Ephemeral"] as const });
      return;
    }
    const stats = memoryStore.stats(guildId);
    await interaction.reply({
      content: `🧠 ${stats.total} memories (${Object.entries(stats.byKind).map(([kind, n]) => `${kind}:${n}`).join(", ") || "none"}), ${stats.superseded} superseded`,
      flags: ["Ephemeral"] as const,
    });
  }

  @ButtonComponent({ id: /^oda:ap:/ })
  async onApprovalButton(interaction: ButtonInteraction): Promise<void> {
    const [, , approvalId, decision] = interaction.customId.split(":");
    if (!approvalId || (decision !== "allow" && decision !== "always" && decision !== "deny")) {
      await interaction.reply({ content: "malformed approval button", flags: ["Ephemeral"] as const });
      return;
    }
    const member = interaction.member as GuildMember | null;
    const guildId = interaction.guildId ?? "";
    if (tierOf(guildId, member) < 3) {
      await interaction.reply({ content: "only admins (or the owner) can approve actions", flags: ["Ephemeral"] as const });
      return;
    }
    const ok = resolveApproval(approvalId, decision, interaction.user.id);
    await interaction.update({
      content: ok ? `✅ ${decision} by <@${interaction.user.id}>` : "this request already expired or was decided",
      components: [],
    });
  }
}
