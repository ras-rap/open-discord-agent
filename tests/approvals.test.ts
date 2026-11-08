import { approvals } from '@services/database/sqlite.ts';
import { cancelApprovalsForSession } from '@services/discord/approvals.ts';
import { describe, expect, test } from 'bun:test';

import type { Client } from 'discord.js';

/**
 * A finished turn must not leave clickable cards behind. The card of an answered approval is removed by the
 * button handler; the ones nobody answered are removed here, from the message id recorded when the card was
 * posted — that path also covers a card left over from before a restart, where no waiter exists any more.
 */
describe('approval card cleanup', () => {
  test('pending cards for an ending session are deleted and closed', async () => {
    const sessionId = `ses_cleanup_${Date.now()}`;
    approvals.create({
      'id': `ap_cleanup_${Date.now()}`,
      'kind': 'permission',
      'guild_id': 'g',
      'chat_key': 'g:chan-1',
      'session_id': sessionId,
      'request_id': 'per_cleanup',
      'payload': JSON.stringify({ 'title': 'bash', 'detail': 'echo hi' }),
      'message_id': 'msg_1',
      'state': 'pending',
      'created_by': 'user-1',
      'created_at': Date.now(),
    });

    const deleted: string[] = [];
    const client = {
      'channels': {
        'fetch': async (channelId: string) => ({
          'isTextBased': () => true,
          'messages': {
            'fetch': async (messageId: string) => ({
              'delete': async () => void deleted.push(`${channelId}/${messageId}`),
            }),
          },
        }),
      },
    } as unknown as Client;

    await cancelApprovalsForSession(sessionId, client);

    expect(deleted).toEqual(['chan-1/msg_1']);
    expect(approvals.pendingBySession(sessionId)).toHaveLength(0);
  });
});
