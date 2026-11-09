import { guildEnabled, guildOnly, managerOnly } from '@guards/index.ts';
import { config } from '@services/config.ts';
import { BRAND_COLOR, EPHEMERAL } from '@utils/constants.ts';
import { log } from '@utils/logger.ts';
import { ApplicationCommandOptionType, EmbedBuilder } from 'discord.js';
import { Discord, Guard, Slash, SlashChoice, SlashOption } from 'discordx';

import type { ChatInputCommandInteraction } from 'discord.js';

const logger = log('commands/vibe');

/**
 * One-word switch for the mode that decides the whole feel of the bot: with it on, tool calls are not put to a
 * human — Jev screens them and only a destructive reading stops one. `/config set policy.mode` reaches the same
 * setting; this exists because "turn vibe on" is the thing people actually want to type.
 */
@Discord()
export class VibeCommand {
  @Slash({
    'name': 'vibe',
    'description': 'Run tool calls without approval cards — Jev still vetoes destructive ones (admin)',
  })
  @Guard(guildOnly, guildEnabled, managerOnly)
  async vibe(
    @SlashChoice({ 'name': 'on — unattended, Jev vetoes', 'value': 'on' })
    @SlashChoice({ 'name': 'off — approval cards are back', 'value': 'off' })
    @SlashOption({
      'name': 'state',
      'description': 'turn vibe mode on or off',
      'required': true,
      'type': ApplicationCommandOptionType.String,
    })
    state: 'on' | 'off',
    interaction: ChatInputCommandInteraction,
  ) {
    const guildId = interaction.guildId ?? '';
    const current = config.policy(guildId);
    const mode = state === 'on' ? 'vibe' : 'ask';
    config.patchGuild(guildId, { 'policy': { ...current, mode } });
    logger.info('vibe toggled', { guildId, 'by': interaction.user.id, mode });

    const embed = new EmbedBuilder()
      .setColor(mode === 'vibe' ? 0xf0b132 : BRAND_COLOR)
      .setTitle(mode === 'vibe' ? '😎 vibe mode on' : '🙂 vibe mode off')
      .setDescription(
        mode === 'vibe'
          ? [
              'Tool calls run without asking. Before each non-read call, Jev reads it and only a destructive',
              'reading stops it — so `channel_delete`, `member_ban` and friends still need to look harmless.',
              '',
              `· riskiest class run unattended: **${current.vibe.maxRisk}**`,
              `· Jev screening: **${current.vibe.screen}**`,
              `· when Jev is unsure or unreachable: ${current.vibe.askOnUncertain ? 'ask a human' : 'run it'}`,
              '',
              'Change any of that with `/config set policy.vibe.*`.',
            ].join('\n')
          : 'Approval cards are back: anything the rank ceiling does not allow outright asks a human first.',
      )
      .setFooter({ 'text': `/config show · ${interaction.user.username} turned it ${state}` });

    await interaction.reply({ 'embeds': [embed], 'flags': EPHEMERAL });
  }
}
