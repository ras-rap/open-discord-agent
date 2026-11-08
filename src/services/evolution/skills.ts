import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { paths } from '@services/config.ts';
import { feedback, artifacts } from '@services/database/sqlite.ts';
import { log } from '@utils/logger.ts';

const logger = log('evolution');

export type SkillWrite = { name: string; path: string; sha256: string; version: number; created: boolean };

const sha256 = (content: string): string => {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(content);
  return hasher.digest('hex');
};

/** Skills live in the guild workspace so the pinned server loads them as project instructions. */
export function skillFile(guildId: string, name: string): string {
  const safe = name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return resolve(paths.workspaces, guildId, '.opencode/skills', safe, 'SKILL.md');
}

export function readSkill(guildId: string, name: string): string | undefined {
  const file = skillFile(guildId, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

/**
 * Every artifact change is committed to the workspace git repo first, so a bad self-edit is one `git revert`
 * away and the diff of what the agent taught itself stays inspectable.
 */
export function commitWorkspace(guildId: string, message: string): boolean {
  const cwd = resolve(paths.workspaces, guildId);
  mkdirSync(cwd, { 'recursive': true });
  // Bun.spawnSync does not always resolve bare names from PATH on Windows, so the binary is located first.
  const git = Bun.which('git');
  if (!git) {
    logger.warn('git not found; artifact changes will not be versioned', { guildId });
    return false;
  }
  const run = (argv: string[]) =>
    Bun.spawnSync([git, ...argv], { 'cwd': cwd, 'stdout': 'pipe', 'stderr': 'pipe', 'env': Bun.env });

  if (!existsSync(resolve(cwd, '.git'))) {
    const init = run(['init', '-q']);
    if (init.exitCode !== 0) {
      logger.warn('git init failed; skills will not be versioned', {
        guildId,
        'stderr': init.stderr.toString().slice(0, 200),
      });
      return false;
    }
  }
  run(['add', '-A']);
  const commit = run([
    '-c',
    'user.email=agent@open-discord-agent',
    '-c',
    'user.name=open-discord-agent',
    'commit',
    '-q',
    '-m',
    message,
  ]);
  if (commit.exitCode !== 0) {
    const stderr = commit.stderr.toString();
    if (!stderr.includes('nothing to commit'))
      logger.warn('workspace commit failed', { guildId, 'stderr': stderr.slice(0, 200) });
    return false;
  }
  return true;
}

export function writeSkill(
  guildId: string,
  name: string,
  content: string,
  approvedBy: string,
  message = `agent: skill ${name}`,
): SkillWrite {
  const file = skillFile(guildId, name);
  mkdirSync(dirname(file), { 'recursive': true });
  const existed = existsSync(file);
  writeFileSync(file, content);

  const digest = sha256(content);
  const version = artifacts.nextVersion(guildId, 'skill', name);
  artifacts.record({
    'guild_id': guildId,
    'kind': 'skill',
    'name': name,
    'path': file,
    'sha256': digest,
    'content': content,
    'version': version,
    'approved_by': approvedBy,
  });

  commitWorkspace(guildId, message);
  logger.info('skill written', { guildId, name, version, 'changed': !existed });
  return { name, 'path': file, 'sha256': digest, version, 'created': !existed };
}

/** Restores a skill to a previous version from the recorded bytes, so the revert is exact. */
export function revertSkill(guildId: string, name: string, version: number, by: string): boolean {
  const rows = artifacts.list(guildId, false).filter(row => row.kind === 'skill' && row.name === name);
  const target = rows.find(row => row.version === version && typeof row.content === 'string');
  if (!target?.content) return false;
  writeSkill(guildId, name, target.content, by, `agent: revert skill ${name} to v${version}`);
  return true;
}

export type FeedbackSummary = { positive: number; negative: number; notes: string[] };

/** Feedback is folded into reflection so a thumbs-down teaches something, not just a counter. */
export function feedbackSummary(
  guildId: string,
  channelId: string,
  windowMs = 15 * 60_000,
): FeedbackSummary | undefined {
  const rows = feedback.since(guildId, channelId, Date.now() - windowMs);
  if (rows.length === 0) return undefined;
  return {
    'positive': rows.filter(row => row.signal === 'positive').length,
    'negative': rows.filter(row => row.signal === 'negative').length,
    'notes': rows
      .map(row => row.note)
      .filter((note): note is string => typeof note === 'string' && note.length > 0)
      .slice(0, 5),
  };
}

/** Drops the last workspace commit (the previous turn's file changes). Repo-scoped, so config is untouched. */
export function undoWorkspace(guildId: string): { 'reverted': boolean; 'detail': string } {
  const cwd = resolve(paths.workspaces, guildId);
  const git = Bun.which('git');
  if (!git) return { 'reverted': false, 'detail': 'git not available' };
  if (!existsSync(resolve(cwd, '.git'))) return { 'reverted': false, 'detail': 'no history yet' };
  const run = (argv: string[]) => Bun.spawnSync([git, ...argv], { 'cwd': cwd, 'stdout': 'pipe', 'stderr': 'pipe' });

  const count = Number(run(['rev-list', '--count', 'HEAD']).stdout.toString().trim() || '0');
  if (count <= 1) return { 'reverted': false, 'detail': 'nothing to undo' };
  const head = run(['log', '-1', '--pretty=%s']).stdout.toString().trim();
  const reset = run(['reset', '--hard', 'HEAD~1']);
  if (reset.exitCode !== 0) return { 'reverted': false, 'detail': reset.stderr.toString().slice(0, 120) };
  logger.info('workspace reverted', { guildId, 'undone': head });
  return { 'reverted': true, 'detail': head };
}
