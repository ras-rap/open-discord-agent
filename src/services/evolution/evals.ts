import { isToolPart, type AgentEvent } from '@services/agent/events.ts';
import { models } from '@services/agent/models.ts';
import { SAFETY_QUESTIONS, askJev } from '@services/policy/jev.ts';
import { log } from '@utils/logger.ts';

import { scoreFixture, type Fixture } from './fixtures.ts';

import type { RunningServer } from '@services/agent/supervisor.ts';

const logger = log('evolution/evals');
const FIXTURE_TIMEOUT_MS = 120_000;

export type ReplayResult = {
  'name': string;
  'ok': boolean;
  'toolCalls': string[];
  'text': string;
  'checks': Array<{ check: string; ok: boolean; detail: string }>;
  'judge'?: { 'answer'?: string; 'confidence'?: number };
  'ms': number;
};

/**
 * Replays one fixture in a throwaway session: prompt, collect tool calls and the final answer, then score it.
 * Sessions are never reused so one fixture cannot leak context into the next.
 */
export async function replay(server: RunningServer, fixture: Fixture): Promise<ReplayResult> {
  const started = Date.now();
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  server.opencode.subscribe(event => events.push(event), controller.signal);

  const session = await server.opencode.createSession(`eval:${fixture.name}`);
  await server.opencode.prompt(session, fixture.prompt, models.primary(server.guildId));

  const deadline = Date.now() + FIXTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (events.some(event => event.type === 'session.idle')) break;
    await Bun.sleep(200);
  }

  const toolCalls = events.filter(isToolPart).map(event => event.properties.part.tool ?? 'unknown');
  const text = await server.opencode.lastText(session);
  controller.abort();

  const scored = scoreFixture(fixture, { 'toolCalls': [...new Set(toolCalls)], 'text': text });
  let judge: ReplayResult['judge'];
  if (fixture.judge) {
    const answers = await askJev(`Question: ${fixture.judge}\n\nAnswer given: ${text.slice(0, 1200)}`, {
      'answer_ok': { 'type': 'noul', 'instructions': 'Does the answer satisfy the question?' },
    });
    judge = { 'answer': answers?.answer_ok?.choice, 'confidence': answers?.answer_ok?.noul };
  }

  logger.info('fixture replayed', { 'name': fixture.name, 'ok': scored.ok, 'ms': Date.now() - started });
  return { 'name': fixture.name, ...scored, toolCalls, text, judge, 'ms': Date.now() - started };
}

export type SuiteResult = { 'rate': number; 'passed': number; 'total': number; 'results': ReplayResult[] };

export async function runSuite(server: RunningServer, fixtures: Fixture[]): Promise<SuiteResult> {
  const results: ReplayResult[] = [];
  for (const fixture of fixtures) results.push(await replay(server, fixture));
  const passed = results.filter(result => result.ok).length;
  return { 'rate': results.length > 0 ? passed / results.length : 1, passed, 'total': results.length, results };
}

export function summarise(suite: SuiteResult): string {
  const lines = suite.results.map(result => `${result.ok ? '✅' : '❌'} ${result.name} (${result.ms}ms)`);
  const failed = suite.results.flatMap(result =>
    result.checks.filter(check => !check.ok).map(check => `  ${result.name}: ${check.check} → ${check.detail}`),
  );
  return [
    `pass ${suite.passed}/${suite.total} (${(suite.rate * 100).toFixed(0)}%)`,
    ...lines,
    ...failed.slice(0, 8),
  ].join('\n');
}

export { SAFETY_QUESTIONS };
