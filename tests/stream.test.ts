import { Runtime } from '@services/agent/runtime.ts';
import { StreamRenderer, chunkMessage } from '@services/discord/render.ts';
import { describe, expect, test } from 'bun:test';

import type { Client, Message, TextChannel } from 'discord.js';

/** Minimal TextChannel: records sends and the one live message the renderer edits. */
const fakeChannel = () => {
  const sent: string[] = [];
  const state = { 'edited': [] as string[], 'deleted': 0 };
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
  test('the answer is a new message that pings the asker', async () => {
    const { channel, sent } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…');
    await renderer.start();
    renderer.push('draft text');
    await renderer.finish('the real answer', { 'mentionId': 'user-7' });

    expect(sent).toEqual(['🧠 thinking…', '<@user-7> the real answer']);
  });

  test('the live message survives the turn as a log of steps and thinking', async () => {
    const { channel, state } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…');
    await renderer.start();
    renderer.addStep('channels_list', 'completed');
    renderer.addStep('bash', 'error');
    renderer.setReasoning('p1', 'first thought');
    renderer.setReasoning('p1', 'first thought, extended');
    await renderer.finish('the answer', { 'mentionId': 'user-7', 'reasoning': 'authoritative reasoning' });

    const log = state.edited.at(-1) ?? '';
    expect(state.deleted).toBe(0);
    expect(log).toContain('🧠 log');
    expect(log).toContain('2 steps');
    expect(log).toContain('✓ `channels_list`');
    expect(log).toContain('✗ `bash`');
    expect(log).toContain('> authoritative reasoning');
    // The live reasoning was a prefix of the authoritative part, so it must not be duplicated.
    expect(log).not.toContain('first thought, extended');
  });

  test('a turn with no tool calls still logs its thinking', async () => {
    const { channel, state } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…');
    await renderer.start();
    await renderer.finish('42', { 'reasoning': 'nine sheep survive' });

    const log = state.edited.at(-1) ?? '';
    expect(log).toContain('0 steps');
    expect(log).toContain('> nine sheep survive');
  });

  test('a long chain of thought is trimmed to fit one Discord message', async () => {
    const { channel, state } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…');
    await renderer.start();
    for (let index = 0; index < 12; index += 1) renderer.addStep(`tool_${index}`, 'completed');
    await renderer.finish('answer', { 'reasoning': 'thought '.repeat(800) });

    const log = state.edited.at(-1) ?? '';
    expect(log.length).toBeLessThanOrEqual(1990);
    expect(log).toContain('✓ `tool_11`');
    expect(log).toContain('…');
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

  test('a failure keeps the live message, mentions the asker, and shows what it had done', async () => {
    const { channel, sent, state } = fakeChannel();
    const renderer = new StreamRenderer(channel, '🧠 thinking…');
    await renderer.start();
    renderer.addStep('message_send', 'completed');
    await renderer.fail('**the provider rejected the credential**', { 'mentionId': 'user-7' });

    expect(state.deleted).toBe(0);
    const shown = state.edited.at(-1) ?? '';
    expect(shown.startsWith('<@user-7> ⚠️ **the provider rejected the credential**')).toBe(true);
    expect(shown).toContain('✓ `message_send`');
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
      'lastReasoning': async () => '',
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
    const answer = sent.at(-1) ?? '';
    expect(answer.startsWith('<@user-7> ')).toBe(true);
    expect(answer).toContain('interrupted');
    expect(answer).toContain('partial answer');
    expect(state.edited.at(-1) ?? '').toContain('🧠 log');
  });
});
