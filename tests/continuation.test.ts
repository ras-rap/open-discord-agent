import { Runtime } from '@services/agent/runtime.ts';
import { describe, expect, test } from 'bun:test';

import type { AgentEvent } from '@services/agent/events.ts';
import type { Client, Message, TextChannel } from 'discord.js';

const fakeChannel = () => {
  const sent: string[] = [];
  const edited: string[] = [];
  const message = {
    'content': '',
    'edit': async (payload: { content: string }) => {
      edited.push(payload.content);
      return message;
    },
    'delete': async () => undefined,
  } as unknown as Message;
  const channel = {
    'id': 'chan',
    'name': 'general',
    'send': async (payload: { content: string }) => {
      sent.push(payload.content);
      return message;
    },
  } as unknown as TextChannel;
  return { channel, sent, edited };
};

const toolError = (sessionID: string, id: string, tool: string, error: string): AgentEvent =>
  ({
    'type': 'message.part.updated',
    'properties': { sessionID, 'part': { id, 'type': 'tool', tool, 'state': { 'status': 'error', error } } },
  }) as AgentEvent;

const idle = (sessionID: string): AgentEvent => ({ 'type': 'session.idle', 'properties': { sessionID } }) as AgentEvent;

/**
 * The reported turn: the model announced "building spam, mention and link protection", one `write` failed, and
 * the turn ended there — the channel got the promise, not the feature. A round that ends on a failed tool call
 * is now continued in the same session with the error in hand, and if it still fails the answer says so.
 */
describe('failed tool calls', () => {
  const ask = async (rounds: Array<Array<{ tool: string; error: string }>>, texts: string[]) => {
    const { channel, sent, edited } = fakeChannel();
    const prompts: string[] = [];
    let round = 0;

    const sink: { runtime?: Runtime } = {};
    const sessionID = `ses_fail_${Date.now()}`;
    const opencode = {
      'prompt': async (_session: string, text: string) => {
        prompts.push(text);
        const failures = rounds[round] ?? [];
        round += 1;
        for (const [index, failure] of failures.entries())
          sink.runtime?.handleEvent('g', toolError(sessionID, `${sessionID}-p${index}`, failure.tool, failure.error));
        sink.runtime?.handleEvent('g', idle(sessionID));
      },
      'lastText': async () => texts[Math.min(round, texts.length) - 1] ?? '',
      'lastReasoning': async () => '',
      'abort': async () => undefined,
      'isBusy': async () => false,
      'createSession': async () => sessionID,
      'rejectQuestion': async () => true,
    };
    const supervisor = {
      'ensure': async () => ({
        'guildId': 'g',
        'dir': '',
        'port': 1,
        'password': '',
        'bridgeToken': '',
        opencode,
      }),
      'get': () => undefined,
    };
    const client = { 'channels': { 'fetch': async () => undefined } } as unknown as Client;

    const runtime = new Runtime(client, supervisor as never);
    sink.runtime = runtime;
    await runtime.ask({
      'guildId': `g-${sessionID}`,
      'guildName': 'fail-test',
      'channel': channel,
      'actorId': 'user-7',
      'actorName': 'tester',
      'member': null,
      'text': 'Make it an automod bot too',
    });
    // The harness also prompts the session for memory reflection; only these two shapes are turn prompts.
    const turnPrompts = prompts.filter(text => text.startsWith('[#') || text.startsWith('[system note]'));
    return { 'prompts': turnPrompts, sent, edited, 'answer': sent.at(-1) ?? '' };
  };

  test('a failed round is continued with the error, and a clean round ends the turn', async () => {
    const { prompts, answer } = await ask(
      [[{ 'tool': 'write', 'error': 'refused by policy: edit is not allowed outside repo/' }], []],
      ['Plan confirmed — building spam protection.', 'Added automod: spam, mentions, links. Tests pass.'],
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('write');
    expect(prompts[1]).toContain('refused by policy');
    expect(prompts[1]).toContain('finish the work');
    expect(answer).toContain('Added automod');
    // A continuation that succeeded must not leave a failure warning on the answer.
    expect(answer).not.toContain('tool call(s) failed');
  });

  test('a turn that never recovers says what failed instead of posting the promise', async () => {
    const { prompts, answer } = await ask(
      [
        [{ 'tool': 'write', 'error': 'refused by policy: not allowed outside repo/' }],
        [{ 'tool': 'write', 'error': 'refused by policy: not allowed outside repo/' }],
        [{ 'tool': 'write', 'error': 'refused by policy: not allowed outside repo/' }],
      ],
      ['Plan confirmed — building.', 'Still trying.', 'I could not write the file.'],
    );

    // One prompt plus two continuations, then it stops rather than looping forever.
    expect(prompts).toHaveLength(3);
    expect(answer).toContain('I could not write the file.');
    expect(answer).toContain('1 tool call(s) failed');
    expect(answer).toContain('`write`');
    expect(answer).toContain('refused by policy');
  });

  test('a clean turn is prompted exactly once', async () => {
    const { prompts, answer } = await ask([[]], ['Done.']);
    expect(prompts).toHaveLength(1);
    expect(answer).toBe('<@user-7> Done.');
  });
});
