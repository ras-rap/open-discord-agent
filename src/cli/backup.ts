import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { paths } from '@services/config.ts';
import { db } from '@services/database/sqlite.ts';
import { log } from '@utils/logger.ts';

const logger = log('cli/backup');
const KEEP = 14;

/**
 * SQLite's own `VACUUM INTO` is the only safe way to copy a live database: it writes a consistent snapshot
 * without pausing the bot, unlike copying the file (which can capture a torn WAL).
 */
export async function backup(): Promise<string> {
  const dir = resolve(paths.data, 'backups');
  mkdirSync(dir, { 'recursive': true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = resolve(dir, `agent-${stamp}.db`);

  db.query('VACUUM INTO ?').run(target);
  logger.info('backup written', { 'path': target, 'bytes': statSync(target).size });

  const snapshots = readdirSync(dir)
    .filter(name => name.startsWith('agent-') && name.endsWith('.db'))
    .sort()
    .reverse();
  for (const stale of snapshots.slice(KEEP)) {
    rmSync(resolve(dir, stale), { 'force': true });
    logger.info('pruned old backup', { 'name': stale });
  }
  return target;
}
