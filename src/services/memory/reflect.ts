import { models } from '@services/agent/models.ts';
import { db } from '@services/database/sqlite.ts';
import { feedbackSummary } from '@services/evolution/skills.ts';
import { log } from '@utils/logger.ts';
import { z } from 'zod';

import { memory } from './store.ts';

import type { RunningServer } from '@services/agent/supervisor.ts';

const logger = log('reflect');

const Entry = z.object({
  'key': z.string().min(1).max(120),
  'text': z.string().min(1).max(600),
  'importance': z.number().min(0).max(1).optional(),
});

const Reflection = z.object({
  'facts': z.array(Entry).default([]),
  'preferences': z.array(Entry).default([]),
  'lessons': z.array(Entry).default([]),
});

export type Turn = {
  guildId: string;
  sessionId: string;
  channelId?: string;
  userText: string;
  assistantText: string;
  toolCalls: Array<{ tool: string; status?: string; input?: unknown }>;
};

const SECRET_PATTERN =
  /(?:sk-[a-z0-9]{10,}|Bearer\s+[A-Za-z0-9._-]{20,}|[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|password\s*[:=]\s*\S+)/i;

const INSTRUCTIONS = `You extract durable memory from one Discord assistant turn.
Return ONLY minified JSON, no prose, no code fence:
{"facts":[{"key":"short-stable-id","text":"...","importance":0.0}],"preferences":[{"key":"...","text":"..."}],"lessons":[{"key":"...","text":"..."}]}

Rules:
- facts: stable statements about this server, its channels, roles, people, projects, or decisions.
- preferences: how the people here want things done ("they prefer terse answers", "channels are named kebab-case").
- lessons: reusable procedure learned from this turn (what worked, what failed and why) — not a restatement of the answer.
- Each text under 200 characters. Omit anything uncertain, transient, or already obvious.
- Never include credentials, tokens, passwords, or personal data beyond Discord usernames/ids.
- Empty arrays when nothing durable was learned.`;

const reflectSession = (guildId: string, server: RunningServer): Promise<string> => {
  const existing = db
    .query<{ session_id: string }, [string]>('SELECT session_id FROM reflect_sessions WHERE guild_id = ?')
    .get(guildId);
  if (existing) return Promise.resolve(existing.session_id);
  return server.opencode.createSession(`reflection ${guildId}`).then(sessionId => {
    db.query(
      'INSERT INTO reflect_sessions (guild_id, session_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET session_id = excluded.session_id',
    ).run(guildId, sessionId, Date.now());
    return sessionId;
  });
};

function parseReflection(text: string): z.infer<typeof Reflection> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = Reflection.safeParse(JSON.parse(text.slice(start, end + 1)));
    if (!parsed.success) {
      logger.debug('reflection failed validation', { 'error': parsed.error.message.slice(0, 200) });
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

/**
 * Reflection is a second, cheap model pass over the finished turn (beam-free): it turns the conversation
 * into typed memory rows. Anything that looks like a credential is dropped before it can reach the store.
 */
export async function reflectTurn(server: RunningServer, turn: Turn): Promise<number> {
  const toolSummary = turn.toolCalls
    .map(
      call => `${call.tool}:${call.status ?? '?'}${call.input ? ` ${JSON.stringify(call.input).slice(0, 120)}` : ''}`,
    )
    .join('\n');
  const signal = turn.channelId ? feedbackSummary(turn.guildId, turn.channelId) : undefined;
  const payload = [
    INSTRUCTIONS,
    '',
    'TURN',
    `user: ${turn.userText.slice(0, 1500)}`,
    `assistant: ${turn.assistantText.slice(0, 2500)}`,
    `tools:\n${toolSummary || '(none)'}`,
    signal
      ? `reactions: ${signal.positive} positive, ${signal.negative} negative${signal.notes.length > 0 ? ` — notes: ${signal.notes.join(' | ')}` : ''}`
      : 'reactions: none',
  ].join('\n');

  try {
    const sessionId = await reflectSession(turn.guildId, server);
    await server.opencode.prompt(sessionId, payload, models.fast());
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (!(await server.opencode.isBusy(sessionId).catch(() => false))) break;
      await Bun.sleep(400);
    }
    const reflection = parseReflection(await server.opencode.lastText(sessionId));
    if (!reflection) return 0;

    let written = 0;
    const rows: Array<[typeof reflection.facts, 'fact' | 'preference' | 'lesson']> = [
      [reflection.facts, 'fact'],
      [reflection.preferences, 'preference'],
      [reflection.lessons, 'lesson'],
    ];
    for (const [entries, kind] of rows)
      for (const entry of entries) {
        if (SECRET_PATTERN.test(entry.text)) {
          logger.warn('dropped memory that looks like a credential', { 'key': entry.key, kind });
          continue;
        }
        memory.add({
          'guildId': turn.guildId,
          kind,
          'key': entry.key,
          'text': entry.text,
          'importance': entry.importance ?? (kind === 'lesson' ? 0.6 : 0.5),
          'confidence': 0.6,
          'source': `reflect:${turn.sessionId}`,
        });
        written += 1;
      }

    if (written > 0) logger.info('memory updated', { 'guildId': turn.guildId, 'entries': written });
    return written;
  } catch (error) {
    logger.warn('reflection failed', { 'error': String(error).slice(0, 200) });
    return 0;
  }
}

/** True when the turn is substantial enough that a reflection pass is worth a model call. */
export function worthReflecting(turn: { userText: string; assistantText: string; toolCalls: unknown[] }): boolean {
  if (turn.toolCalls.length > 0) return true;
  if (/remember|don't forget|from now on|always|never/i.test(turn.userText)) return true;
  return turn.userText.length > 80 && turn.assistantText.length > 200;
}
