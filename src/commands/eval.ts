import { guildEnabled, guildOnly, managerOnly } from '@guards/index.ts';
import { services } from '@services/discord/services.ts';
import { evaluateCurrent } from '@services/evolution/compare.ts';
import { summarise } from '@services/evolution/evals.ts';
import { loadFixtures } from '@services/evolution/fixtures.ts';
import { EPHEMERAL } from '@utils/constants.ts';
import { Discord, Guard, Slash } from 'discordx';

import type { ChatInputCommandInteraction } from 'discord.js';

@Discord()
export class EvalCommand {
  /** Replays `config/fixtures` against the current skill state: the "are we actually good" button. */
  @Slash({ 'name': 'eval', 'description': 'Replay the eval fixtures against the current agent' })
  @Guard(guildOnly, guildEnabled, managerOnly)
  async evaluate(interaction: ChatInputCommandInteraction) {
    const fixtures = loadFixtures();
    if (fixtures.length === 0) {
      await interaction.reply({ 'content': 'no fixtures in config/fixtures yet', 'flags': EPHEMERAL });
      return;
    }
    await interaction.deferReply({ 'flags': EPHEMERAL });
    const { supervisor } = services.get();
    const suite = await evaluateCurrent(
      supervisor,
      interaction.guildId ?? '',
      interaction.guild?.name ?? 'guild',
      fixtures,
    );
    const body = suite ? summarise(suite) : 'eval skipped';
    await interaction.editReply({ 'content': ['```', body, '```'].join('\n').slice(0, 1900) });
  }
}
