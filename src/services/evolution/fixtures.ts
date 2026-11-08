import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { paths } from '@services/config.ts';
import { log } from '@utils/logger.ts';
import { z } from 'zod';

const logger = log('evolution/fixtures');

const FixtureSchema = z.object({
  'name': z.string().min(3),
  'prompt': z.string().min(3),
  'expect': z
    .object({
      /** Tool ids the model must call, e.g. discord_channels_list. */
      'tools': z.array(z.string()).default([]),
      /** Regexes the final answer must match. */
      'textMatches': z.array(z.string()).default([]),
      /** Regexes the final answer must NOT match (leak checks, invented ids, ...). */
      'textForbids': z.array(z.string()).default([]),
      /** Minimum characters in the final answer. */
      'minLength': z.number().int().min(0).default(1),
    })
    .default({}),
  /** Optional yes/no question for Jev to judge the answer beyond the deterministic checks. */
  'judge': z.string().optional(),
});

export type Fixture = z.infer<typeof FixtureSchema>;

const fixtureFile = (name: string) => resolve(paths.root, 'config/fixtures', name);

/**
 * Fixtures live in `config/fixtures/*.json` so they are reviewable in git. A missing directory simply means
 * no fixtures, which turns the eval gate into a no-op instead of an error.
 */
export function loadFixtures(): Fixture[] {
  let files: string[];
  try {
    files = readdirSync(fixtureFile('')).filter(name => name.endsWith('.json'));
  } catch {
    return [];
  }
  const fixtures: Fixture[] = [];
  for (const file of files)
    try {
      const parsed = FixtureSchema.safeParse(JSON.parse(readFileSync(fixtureFile(file), 'utf8')));
      if (!parsed.success) {
        logger.warn('fixture rejected', { file, 'error': parsed.error.message.slice(0, 200) });
        continue;
      }
      fixtures.push(parsed.data);
    } catch (error) {
      logger.warn('fixture unreadable', { file, 'error': String(error).slice(0, 160) });
    }

  return fixtures.sort((left, right) => left.name.localeCompare(right.name));
}

export type CheckOutcome = { 'check': string; 'ok': boolean; 'detail': string };

/** Pure scoring of one replay: deterministic assertions first, the judge question only adds context. */
export function scoreFixture(
  fixture: Fixture,
  result: { 'toolCalls': string[]; 'text': string },
): { 'ok': boolean; 'checks': CheckOutcome[] } {
  const checks: CheckOutcome[] = [];

  for (const tool of fixture.expect.tools) {
    const ok = result.toolCalls.includes(tool);
    checks.push({
      'check': `tool:${tool}`,
      'ok': ok,
      'detail': ok ? 'called' : `not called (saw: ${result.toolCalls.join(', ') || 'none'})`,
    });
  }
  for (const pattern of fixture.expect.textMatches) {
    const ok = new RegExp(pattern, 'i').test(result.text);
    checks.push({ 'check': `match:${pattern}`, 'ok': ok, 'detail': ok ? 'matched' : result.text.slice(0, 160) });
  }
  for (const pattern of fixture.expect.textForbids) {
    const ok = !new RegExp(pattern, 'i').test(result.text);
    checks.push({
      'check': `forbid:${pattern}`,
      'ok': ok,
      'detail': ok ? 'clean' : `leaked: ${result.text.slice(0, 120)}`,
    });
  }
  const longEnough = result.text.trim().length >= fixture.expect.minLength;
  checks.push({ 'check': 'minLength', 'ok': longEnough, 'detail': `${result.text.trim().length} chars` });

  return { 'ok': checks.every(check => check.ok), 'checks': checks };
}
