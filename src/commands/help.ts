import { effectiveModel } from '@services/agent/models.ts';
import { capabilities } from '@services/bridge/capabilities.ts';
import { BRAND_COLOR, EPHEMERAL } from '@utils/constants.ts';
import { EmbedBuilder } from 'discord.js';
import { Discord, Slash } from 'discordx';

import type { Risk } from '@services/bridge/capabilities.ts';
import type { ChatInputCommandInteraction } from 'discord.js';

const RISK_ORDER: Risk[] = ['read', 'reversible', 'destructive', 'admin'];

const RISK_NOTE: Record<Risk, string> = {
  'read': 'no approval',
  'reversible': 'approval for members, free for admins',
  'destructive': 'approval required above guest',
  'admin': 'owner / admin only',
};

/**
 * In-chat answer to "what can this thing do". Built from the same capability registry the tools are rendered
 * from, so it cannot drift from what the agent actually has.
 */
@Discord()
export class HelpCommand {
  @Slash({ 'description': 'What this agent can do and how to drive it', 'name': 'help' })
  async help(interaction: ChatInputCommandInteraction) {
    const grouped: Record<Risk, string[]> = { 'read': [], 'reversible': [], 'destructive': [], 'admin': [] };
    for (const capability of capabilities) grouped[capability.risk].push(capability.name);

    const toolFields = RISK_ORDER.filter(risk => grouped[risk].length > 0).map(risk => ({
      'name': `${risk} tools — ${RISK_NOTE[risk]}`,
      'value': `\`${grouped[risk].join('` `')}\``.slice(0, 1024),
      'inline': false,
    }));

    const primary = effectiveModel('primary', interaction.guildId ?? '');

    const embed = new EmbedBuilder()
      .setTitle('open-discord-agent')
      .setColor(BRAND_COLOR)
      .setDescription(
        'A coding + server-admin agent in your Discord. Talk to it with `/ask` or by mentioning it; it replies ' +
          'in the channel and acts through the tools below. Every tool call is authorised against *your* rank ' +
          'before it runs, and remembered facts survive `/new`.',
      )
      .addFields(
        {
          'name': 'start here',
          'value': [
            '`/ask <prompt>` — run a task in this channel',
            '`/help` — this card · `/status` — servers, sessions, policy, models',
            '`/new` — fresh conversation (memory stays) · `/abort` — stop the run',
          ].join('\n'),
          'inline': false,
        },
        {
          'name': 'models',
          'value':
            `running \`${primary.id}\` · \`/model current\` shows the roles, ` +
            '`/model list` what this deployment can offer, `/model set` switches (admin)',
          'inline': false,
        },
        {
          'name': 'memory & learning',
          'value': [
            '`/remember <text>` — durable fact · `/memory [query]` — search or forget',
            '`/learn` — turn stored lessons into a skill proposal and review the diff',
            '`/skills` — list learned skills · `/skill-file` — print one · `/eval` — replay fixtures',
          ].join('\n'),
          'inline': false,
        },
        {
          'name': 'when it needs you',
          'value':
            'a permission ask or a question arrives as a card with buttons (a select menu when there are more ' +
            'than five options). Unanswered asks expire; `/audit` shows what was decided.',
          'inline': false,
        },
        ...toolFields,
      )
      .setFooter({ 'text': `${capabilities.length} tools · authored in src/services/bridge/capabilities.ts` });

    await interaction.reply({ 'embeds': [embed], 'flags': EPHEMERAL });
  }
}
