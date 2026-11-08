import { guildEnabled, guildOnly, managerOnly } from '@guards/index.ts';
import { artifacts, feedback } from '@services/database/sqlite.ts';
import { requestApproval } from '@services/discord/approvals.ts';
import { services } from '@services/discord/services.ts';
import { gateCandidate } from '@services/evolution/compare.ts';
import { loadFixtures } from '@services/evolution/fixtures.ts';
import { buildSkillProposal, renderProposal } from '@services/evolution/proposals.ts';
import { readSkill, revertSkill } from '@services/evolution/skills.ts';
import { BRAND_COLOR, EPHEMERAL } from '@utils/constants.ts';
import { log } from '@utils/logger.ts';
import { EmbedBuilder } from 'discord.js';
import { Discord, Guard, Slash, SlashOption } from 'discordx';

import type { ApplicationCommandOptionType as OptionType, ChatInputCommandInteraction } from 'discord.js';

const logger = log('commands/learn');

@Discord()
export class LearnCommand {
  /** Compiles stored lessons into a SKILL.md candidate and asks an admin to approve the write. */
  @Slash({ 'name': 'learn', 'description': "Turn this server's lessons into a skill proposal to review" })
  @Guard(guildOnly, guildEnabled, managerOnly)
  async learn(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId ?? '';
    const proposal = buildSkillProposal(guildId);
    if (!proposal) {
      await interaction.reply({
        'content':
          'not enough learned lessons yet — I need at least three from real turns (do some work, correct me, or run `/ask` a few times first)',
        'flags': EPHEMERAL,
      });
      return;
    }

    const outcome = await requestApproval({
      'client': interaction.client,
      'guildId': guildId,
      'chatKey': `${guildId}:${interaction.channelId}`,
      'channelId': interaction.channelId,
      'actorId': interaction.user.id,
      'kind': 'bridge',
      'title': `skill proposal: ${proposal.name}`,
      'detail': renderProposal(proposal),
      'ttlMs': 10 * 60_000,
    });

    if (outcome === 'allowed' || outcome === 'always') {
      const fixtures = loadFixtures();
      await interaction.followUp({
        'content': `🧪 evaluating ${fixtures.length} fixture(s) against the incumbent before writing…`,
        'flags': EPHEMERAL,
      });
      const gate = await gateCandidate({
        'supervisor': services.get().supervisor,
        'guildId': guildId,
        'guildName': interaction.guild?.name ?? 'guild',
        'name': proposal.name,
        'content': proposal.content,
        'fixtures': fixtures,
        'approvedBy': interaction.user.id,
      });
      logger.info('gate decided', {
        guildId,
        'name': proposal.name,
        'promoted': gate.promoted,
        'reason': gate.reason,
        'by': interaction.user.id,
      });
      await interaction.followUp({
        'content': `${gate.promoted ? '🧠 promoted' : '🚫 not promoted'} \`.opencode/skills/${proposal.name}/SKILL.md\` — ${gate.reason}`,
        'flags': EPHEMERAL,
      });
      return;
    }
    await interaction.followUp({ 'content': `proposal ${outcome} — nothing was written`, 'flags': EPHEMERAL });
  }

  @Slash({ 'name': 'skills', 'description': 'List learned skills and feedback, or revert a skill version' })
  @Guard(guildOnly, guildEnabled)
  async skills(
    @SlashOption({
      'name': 'revert',
      'description': 'version to restore',
      'required': false,
      'type': 4 as OptionType.Integer,
    })
    revert: number | undefined,
    @SlashOption({
      'name': 'name',
      'description': 'skill name (default learned-playbook)',
      'required': false,
      'type': 3 as OptionType.String,
    })
    name: string | undefined,
    interaction: ChatInputCommandInteraction,
  ) {
    const guildId = interaction.guildId ?? '';
    const skillName = name ?? 'learned-playbook';

    if (revert !== undefined) {
      const ok = revertSkill(guildId, skillName, revert, interaction.user.id);
      await interaction.reply({
        'content': ok ? `⏪ reverted \`${skillName}\` to v${revert}` : `no recorded v${revert} for \`${skillName}\``,
        'flags': EPHEMERAL,
      });
      return;
    }

    const rows = artifacts.list(guildId, false).filter(row => row.kind === 'skill');
    const counts = feedback.stats(guildId);
    const current = readSkill(guildId, skillName);
    const embed = new EmbedBuilder()
      .setTitle('Learned skills')
      .setColor(BRAND_COLOR)
      .addFields(
        {
          'name': 'artifacts',
          'value':
            rows
              .map(
                row =>
                  `v${row.version} \`${row.name}\` ${row.active ? 'active' : 'superseded'} by ${row.approved_by ?? 'system'}`,
              )
              .join('\n') || 'none yet — run `/learn` after a few turns',
          'inline': false,
        },
        {
          'name': 'feedback',
          'value':
            Object.entries(counts)
              .map(([signal, count]) => `${signal}: ${count}`)
              .join(', ') || 'no reactions yet (👍/👎 on my messages counts)',
          'inline': false,
        },
        {
          'name': 'current file',
          'value': current ? `\`\`\`\n${current.slice(0, 900)}\n\`\`\`` : '_not written yet_',
          'inline': false,
        },
      );
    await interaction.reply({ 'embeds': [embed], 'flags': EPHEMERAL });
    void services;
  }
}
