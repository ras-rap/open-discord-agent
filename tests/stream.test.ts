import { Runtime } from '@services/agent/runtime.ts';
import { StreamRenderer, chunkMessage } from '@services/discord/render.ts';
import { describe, expect, test } from 'bun:test';

import type { Client, Message, TextChannel } from 'discord.js';

type Sent = string;

/** Minimal TextChannel: records sends and the one live message the renderer edits or deletes. */
const fakeChannel = () => {
  const sent: Sent[] = [];
  const state = { 'edited': [] as Sent[], 'deleted': 0 };
  const message = {
    'content': '',
    'edit': async (payload: { content: string }) => {
      state.edited.push(payload.content);
      return message;
    },
    'delete': async () => {
      state.deleted += 1;
    },
  } as unknown as Message;

  const channel = {
    'id': 'chan',
    'name': 'general',
    'send': async (payload: { content: string }) => {
      sent.push(payload.content);
      return message;
    },
  } as unknown as TextChannel;

  return { channel, sent, state };
};

describe('stream renderer', () => {
  test('the answer is a new message that pings the asker, and the preview is removed', async () => {
    const { channel, sent, state } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…');
    await renderer.start();
    renderer.push('draft text');
    await renderer.finish('the real answer', { 'mentionId': 'user-7' });

    expect(state.deleted).toBe(1);
    expect(sent).toEqual(['🧠 thinking…', '<@user-7> the real answer']);
    expect(state.edited).toEqual([]);
  });

  test('a timeout note is explained above the partial output, still mentioning the asker', async () => {
    const { channel, sent } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…');
    await renderer.start();
    await renderer.finish('partial answer', { 'mentionId': 'user-7', 'note': '⏱️ interrupted' });

    expect(sent.at(-1)).toBe('<@user-7> ⏱️ interrupted\n\npartial answer');
  });

  test('long answers split without exceeding the limit, and only the first chunk pings', async () => {
    const { channel, sent } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…');
    await renderer.start();
    const long = Array.from({ 'length': 400 }, (_, index) => `line ${index} of a long answer`).join('\n');
    await renderer.finish(long, { 'mentionId': 'user-7' });

    const answer = sent.slice(1);
    expect(answer.length).toBeGreaterThan(1);
    for (const chunk of answer) expect(chunk.length).toBeLessThanOrEqual(1990);
    expect(answer[0]?.startsWith('<@user-7> ')).toBe(true);
    expect(answer.slice(1).every(chunk => !chunk.includes('<@user-7>'))).toBe(true);
  });

  test('a failure keeps the preview it edited, and mentions the asker there', async () => {
    const { channel, sent, state } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…');
    await renderer.start();
    await renderer.fail('**the provider rejected the credential**', { 'mentionId': 'user-7' });

    expect(state.deleted).toBe(0);
    expect(state.edited.at(-1)).toBe('<@user-7> ⚠️ **the provider rejected the credential**');
    expect(sent).toHaveLength(1);
  });

  test('chunking keeps fences balanced even when a mention eats into the limit', () => {
    const code = Array.from({ 'length': 120 }, (_, index) => `const n${index} = ${index};`).join('\n');
    for (const chunk of chunkMessage(`intro\n\`\`\`ts\n${code}\n\`\`\``, 1990 - 32))
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
  });
});

describe('turn watchdog', () => {
  test('silence aborts the session and reports it, so the next prompt is not stuck behind it', async () => {
    const { channel, sent, state } = fakeChannel();
    const calls: string[] = [];
    const opencode = {
      'prompt': async () => {
        calls.push('prompt');
        // The server accepts the prompt and then never emits a single event.
      },
      'abort': async () => void calls.push('abort'),
      'lastText': async () => 'partial answer',
      'isBusy': async () => false,
      'createSession': async () => 'ses_timeout',
    };
    const supervisor = {
      'ensure': async () => ({ 'guildId': 'g', 'dir': '', 'port': 1, 'password': '', 'bridgeToken': '', opencode }),
    };
    const client = { 'channels': { 'fetch': async () => undefined } } as unknown as Client;

    const runtime = new Runtime(client, supervisor as never);
    await runtime.ask({
      'guildId': 'test-timeout-guild',
      'guildName': 'timeout-test',
      'channel': channel,
      'actorId': 'user-7',
      'actorName': 'tester',
      'member': null,
      'text': 'do a thing',
    });

    expect(calls).toEqual(['prompt', 'abort']);
    expect(state.deleted).toBe(1);
    const answer = sent.at(-1) ?? '';
    expect(answer.startsWith('<@user-7> ')).toBe(true);
    expect(answer).toContain('interrupted');
    expect(answer).toContain('partial answer');
  });
});
