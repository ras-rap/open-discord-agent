import { log } from '@utils/logger.ts';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';

import type { QuestionInfo } from '@services/agent/events.ts';
import type { Client, Message, TextChannel } from 'discord.js';

const logger = log('questions');
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_ROWS = 5;

export type PendingQuestion = {
  requestId: string;
  guildId: string;
  chatKey: string;
  channelId: string;
  sessionId: string;
  questions: QuestionInfo[];
  answers: string[][];
  answered: number;
  message?: Message;
  resolve: (answers: string[][] | undefined) => void;
  timer: Timer;
};

/** Request ids are random per question, so a Map (not a lookup table) is the right store. */
const pending = new Map<string, PendingQuestion>();

export function getPending(requestId: string): PendingQuestion | undefined {
  return pending.get(requestId);
}

export function answerQuestion(
  requestId: string,
  questionIndex: number,
  labels: string[],
): 'ok' | 'unknown' | 'complete' {
  const entry = pending.get(requestId);
  if (!entry) return 'unknown';
  if (questionIndex < 0 || questionIndex >= entry.questions.length) return 'unknown';
  if (entry.answers[questionIndex]?.length) return 'ok';

  entry.answers[questionIndex] = labels;
  entry.answered += 1;
  if (entry.answered < entry.questions.length) return 'ok';

  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(entry.answers);
  return 'complete';
}

export function cancelQuestion(requestId: string): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(undefined);
  return true;
}

const componentsFor = (entry: PendingQuestion): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] => {
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  const budget = entry.questions.length < MAX_ROWS ? MAX_ROWS - 1 : MAX_ROWS;

  entry.questions.slice(0, budget).forEach((question, questionIndex) => {
    if (entry.answers[questionIndex]?.length) return;
    if (question.options.length <= 5) {
      const buttons = question.options.map((option, optionIndex) =>
        new ButtonBuilder()
          .setCustomId(`oda:q:${entry.requestId}:${questionIndex}:${optionIndex}`)
          .setLabel(option.label.slice(0, 80))
          .setStyle(ButtonStyle.Secondary),
      );
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`oda:qs:${entry.requestId}:${questionIndex}`)
      .setPlaceholder(question.header?.slice(0, 100) ?? 'Choose an answer')
      .setMinValues(1)
      .setMaxValues(question.multiple ? Math.min(question.options.length, 10) : 1)
      .addOptions(
        question.options.slice(0, 25).map(option => ({
          'label': option.label.slice(0, 100),
          'value': option.label.slice(0, 100),
          'description': option.description?.slice(0, 100),
        })),
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  });

  if (rows.length < MAX_ROWS)
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`oda:qc:${entry.requestId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
      ),
    );

  return rows;
};

const embedFor = (entry: PendingQuestion): EmbedBuilder => {
  const embed = new EmbedBuilder()
    .setColor(0xf0b132)
    .setTitle('The agent needs an answer')
    .setFooter({
      'text': `expires in ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s · ${entry.answered}/${entry.questions.length} answered`,
    });

  for (const [index, question] of entry.questions.entries()) {
    const answer = entry.answers[index]?.join(', ');
    const options = question.options.map(option => `\`${option.label}\``).join(' · ');
    embed.addFields({
      'name': `Q${index + 1}${question.header ? ` · ${question.header}` : ''}`,
      'value': `${question.question}\n${options}${answer ? `\n**answered:** ${answer}` : ''}`.slice(0, 1000),
    });
  }
  return embed;
};

/**
 * Surfaces opencode's `question` tool in Discord. The tool blocks until answered, so this either collects one
 * answer per question and returns them in order, or resolves `undefined` (timeout/cancel) and the caller
 * rejects the question so the agent can continue instead of hanging forever.
 */
export async function requestAnswers(input: {
  client: Client;
  guildId: string;
  chatKey: string;
  channelId: string;
  sessionId: string;
  requestId: string;
  questions: QuestionInfo[];
  timeoutMs?: number;
}): Promise<string[][] | undefined> {
  if (input.questions.length === 0) return [];
  const { promise, resolve } = Promise.withResolvers<string[][] | undefined>();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timer = setTimeout(() => {
    if (!pending.delete(input.requestId)) return;
    logger.info('question expired', { 'requestId': input.requestId, 'sessionId': input.sessionId });
    resolve(undefined);
  }, timeoutMs);

  const entry: PendingQuestion = {
    'requestId': input.requestId,
    'guildId': input.guildId,
    'chatKey': input.chatKey,
    'channelId': input.channelId,
    'sessionId': input.sessionId,
    'questions': input.questions,
    'answers': input.questions.map(() => []),
    'answered': 0,
    resolve,
    timer,
  };
  pending.set(input.requestId, entry);

  try {
    const channel = await input.client.channels.fetch(input.channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel))
      throw new Error('question channel is not text based');
    entry.message = await (channel as TextChannel).send({
      'embeds': [embedFor(entry)],
      'components': componentsFor(entry),
    });
  } catch (error) {
    logger.warn('could not post question card; cancelling the question', { 'error': String(error).slice(0, 200) });
    cancelQuestion(input.requestId);
  }

  return promise;
}

/** Redraws the card after an answer so the message shows what is still outstanding. */
export async function refreshQuestionCard(requestId: string): Promise<void> {
  const entry = pending.get(requestId);
  if (!entry?.message) return;
  await entry.message.edit({ 'embeds': [embedFor(entry)], 'components': componentsFor(entry) }).catch(() => undefined);
}

/** Removes buttons from the card once the question is finished (answered, cancelled, or expired). */
export async function closeQuestionCard(entry: PendingQuestion, note: string): Promise<void> {
  if (!entry.message) return;
  await entry.message
    .edit({ 'embeds': [embedFor(entry).setFooter({ 'text': note }).setColor(0x5865f2)], 'components': [] })
    .catch(() => undefined);
}

export function pendingForSession(sessionId: string): PendingQuestion[] {
  return [...pending.values()].filter(entry => entry.sessionId === sessionId);
}
