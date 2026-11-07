import { approvals } from '@services/database/sqlite.ts';
import { log } from '@utils/logger.ts';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client, type TextChannel } from 'discord.js';

const logger = log('approvals');
const DEFAULT_TTL_MS = 180_000;

export type ApprovalKind = 'bridge' | 'permission';
export type ApprovalOutcome = 'allowed' | 'always' | 'denied' | 'expired';

type Waiter = { resolve: (outcome: ApprovalOutcome) => void; timer: Timer };

/** Ids are random per request, so a Map (not a lookup table) is the right store. */
const waiters = new Map<string, Waiter>();

export type ApprovalRequest = {
  client: Client;
  guildId: string;
  chatKey: string;
  channelId: string;
  actorId: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  sessionId?: string;
  requestId?: string;
  ttlMs?: number;
};

/**
 * Posts an approval card and resolves when a human clicks. Fail-closed: timeout, deleted channel, or a
 * missing waiter all resolve to `expired`, which callers must treat exactly like `denied`.
 */
export async function requestApproval(input: ApprovalRequest): Promise<ApprovalOutcome> {
  const id = `ap_${crypto.randomUUID().slice(0, 8)}`;
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  const { promise, resolve } = Promise.withResolvers<ApprovalOutcome>();

  approvals.create({
    id,
    'kind': input.kind,
    'guild_id': input.guildId,
    'chat_key': input.chatKey,
    'session_id': input.sessionId ?? null,
    'request_id': input.requestId ?? null,
    'payload': JSON.stringify({ 'title': input.title, 'detail': input.detail }),
    'message_id': null,
    'state': 'pending',
    'created_by': input.actorId,
    'created_at': Date.now(),
  });

  const embed = new EmbedBuilder()
    .setTitle(`Approval needed: ${input.title}`)
    .setColor(0xf0b132)
    .setDescription(input.detail.slice(0, 3500))
    .setFooter({ 'text': `${input.kind} · requested by ${input.actorId} · expires in ${Math.round(ttl / 1000)}s` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`oda:ap:${id}:allow`).setLabel('Allow once').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`oda:ap:${id}:always`).setLabel('Always').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`oda:ap:${id}:deny`).setLabel('Reject').setStyle(ButtonStyle.Danger),
  );

  const timer = setTimeout(() => {
    if (!waiters.delete(id)) return;
    approvals.decide(id, 'expired', 'system');
    logger.info('approval expired', { id, 'kind': input.kind });
    resolve('expired');
  }, ttl);

  waiters.set(id, { resolve, timer });

  try {
    const channel = await input.client.channels.fetch(input.channelId);
    if (!channel || !channel.isTextBased() || !('send' in channel))
      throw new Error('approval channel is not text based');
    const message = await (channel as TextChannel).send({ 'embeds': [embed], 'components': [row] });
    approvals.setMessage(id, message.id);
  } catch (error) {
    logger.warn('could not post approval card; denying', { id, 'error': String(error).slice(0, 200) });
    clearTimeout(timer);
    waiters.delete(id);
    approvals.decide(id, 'expired', 'system');
    resolve('expired');
  }

  return promise;
}

/** Called from the button handler. Returns false when the id is unknown (already decided or expired). */
export function resolveApproval(id: string, decision: 'allow' | 'always' | 'deny', approverId: string): boolean {
  const waiter = waiters.get(id);
  if (!waiter) return false;
  waiters.delete(id);
  clearTimeout(waiter.timer);
  const allowed = decision !== 'deny';
  approvals.decide(id, allowed ? 'allowed' : 'denied', approverId);
  waiter.resolve(decision === 'allow' ? 'allowed' : decision === 'always' ? 'always' : 'denied');
  return true;
}

export function cancelApprovalsForSession(sessionId: string): void {
  for (const row of approvals.pendingBySession(sessionId)) {
    approvals.decide(row.id, 'expired', 'session-ended');
    const waiter = waiters.get(row.id);
    if (!waiter) continue;
    waiters.delete(row.id);
    clearTimeout(waiter.timer);
    waiter.resolve('expired');
  }
}
