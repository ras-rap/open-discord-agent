import { guildEnabled, guildOnly, ownerOnly } from '@guards/index.ts';
import { config } from '@services/config.ts';
import { audit, approvals, sessions } from '@services/database/sqlite.ts';
import { services } from '@services/discord/services.ts';
import { shellStatus } from '@services/workspace/shell.ts';
import { BRAND_COLOR, EPHEMERAL } from '@utils/constants.ts';
import { log } from '@utils/logger.ts';
import { ApplicationCommandOptionType, EmbedBuilder } from 'discord.js';
import { Discord, Guard, Slash, SlashOption } from 'discordx';

import type { ChatInputCommandInteraction } from 'discord.js';

const logger = log('commands/admin');

@Discord()
export class AdminCommand {
  @Slash({ 'description': 'Bot, server, sandbox, and policy status', 'name': 'status' })
  @Guard(guildOnly)
  async status(interaction: ChatInputCommandInteraction) {
    const { supervisor, runtime } = services.get();
    const shell = await shellStatus();
    const servers = supervisor
      .stats()
      .map(entry => `guild ${entry.guildId} · port ${entry.port} · idle ${entry.idleMinutes}m`)
      .join('\n');
    const recent = interaction.guildId ? audit.recent(interaction.guildId, 3) : [];
    const embed = new EmbedBuilder()
      .setTitle('open-discord-agent')
      .setColor(BRAND_COLOR)
      .addFields(
        { 'name': 'servers', 'value': servers || 'none running', 'inline': false },
        {
          'name': 'sessions',
          'value': `${sessions.count()} bound · ${runtime.activeStreams()} streaming`,
          'inline': true,
        },
        { 'name': 'approvals', 'value': `${approvals.pendingCount()} pending`, 'inline': true },
        {
          'name': 'sandbox',
          'value': `shell=${shell.mode} · docker=${shell.docker ? 'up' : `down: ${shell.detail.slice(0, 80)}`}`,
          'inline': true,
        },
        { 'name': 'policy', 'value': `jev=${config.jevMode}`, 'inline': true },
        {
          'name': 'gateway',
          'value': `${Math.round(interaction.client.ws.ping)}ms · pid ${process.pid}`,
          'inline': true,
        },
        {
          'name': 'recent decisions',
          'value': recent.map(row => `${row.tool} → ${row.verdict}`).join('\n') || 'none',
          'inline': false,
        },
      )
      .setFooter({ 'text': 'models: crouton-alpha-free · beam-free · jev-1.13-free' });
    await interaction.reply({ 'embeds': [embed], 'flags': EPHEMERAL });
  }

  @Slash({ 'description': 'Owner only: enable this server for the agent', 'name': 'enable' })
  @Guard(guildOnly, ownerOnly)
  async enable(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) return;
    config.setGuild(interaction.guildId, {
      'enabled': true,
      'shell': config.shellDefaults,
      'roles': { 'admin': [], 'trusted': [] },
    });
    logger.info('guild enabled', { 'guildId': interaction.guildId, 'by': interaction.user.id });
    await interaction.reply({ 'content': '✅ this server is enabled', 'flags': EPHEMERAL });
  }

  @Slash({ 'description': 'Last tool decisions in this server', 'name': 'audit' })
  @Guard(guildOnly, guildEnabled)
  async auditLog(interaction: ChatInputCommandInteraction) {
    const rows = audit.recent(interaction.guildId ?? '', 10);
    const text = rows
      .map(
        row =>
          `${new Date(row.ts).toISOString().slice(11, 19)} ${row.tool} ${row.verdict} (${row.layer}) by ${row.actor_id}`,
      )
      .join('\n');
    await interaction.reply({ 'content': `\`\`\`\n${text || 'no decisions recorded'}\n\`\`\``, 'flags': EPHEMERAL });
  }

  @Slash({ 'description': 'Store a durable fact about this server', 'name': 'remember' })
  @Guard(guildOnly, guildEnabled)
  async remember(
    @SlashOption({
      'description': 'fact to remember',
      'name': 'text',
      'required': true,
      'type': ApplicationCommandOptionType.String,
    })
    text: string,
    interaction: ChatInputCommandInteraction,
  ) {
    const { memoryStore, writeDigest } = services.get();
    const guildId = interaction.guildId ?? '';
    const id = memoryStore.add({
      guildId,
      'kind': 'fact',
      'key': text.slice(0, 80),
      text,
      'importance': 0.95,
      'confidence': 1,
      'source': `user:${interaction.user.id}`,
    });
    writeDigest(guildId);
    await interaction.reply({ 'content': `🧠 remembered as #${id}`, 'flags': EPHEMERAL });
  }

  @Slash({ 'description': "Search, inspect, or forget this server's memory", 'name': 'memory' })
  @Guard(guildOnly, guildEnabled)
  async memoryCommand(
    @SlashOption({
      'description': 'search text',
      'name': 'query',
      'required': false,
      'type': ApplicationCommandOptionType.String,
    })
    query: string | undefined,
    @SlashOption({
      'description': 'memory id to delete',
      'name': 'forget',
      'required': false,
      'type': ApplicationCommandOptionType.Integer,
    })
    forget: number | undefined,
    interaction: ChatInputCommandInteraction,
  ) {
    const { memoryStore, writeDigest } = services.get();
    const guildId = interaction.guildId ?? '';
    if (forget !== undefined) {
      const removed = memoryStore.forget(guildId, forget);
      writeDigest(guildId);
      await interaction.reply({
        'content': removed ? `🗑️ forgot #${forget}` : `no memory #${forget} in this server`,
        'flags': EPHEMERAL,
      });
      return;
    }
    if (query) {
      const hits = memoryStore.search(guildId, query, 8);
      const text = hits.map(hit => `#${hit.id} (${hit.kind}, ${hit.score.toFixed(2)}) ${hit.text}`).join('\n');
      await interaction.reply({
        'content': `\`\`\`\n${text || 'nothing remembered matches that'}\n\`\`\``,
        'flags': EPHEMERAL,
      });
      return;
    }
    const stats = memoryStore.stats(guildId);
    const kinds = Object.entries(stats.byKind)
      .map(([kind, count]) => `${kind}:${count}`)
      .join(', ');
    await interaction.reply({
      'content': `🧠 ${stats.total} memories (${kinds || 'none'}), ${stats.superseded} superseded`,
      'flags': EPHEMERAL,
    });
  }
}
