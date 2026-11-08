import { guildEnabled, guildOnly, managerOnly } from '@guards/index.ts';
import { effectiveModel, modelAllowlist, modelRef } from '@services/agent/models.ts';
import { providerSummary } from '@services/agent/providers.ts';
import { config } from '@services/config.ts';
import { services } from '@services/discord/services.ts';
import { BRAND_COLOR, EPHEMERAL } from '@utils/constants.ts';
import { log } from '@utils/logger.ts';
import { ApplicationCommandOptionType, EmbedBuilder } from 'discord.js';
import { Discord, Guard, Slash, SlashChoice, SlashGroup, SlashOption } from 'discordx';

import type { AutocompleteInteraction, ChatInputCommandInteraction, TextChannel } from 'discord.js';

const logger = log('commands/model');

const ROLES = ['primary', 'fast'] as const;
type Role = (typeof ROLES)[number];

/**
 * Suggestions read a warm server only: an autocomplete has to answer inside Discord's 3s window and a cold
 * `opencode serve` start would miss it. The deployment roles are always offered so the list is never empty.
 */
async function suggestModels(interaction: AutocompleteInteraction): Promise<void> {
  const guildId = interaction.guildId ?? '';
  const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
  const { runtime } = services.get();

  const catalog = await runtime
    .catalog(guildId, interaction.guild?.name ?? 'guild', { 'spawn': false })
    .catch(() => []);
  const choices = catalog.flatMap(provider => provider.models.map(model => `${provider.id}/${model}`));
  for (const role of ROLES) {
    const id = effectiveModel(role).id;
    if (!choices.includes(id)) choices.unshift(id);
  }

  const matches = choices.filter(choice => choice.toLowerCase().includes(typed)).slice(0, 25);
  await interaction.respond(matches.map(choice => ({ 'name': choice.slice(0, 100), 'value': choice })));
}

/**
 * A guild's server reads `opencode.json` (which names the default model and the provider blocks) at start-up,
 * so switching a model stops the running server; the next prompt re-provisions and respawns it.
 */
async function stopGuildServer(guildId: string, interaction: ChatInputCommandInteraction): Promise<void> {
  const { supervisor, runtime } = services.get();
  runtime.forgetCatalog(guildId);
  try {
    await supervisor.stop(guildId);
  } catch (error) {
    logger.warn('server stop after model switch failed', { guildId, 'error': String(error).slice(0, 160) });
    await (interaction.channel as TextChannel | null)?.send(
      '⚠️ the agent server did not stop cleanly; it restarts on the next prompt anyway.',
    );
  }
}

/**
 * `/model` is the answer to "which model is this server on, and what else could it be": the catalogue comes
 * from the guild's own opencode server, so the menu can never name a model the server would refuse.
 */
@Discord()
@SlashGroup({ 'name': 'model', 'description': 'Inspect or switch the model this server runs on' })
export class ModelCommand {
  @Slash({ 'name': 'current', 'description': 'Which models this server uses' })
  @SlashGroup('model')
  @Guard(guildOnly, guildEnabled)
  async current(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId ?? '';
    const primary = effectiveModel('primary', guildId);
    const fast = effectiveModel('fast', guildId);
    const allowlist = modelAllowlist();
    const providers = providerSummary();
    const ready = providers.filter(provider => provider.ready);

    const embed = new EmbedBuilder()
      .setTitle('model')
      .setColor(BRAND_COLOR)
      .addFields(
        {
          'name': 'primary (chat, code, tool use)',
          'value': `\`${primary.id}\` · ${primary.source === 'guild' ? 'set by `/model set`' : 'deployment default'}`,
          'inline': false,
        },
        {
          'name': 'fast (reflection, memory)',
          'value': `\`${fast.id}\` · ${fast.source === 'guild' ? 'set by `/model set`' : 'deployment default'}`,
          'inline': false,
        },
        {
          'name': 'providers ready',
          'value': ready.map(provider => `\`${provider.id}\``).join(', ') || 'none — see `bun run doctor`',
          'inline': false,
        },
      )
      .setFooter({
        'text':
          allowlist.length > 0
            ? `MODEL_ALLOWLIST pins ${allowlist.length} model(s)`
            : '/model list shows what else is available',
      });

    await interaction.reply({ 'embeds': [embed], 'flags': EPHEMERAL });
  }

  @Slash({ 'name': 'list', 'description': 'Models the agent server can run here' })
  @SlashGroup('model')
  @Guard(guildOnly, guildEnabled)
  async list(
    @SlashOption({
      'name': 'filter',
      'description': 'only show models matching this text',
      'required': false,
      'type': ApplicationCommandOptionType.String,
    })
    filter: string | undefined,
    interaction: ChatInputCommandInteraction,
  ) {
    const { runtime } = services.get();
    const guildId = interaction.guildId ?? '';
    await interaction.deferReply({ 'flags': EPHEMERAL });

    // Listing does start the server when it is cold: that is the only way to know what this deployment can
    // actually run, and `/ask` would have started it a moment later anyway.
    const catalog = await runtime.catalog(guildId, interaction.guild?.name ?? 'guild');
    const needle = filter?.toLowerCase();
    const lines: string[] = [];
    for (const provider of catalog) {
      const matches = provider.models.filter(model => !needle || model.toLowerCase().includes(needle));
      if (matches.length === 0) continue;
      lines.push(`**${provider.name}** (\`${provider.id}\`)`);
      lines.push(
        matches
          .slice(0, 40)
          .map(model => `\`${provider.id}/${model}\``)
          .join(' '),
      );
      if (matches.length > 40) lines.push(`… and ${matches.length - 40} more`);
    }

    const current = {
      'primary': effectiveModel('primary', guildId).id,
      'fast': effectiveModel('fast', guildId).id,
    };
    const body = lines.join('\n') || 'no models reported by the server — run `bun run doctor`';
    const text =
      `in use: primary \`${current.primary}\` · fast \`${current.fast}\`\n${body}` +
      (catalog.length === 0 ? '' : '\n\nswitch with `/model set model:<provider/model>`');

    // The catalogue of a subscription can exceed Discord's message limit; the head of the list is what people
    // actually need, and `filter` narrows the rest.
    await interaction.editReply({ 'content': text.slice(0, 1950) });
  }

  @Slash({ 'name': 'set', 'description': 'Switch this server to another model (admin)' })
  @SlashGroup('model')
  @Guard(guildOnly, guildEnabled, managerOnly)
  async set(
    @SlashOption({
      'name': 'model',
      'description': 'provider/model, e.g. opencode-go/gpt-5.6-luna',
      'required': true,
      'type': ApplicationCommandOptionType.String,
      'autocomplete': (interaction: AutocompleteInteraction) => suggestModels(interaction),
    })
    model: string,
    @SlashChoice({ 'name': 'primary — chat, code, tool use', 'value': 'primary' })
    @SlashChoice({ 'name': 'fast — reflection and memory', 'value': 'fast' })
    @SlashOption({
      'name': 'role',
      'description': 'which role to change (default: primary)',
      'required': false,
      'type': ApplicationCommandOptionType.String,
    })
    role: Role | undefined,
    interaction: ChatInputCommandInteraction,
  ) {
    const guildId = interaction.guildId ?? '';
    const target = role ?? 'primary';

    try {
      modelRef(model);
    } catch (error) {
      await interaction.reply({
        'content': `⚠️ ${String(error instanceof Error ? error.message : error)}`,
        'flags': EPHEMERAL,
      });
      return;
    }

    const before = config.guild(guildId)?.model ?? {};
    config.patchGuild(guildId, { 'model': { ...before, [target]: model.trim() } });
    await stopGuildServer(guildId, interaction);
    logger.info('model switched', { guildId, 'by': interaction.user.id, target, model });

    const resolved = effectiveModel(target, guildId);
    await interaction.reply({
      'content':
        `✅ ${target} → \`${resolved.id}\`\n` +
        "the guild's agent server restarts on the next prompt so the new default is loaded; the session and its memory are kept.",
      'flags': EPHEMERAL,
    });
  }

  @Slash({ 'name': 'reset', 'description': "Drop this server's model override (admin)" })
  @SlashGroup('model')
  @Guard(guildOnly, guildEnabled, managerOnly)
  async reset(
    @SlashChoice({ 'name': 'both', 'value': 'both' })
    @SlashChoice({ 'name': 'primary', 'value': 'primary' })
    @SlashChoice({ 'name': 'fast', 'value': 'fast' })
    @SlashOption({
      'name': 'role',
      'description': 'which role to reset (default: both)',
      'required': false,
      'type': ApplicationCommandOptionType.String,
    })
    role: Role | 'both' | undefined,
    interaction: ChatInputCommandInteraction,
  ) {
    const guildId = interaction.guildId ?? '';
    const target = role ?? 'both';
    const kept = { ...(config.guild(guildId)?.model ?? {}) };
    if (target === 'both') {
      delete kept.primary;
      delete kept.fast;
    } else delete kept[target];

    config.patchGuild(guildId, { 'model': kept });
    await stopGuildServer(guildId, interaction);
    logger.info('model override reset', { guildId, 'by': interaction.user.id, target });

    const primary = effectiveModel('primary', guildId);
    const fast = effectiveModel('fast', guildId);
    await interaction.reply({
      'content': `♻️ back to the deployment defaults — primary \`${primary.id}\` · fast \`${fast.id}\``,
      'flags': EPHEMERAL,
    });
  }
}
