import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { log } from '@utils/logger.ts';

import { runSuite, type SuiteResult } from './evals.ts';
import { readSkill, skillFile, writeSkill } from './skills.ts';

import type { Fixture } from './fixtures.ts';
import type { RunningServer, Supervisor } from '@services/agent/supervisor.ts';

const logger = log('evolution/gate');

export type GateOutcome = {
  'promoted': boolean;
  'reason': string;
  'baseline'?: SuiteResult;
  'candidate'?: SuiteResult;
};

export type GateInput = {
  supervisor: Supervisor;
  guildId: string;
  guildName: string;
  name: string;
  content: string;
  fixtures: Fixture[];
  approvedBy: string;
};

const writeRaw = (file: string, content: string) => {
  mkdirSync(dirname(file), { 'recursive': true });
  writeFileSync(file, content);
};

/**
 * Non-regression gate: replay the fixtures against the incumbent skill, swap in the candidate, restart the
 * guild's server (skills load at start-up), replay again, and keep the change only if it does not do worse.
 * Any failure restores the previous bytes, so a bad self-edit cannot survive the gate.
 */
export async function gateCandidate(input: GateInput): Promise<GateOutcome> {
  const file = skillFile(input.guildId, input.name);
  const previous = readSkill(input.guildId, input.name);

  const restore = (): void => {
    if (previous === undefined) rmSync(file, { 'force': true });
    else writeRaw(file, previous);
  };

  if (input.fixtures.length === 0) {
    const written = writeSkill(input.guildId, input.name, input.content, input.approvedBy);
    return { 'promoted': true, 'reason': `no fixtures — promoted directly (v${written.version})` };
  }

  const evaluateOnFreshServer = async (): Promise<SuiteResult> => {
    await input.supervisor.stop(input.guildId);
    const server: RunningServer = await input.supervisor.ensure(input.guildId, input.guildName);
    return runSuite(server, input.fixtures);
  };

  let baseline: SuiteResult | undefined;
  let candidate: SuiteResult | undefined;
  try {
    baseline = await evaluateOnFreshServer();
    logger.info('baseline evaluated', { 'guildId': input.guildId, 'rate': baseline.rate });

    writeRaw(file, input.content);
    candidate = await evaluateOnFreshServer();
    logger.info('candidate evaluated', { 'guildId': input.guildId, 'rate': candidate.rate });

    if (candidate.rate < baseline.rate) {
      restore();
      await input.supervisor.stop(input.guildId);
      return {
        'promoted': false,
        'reason': `regression: ${(baseline.rate * 100).toFixed(0)}% → ${(candidate.rate * 100).toFixed(0)}%, reverted`,
        baseline,
        candidate,
      };
    }

    writeSkill(input.guildId, input.name, input.content, input.approvedBy, `agent: promote skill ${input.name}`);
    return {
      'promoted': true,
      'reason': `kept: ${(baseline.rate * 100).toFixed(0)}% → ${(candidate.rate * 100).toFixed(0)}%`,
      baseline,
      candidate,
    };
  } catch (error) {
    restore();
    logger.warn('gate failed; restored previous skill', {
      'guildId': input.guildId,
      'error': String(error).slice(0, 200),
    });
    return {
      'promoted': false,
      'reason': `gate failed: ${String(error).slice(0, 160)}, reverted`,
      baseline,
      candidate,
    };
  }
}

/** Runs the fixture suite against whatever is currently on disk — the "how are we doing" button. */
export async function evaluateCurrent(
  supervisor: Supervisor,
  guildId: string,
  guildName: string,
  fixtures: Fixture[],
): Promise<SuiteResult | undefined> {
  if (fixtures.length === 0) return undefined;
  await supervisor.stop(guildId);
  const server = await supervisor.ensure(guildId, guildName);
  return runSuite(server, fixtures);
}

export { existsSync };
