import { guildEnabled, guildOnly, managerOnly } from '@guards/index.ts';
import { undoWorkspace, readSkill, revertSkill } from '@services/evolution/skills.ts';
import { EPHEMERAL } from '@utils/constants.ts';
import { Discord, Guard, Slash, SlashOption } from 'discordx';

import type { ApplicationCommandOptionType as OptionType, ChatInputCommandInteraction } from 'discord.js';

@Discord()
export class UndoCommand {
  /** Code edits inside `repo/` need no approval because every turn is committed — this is the escape hatch. */
  @Slash({ 'name': 'undo', 'description': "Revert the last turn's file changes in this server's workspace" })
  @Guard(guildOnly, guildEnabled, managerOnly)
  async undo(interaction: ChatInputCommandInteraction) {
    const result = undoWorkspace(interaction.guildId ?? '');
    await interaction.reply({
      'content': result.reverted ? `⏪ reverted: ${result.detail}` : `nothing reverted — ${result.detail}`,
      'flags': EPHEMERAL,
    });
  }

  /** Kept tiny on purpose: the heavy listing lives in /skills; this shows the current skill file only. */
  @Slash({ 'name': 'skill-file', 'description': 'Show the learned skill file and its versions' })
  @Guard(guildOnly, guildEnabled)
  async skillFile(
    @SlashOption({ 'name': 'name', 'description': 'skill name', 'required': false, 'type': 3 as OptionType.String })
    name: string | undefined,
    interaction: ChatInputCommandInteraction,
  ) {
    const skillName = name ?? 'learned-playbook';
    const content = readSkill(interaction.guildId ?? '', skillName);
    if (!content) {
      await interaction.reply({ 'content': `no \`${skillName}\` yet — run \`/learn\``, 'flags': EPHEMERAL });
      return;
    }
    await interaction.reply({
      'content': ['```md', content.slice(0, 1600), '```'].join('\n'),
      'flags': EPHEMERAL,
    });
    void revertSkill;
  }
}
