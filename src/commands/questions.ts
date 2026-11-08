import {
  answerQuestion,
  cancelQuestion,
  closeQuestionCard,
  getPending,
  refreshQuestionCard,
} from '@services/discord/questions.ts';
import { log } from '@utils/logger.ts';
import { Discord, ButtonComponent, SelectMenuComponent } from 'discordx';

import type { QuestionInfo } from '@services/agent/events.ts';
import type { ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';

const logger = log('commands/questions');

const optionsOf = (questions: QuestionInfo[], questionIndex: number): QuestionInfo['options'] => {
  const question = questions[questionIndex];
  return question ? question.options : [];
};

@Discord()
export class QuestionComponents {
  /** One button per option; the custom id carries the option so the label never has to be re-parsed. */
  @ButtonComponent({ 'id': /^oda:q:/ })
  async onOption(interaction: ButtonInteraction) {
    const [, , requestId, questionIndexRaw, optionIndexRaw] = interaction.customId.split(':');
    const entry = requestId ? getPending(requestId) : undefined;
    if (!requestId || !entry || questionIndexRaw === undefined || optionIndexRaw === undefined) {
      await interaction.reply({
        'content': 'this question has already been answered or expired',
        'flags': ['Ephemeral'] as const,
      });
      return;
    }
    const questionIndex = Number(questionIndexRaw);
    const option = optionsOf(entry.questions, questionIndex)[Number(optionIndexRaw)];
    if (!option) {
      await interaction.reply({ 'content': 'unknown option', 'flags': ['Ephemeral'] as const });
      return;
    }

    const status = answerQuestion(requestId, questionIndex, [option.label]);
    logger.info('question answered', {
      requestId,
      questionIndex,
      'label': option.label,
      'by': interaction.user.id,
      status,
    });
    await interaction.reply({ 'content': `answered: **${option.label}**`, 'flags': ['Ephemeral'] as const });
    if (status === 'complete') await closeQuestionCard(entry, `answered by ${interaction.user.username}`);
    else await refreshQuestionCard(requestId);
  }

  @SelectMenuComponent({ 'id': /^oda:qs:/ })
  async onSelect(interaction: StringSelectMenuInteraction) {
    const [, , requestId, questionIndexRaw] = interaction.customId.split(':');
    const entry = requestId ? getPending(requestId) : undefined;
    if (!requestId || !entry || questionIndexRaw === undefined) {
      await interaction.reply({
        'content': 'this question has already been answered or expired',
        'flags': ['Ephemeral'] as const,
      });
      return;
    }
    const labels = [...interaction.values];
    const status = answerQuestion(requestId, Number(questionIndexRaw), labels);
    logger.info('question answered', {
      requestId,
      'questionIndex': Number(questionIndexRaw),
      labels,
      'by': interaction.user.id,
      status,
    });
    await interaction.reply({ 'content': `answered: **${labels.join(', ')}**`, 'flags': ['Ephemeral'] as const });
    if (status === 'complete') await closeQuestionCard(entry, `answered by ${interaction.user.username}`);
    else await refreshQuestionCard(requestId);
  }

  @ButtonComponent({ 'id': /^oda:qc:/ })
  async onCancel(interaction: ButtonInteraction) {
    const [, , requestId] = interaction.customId.split(':');
    const entry = requestId ? getPending(requestId) : undefined;
    const cancelled = requestId ? cancelQuestion(requestId) : false;
    logger.info('question cancelled', { requestId, 'by': interaction.user.id, cancelled });
    if (entry) await closeQuestionCard(entry, `cancelled by ${interaction.user.username}`);
    await interaction.reply({
      'content': cancelled ? 'cancelled — the agent will continue without an answer' : 'this question already ended',
      'flags': ['Ephemeral'] as const,
    });
  }
}
