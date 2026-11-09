import { guildEnabled, guildOnly, managerOnly } from '@guards/index.ts';
import { effectiveModel } from '@services/agent/models.ts';
import { RANK_NAMES, config, guildDefaults, isOwner, type GuildPolicy, type GuildSettings } from '@services/config.ts';
import { ceilingFor, tierOf } from '@services/policy/gate.ts';
import { jevMode } from '@services/policy/jev.ts';
import {
  SETTINGS,
  defaultFor,
  describeSetting,
  parseSetting,
  setSetting,
  type Setting,
} from '@services/policy/settings.ts';
import { BRAND_COLOR, EPHEMERAL } from '@utils/constants.ts';
import { log } from '@utils/logger.ts';
import { ApplicationCommandOptionType, EmbedBuilder } from 'discord.js';
import { Discord, Guard, Slash, SlashGroup, SlashOption } from 'discordx';

import type { AutocompleteInteraction, ChatInputCommandInteraction, GuildMember } from 'discord.js';

const logger = log('commands/config');

/** `/config` writes into `config/guilds.json`; anything a guild admin may widen is owner-scoped in the registry. */
const writableBy = (setting: Setting, userId: string): boolean => setting.scope === 'admin' || isOwner(userId);

const policySummary = (policy: GuildPolicy): string => {
  const mode =
    policy.mode === 'vibe'
      ? `vibe — runs unattended, Jev ${policy.vibe.screen} vetoes catastrophic calls (max risk: ${policy.vibe.maxRisk}${policy.vibe.askOnUncertain ? ', asks when unsure' : ''})`
      : policy.mode === 'locked'
        ? 'locked — nothing above read runs, whatever the rank'
        : 'ask — anything the ceiling does not allow outright becomes an approval card';
  return [
    `mode: **${policy.mode}** — ${mode.slice(mode.indexOf('—') + 1).trim()}`,
    `tools denied: ${policy.tools.deny.length > 0 ? policy.tools.deny.join(', ') : 'none'}`,
    `tools allowed: ${policy.tools.allow.length > 0 ? policy.tools.allow.join(', ') : 'none'}`,
  ].join('\n');
};

const matrixTable = (policy: GuildPolicy): string => {
  const rows = RANK_NAMES.slice(1).map(rank => {
    const tier = RANK_NAMES.indexOf(rank) as 1 | 2 | 3 | 4;
    const cells = (['read', 'reversible', 'destructive', 'admin'] as const).map(risk => {
      const value = ceilingFor(policy, tier, risk);
      return `${risk.slice(0, 4)}:${value.verdict}${value.source === 'matrix' ? '*' : ''}`;
    });
    return `${rank.padEnd(8)} ${cells.join(' · ')}`;
  });
  rows.push('* = this guild overrides the built-in table');
  return rows.join('\n');
};

async function suggestKeys(interaction: AutocompleteInteraction): Promise<void> {
  const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
  const userId = interaction.user.id;
  const choices = SETTINGS.filter(setting => writableBy(setting, userId))
    .map(setting => setting.path)
    .filter(path => path.toLowerCase().includes(typed))
    .slice(0, 25)
    .map(path => ({ 'name': path.slice(0, 100), 'value': path }));
  await interaction.respond(choices);
}

@Discord()
@SlashGroup({ 'name': 'config', 'description': 'Permissions, sandbox and policy for this server' })
export class ConfigCommand {
  @Slash({ 'name': 'show', 'description': 'The permissions and policy in force here' })
  @SlashGroup('config')
  @Guard(guildOnly, guildEnabled)
  async show(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId ?? '';
    const policy = config.policy(guildId);
    const shell = config.guild(guildId)?.shell;
    const editable = SETTINGS.filter(setting => writableBy(setting, interaction.user.id));
    // discordx hands over the cached member payload; tierOf reads only id, roles and guild.ownerId.
    const member = (interaction.member ?? null) as GuildMember | null;

    const embed = new EmbedBuilder()
      .setTitle('config')
      .setColor(BRAND_COLOR)
      .addFields(
        { 'name': 'policy', 'value': policySummary(policy), 'inline': false },
        { 'name': 'rank ceilings', 'value': `\`\`\`\n${matrixTable(policy)}\n\`\`\``, 'inline': false },
        {
          'name': 'sandbox',
          'value':
            `shell mode **${shell?.mode ?? 'docker'}** · image \`${shell?.image ?? '-'}\` · fallback ${shell?.fallback ?? 'error'}` +
            (shell?.mode === 'host' ? '\n⚠️ host mode runs shell calls as the bot user, no container' : ''),
          'inline': false,
        },
        {
          'name': 'model',
          'value': `primary \`${effectiveModel('primary', guildId).id}\` · fast \`${effectiveModel('fast', guildId).id}\``,
          'inline': false,
        },
        {
          'name': 'who can change what',
          'value':
            `you are rank **${RANK_NAMES[tierOf(guildId, member)]}** and can set ` +
            `${editable.length} of ${SETTINGS.length} keys` +
            (isOwner(interaction.user.id)
              ? ' (bot owner: all scopes)'
              : ' — sandbox, role lists and the permission matrix are bot-owner only'),
          'inline': false,
        },
        { 'name': 'jev', 'value': `deployment mode \`${jevMode}\``, 'inline': false },
      )
      .setFooter({ 'text': '/config set key value · /config reset key · /vibe on|off' });

    await interaction.reply({ 'embeds': [embed], 'flags': EPHEMERAL });
  }

  @Slash({ 'name': 'set', 'description': 'Change one setting here (scope-checked)' })
  @SlashGroup('config')
  @Guard(guildOnly, guildEnabled, managerOnly)
  async set(
    @SlashOption({
      'name': 'key',
      'description': 'which setting, e.g. policy.mode',
      'required': true,
      'type': ApplicationCommandOptionType.String,
      'autocomplete': (interaction: AutocompleteInteraction) => suggestKeys(interaction),
    })
    key: string,
    @SlashOption({
      'name': 'value',
      'description': 'new value, e.g. vibe — lists are comma separated',
      'required': true,
      'type': ApplicationCommandOptionType.String,
    })
    value: string,
    interaction: ChatInputCommandInteraction,
  ) {
    const guildId = interaction.guildId ?? '';
    const setting = SETTINGS.find(entry => entry.path === key.trim());
    if (!setting) {
      await interaction.reply({
        'content': `unknown setting \`${key}\` — run \`/config show\` or start typing for the list`,
        'flags': EPHEMERAL,
      });
      return;
    }
    if (!writableBy(setting, interaction.user.id)) {
      await interaction.reply({
        'content': `🔒 \`${setting.path}\` is bot-owner only (${setting.description}).`,
        'flags': EPHEMERAL,
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = parseSetting(setting.path, value);
    } catch (error) {
      await interaction.reply({
        'content': `⚠️ ${error instanceof Error ? error.message : String(error)}`,
        'flags': EPHEMERAL,
      });
      return;
    }

    const current: GuildSettings = config.guild(guildId) ?? guildDefaults();
    const next = setSetting(current, setting.path, parsed);
    config.patchGuild(guildId, { ...next });
    logger.info('config changed', { guildId, 'by': interaction.user.id, 'key': setting.path, 'value': parsed });

    const policy = config.policy(guildId);
    await interaction.reply({
      'content':
        `✅ \`${setting.path}\` → \`${describeSetting(next, setting.path)}\`` +
        (policy.mode === 'vibe' ? '\n⚠️ vibe mode is on: tool calls run without an approval card.' : ''),
      'flags': EPHEMERAL,
    });
  }

  @Slash({ 'name': 'reset', 'description': 'Restore one setting to its default' })
  @SlashGroup('config')
  @Guard(guildOnly, guildEnabled, managerOnly)
  async reset(
    @SlashOption({
      'name': 'key',
      'description': 'which setting to reset',
      'required': true,
      'type': ApplicationCommandOptionType.String,
      'autocomplete': (interaction: AutocompleteInteraction) => suggestKeys(interaction),
    })
    key: string,
    interaction: ChatInputCommandInteraction,
  ) {
    const guildId = interaction.guildId ?? '';
    const setting = SETTINGS.find(entry => entry.path === key.trim());
    if (!setting || !writableBy(setting, interaction.user.id)) {
      await interaction.reply({
        'content': setting ? `🔒 \`${setting.path}\` is bot-owner only.` : `unknown setting \`${key}\``,
        'flags': EPHEMERAL,
      });
      return;
    }

    const current: GuildSettings = config.guild(guildId) ?? guildDefaults();
    const next = setSetting(current, setting.path, defaultFor(setting.path));
    config.patchGuild(guildId, { ...next });
    logger.info('config reset', { guildId, 'by': interaction.user.id, 'key': setting.path });
    await interaction.reply({
      'content': `♻️ \`${setting.path}\` back to default — now \`${describeSetting(next, setting.path)}\``,
      'flags': EPHEMERAL,
    });
  }
}
