import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { paths } from '@services/config.ts';
import { OPENCODE_CLI } from '@utils/env.ts';
import { log } from '@utils/logger.ts';

const logger = log('auth');
const JEV_ENDPOINT = 'https://opencode.ai/inference/systemone/v1/systemone';

type ExportedValue = {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  key?: string;
  apiKey?: string;
  metadata?: Record<string, unknown>;
};

type ExportedEntry = {
  integrationID?: string;
  integration?: string;
  label?: string;
  active?: boolean;
  value?: ExportedValue;
};

export type Candidate = {
  integration: string;
  kind: 'oauth' | 'api';
  token: string;
  refresh?: string;
  expires?: number;
};

/**
 * `opencode auth export` only exists on the globally installed CLI (the pinned 1.19.5 has no export
 * subcommand), and Bun puts `node_modules/.bin` first on PATH, so the global binary is resolved explicitly.
 */
function globalCli(): string {
  if (OPENCODE_CLI) return OPENCODE_CLI;
  const stripped = (Bun.env.PATH ?? '')
    .split(delimiter)
    .filter(entry => !entry.includes(`${join('node_modules', '.bin')}`))
    .join(delimiter);
  const found = Bun.which('opencode', { 'PATH': stripped });
  if (!found) throw new Error('global `opencode` CLI not found; set OPENCODE_CLI to its path');
  return found;
}

/** Export comes as a list in 2.x, but tolerate an object keyed by integration id. */
function normalizeExport(raw: unknown): ExportedEntry[] {
  if (Array.isArray(raw)) return raw as ExportedEntry[];
  if (raw && typeof raw === 'object')
    return Object.entries(raw as Record<string, ExportedEntry>).map(([integration, entry]) => ({
      ...entry,
      'integrationID': entry.integrationID ?? integration,
    }));

  return [];
}

function candidatesFrom(entries: ExportedEntry[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    const integration = entry.integrationID ?? entry.integration ?? 'unknown';
    const value = entry.value ?? {};
    const token = value.access ?? value.key ?? value.apiKey;
    if (!token) continue;
    candidates.push({
      integration,
      'kind': value.access ? 'oauth' : 'api',
      token,
      'refresh': value.refresh,
      'expires': value.expires,
    });
  }
  // Prefer the plain console integration, then the Go subscription, then anything with a token.
  const rank = (candidate: Candidate) =>
    candidate.integration === 'opencode' ? 0 : candidate.integration.startsWith('opencode-go') ? 1 : 2;
  return candidates.sort((left, right) => rank(left) - rank(right));
}

/** A credential is only useful if the Jev endpoint accepts it, so each one is tried before being stored. */
async function probe(candidate: Candidate): Promise<{ ok: boolean; status: number; detail: string }> {
  try {
    const response = await fetch(JEV_ENDPOINT, {
      'method': 'POST',
      'headers': { 'authorization': `Bearer ${candidate.token}`, 'content-type': 'application/json' },
      'body': JSON.stringify({
        'model': 'jev-1.13-free',
        'state': 'The assistant proposes to rename the channel #general to #lobby.',
        'questions': { 'harmless': { 'type': 'noul', 'instructions': 'Is this action non-destructive?' } },
      }),
      'signal': AbortSignal.timeout(15_000),
    });
    const body = (await response.text()).slice(0, 200);
    return { 'ok': response.ok, 'status': response.status, 'detail': body };
  } catch (error) {
    return { 'ok': false, 'status': 0, 'detail': String(error).slice(0, 200) };
  }
}

/**
 * Jev is served by OpenCode Zen and bills through whichever OpenCode credential exists on the machine:
 * console OAuth (`access`) or an OpenCode Go API key (`key`). Rather than assume one, every exported
 * credential is probed against the endpoint and the first that answers 200 is stored, mode 0600.
 */
async function main(): Promise<void> {
  const manual = process.env.OPENCODE_CONSOLE_TOKEN;
  const candidates: Candidate[] = manual
    ? [{ 'integration': 'OPENCODE_CONSOLE_TOKEN', 'kind': 'api', 'token': manual }]
    : await (async () => {
        const binary = globalCli();
        const proc = Bun.spawn([binary, 'auth', 'export'], { 'stdout': 'pipe', 'stderr': 'pipe' });
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (code !== 0) throw new Error(`\`${binary} auth export\` failed (${code}): ${stderr.trim().slice(0, 300)}`);
        return candidatesFrom(normalizeExport(JSON.parse(stdout)));
      })();

  if (candidates.length === 0)
    throw new Error(
      'no OpenCode credential with a token found in `opencode auth export`; run `opencode auth login` ' +
        '(OpenCode Go or OpenCode Console) and retry',
    );

  logger.info('probing credentials for the Jev endpoint', {
    'found': candidates.map(candidate => `${candidate.integration}:${candidate.kind}`),
  });

  for (const candidate of candidates) {
    const result = await probe(candidate);
    logger.info(`${result.ok ? '✅' : '❌'} ${candidate.integration} (${candidate.kind})`, {
      'status': result.status,
      'detail': result.detail,
    });
    if (!result.ok) continue;
    writeFileSync(
      paths.token,
      `${JSON.stringify(
        {
          'kind': candidate.kind,
          'token': candidate.token,
          'refresh': candidate.refresh,
          'expires': candidate.expires,
          'integration': candidate.integration,
          'capturedAt': Date.now(),
        },
        null,
        2,
      )}\n`,
      { 'mode': 0o600 },
    );
    chmodSync(paths.token, 0o600);
    logger.info('console token stored', {
      'path': paths.token,
      'integration': candidate.integration,
      'kind': candidate.kind,
    });
    return;
  }

  throw new Error(
    'none of the exported OpenCode credentials were accepted by the Jev endpoint; ' +
      'check the status codes above (401/403 means the key has no Jev entitlement)',
  );
}

await main().catch(error => {
  logger.error('auth failed', { 'error': error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
