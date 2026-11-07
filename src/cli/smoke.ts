import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertPinnedBinary } from '@services/agent/binary.ts';
import { isDelta, isIdle, isPermissionAsked, type AgentEvent } from '@services/agent/events.ts';
import { models } from '@services/agent/models.ts';
import { Supervisor } from '@services/agent/supervisor.ts';
import { paths } from '@services/config.ts';
import { SAFETY_QUESTIONS, askJev, consoleToken } from '@services/policy/jev.ts';
import { log } from '@utils/logger.ts';

const logger = log('smoke');
const GUILD = `smoke-${Date.now().toString(36)}`;
const DEADLINE_MS = 90_000;

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  logger.info(`${ok ? '✅' : '❌'} ${name}`, { detail });
};

/**
 * Waits for the session's idle event (or falls back to polling `session.status`). Prompt delivery is async,
 * so polling status alone can observe "not busy" before the agent loop even starts.
 */
async function waitIdle(
  server: Awaited<ReturnType<Supervisor['ensure']>>,
  sessionId: string,
  events: AgentEvent[],
): Promise<boolean> {
  const deadline = Date.now() + DEADLINE_MS;
  let started = false;
  while (Date.now() < deadline) {
    const sawIdle = events.some(event => isIdle(event) && event.properties.sessionID === sessionId);
    if (sawIdle) return true;
    if (!started && events.some(event => isDelta(event) && event.properties.sessionID === sessionId)) started = true;
    const busy = await server.opencode.isBusy(sessionId).catch(() => false);
    if (busy) started = true;
    else if (started) return true;
    await Bun.sleep(250);
  }
  return false;
}

/**
 * End-to-end check of the real machinery without Discord: pinned binary, workspace provisioning, a live
 * server per workspace, prompting, streamed deltas, the permission ask/reply round-trip, and Jev.
 */
async function main(): Promise<void> {
  await assertPinnedBinary();
  record('binary', true, 'pinned opencode binary responds');

  const events: AgentEvent[] = [];
  const supervisor = new Supervisor((_guildId, event) => events.push(event));
  await supervisor.start();

  try {
    const server = await supervisor.ensure(GUILD, 'smoke-server');
    record('supervisor', true, `server on port ${server.port}`);

    const session = await server.opencode.createSession('smoke');
    await server.opencode.prompt(session, 'Reply with exactly SMOKE_OK and nothing else.', models.primary());
    const idle = await waitIdle(server, session, events);
    const text = await server.opencode.lastText(session);
    record('prompt', idle && text.includes('SMOKE_OK'), `final text: ${JSON.stringify(text.slice(0, 80))}`);
    const deltas = events.filter(isDelta).length;
    record('streaming', deltas > 0, `${deltas} text deltas observed`);

    events.length = 0;
    const shellSession = await server.opencode.createSession('smoke-shell');
    await server.opencode.prompt(
      shellSession,
      'Call the bash tool with command: echo smoke-permission. Then report its output.',
      models.primary(),
    );
    let askId: string | undefined;
    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline && !askId) {
      const ask = events.find(isPermissionAsked);
      askId = ask?.properties.id;
      if (!askId) await Bun.sleep(200);
    }
    if (askId) {
      const delivered = await server.opencode.replyPermission(askId, 'once');
      record('permission round-trip', delivered, `asked ${askId}, reply delivered=${delivered}`);
    } else record('permission round-trip', false, 'no permission.asked event within deadline');

    await waitIdle(server, shellSession, events);

    if (consoleToken()) {
      const answers = await askJev(
        'Assistant wants to delete the #general channel in a Discord server with 40 members.',
        SAFETY_QUESTIONS,
      );
      record('jev', Boolean(answers), JSON.stringify(answers).slice(0, 160));
    } else record('jev', true, 'skipped: no console token (run `bun run auth` to enable)');

    record(
      'events seen',
      true,
      [...new Set(events.filter(event => event.type !== 'message.part.delta').map(event => event.type))].join(', '),
    );
    const errors = events.filter(event => event.type === 'session.error');
    if (errors.length > 0) logger.warn('session errors observed', { 'detail': JSON.stringify(errors).slice(0, 600) });
  } finally {
    await supervisor.stopAll();
    try {
      rmSync(resolve(paths.workspaces, GUILD), { 'recursive': true, 'force': true });
    } catch (error) {
      logger.warn('workspace cleanup skipped', { 'error': String(error).slice(0, 120) });
    }
  }

  const failed = results.filter(result => !result.ok);
  logger.info('smoke summary', { 'passed': results.length - failed.length, 'failed': failed.length });
  process.exit(failed.length > 0 ? 1 : 0);
}

await main();
