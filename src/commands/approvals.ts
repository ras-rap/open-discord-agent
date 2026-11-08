import { resolveApproval } from '@services/discord/approvals.ts';
import { tierOf } from '@services/policy/gate.ts';
import { EPHEMERAL } from '@utils/constants.ts';
import { log } from '@utils/logger.ts';
import { ButtonComponent, Discord } from 'discordx';

import type { ButtonInteraction, GuildMember } from 'discord.js';

const logger = log('commands/approvals');

const DECISIONS = ['allow', 'always', 'deny'] as const;
type Decision = (typeof DECISIONS)[number];

const isDecision = (value: string): value is Decision => (DECISIONS as readonly string[]).includes(value);

@Discord()
export class ApprovalButton {
  @ButtonComponent({ 'id': /^oda:ap:/ })
  async handle(interaction: ButtonInteraction) {
    const [, , approvalId, decision] = interaction.customId.split(':');
    if (!approvalId || !decision || !isDecision(decision)) {
      await interaction.reply({ 'content': 'malformed approval button', 'flags': EPHEMERAL });
      return;
    }
    const member = interaction.member as GuildMember | null;
    if (tierOf(interaction.guildId ?? '', member) < 3) {
      await interaction.reply({
        'content': 'only admins (or the owner) can approve actions',
        'flags': EPHEMERAL,
      });
      return;
    }
    const resolved = resolveApproval(approvalId, decision, interaction.user.id);
    logger.info('approval decided', { approvalId, decision, 'by': interaction.user.id, resolved });
    // The card is scratch space: acknowledge the click, then remove it so a finished turn leaves no dead
    // buttons behind. What was decided stays queryable through `/audit`.
    await interaction.deferReply({ 'flags': EPHEMERAL });
    await interaction.message.delete().catch(() => undefined);
    await interaction.editReply({
      'content': resolved
        ? `✅ ${decision} by <@${interaction.user.id}> — card removed, recorded in \`/audit\``
        : 'this request already expired or was decided — card removed',
    });
  }
}
