import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { paths } from '@services/config.ts';
import { workspaces } from '@services/database/sqlite.ts';
import { log } from '@utils/logger.ts';

import { renderAgentsFile, renderDiscordToolFile, renderWorkspaceConfig } from './codegen.ts';

const logger = log('workspace');

const writeIfChanged = (path: string, content: string) => {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  writeFileSync(path, content);
  return true;
};

export type Provisioned = { dir: string; bridgeToken: string };

/**
 * Each guild gets a self-contained opencode project: the config/tools/skills next to the code are what the
 * pinned server loads for that directory (§0.1), so provisioning is what makes per-guild policy real.
 */
export function provisionWorkspace(guildId: string, guildName: string): Provisioned {
  const dir = resolve(paths.workspaces, guildId);
  const existing = workspaces.get(guildId);
  const bridgeToken = existing?.bridge_token ?? crypto.randomUUID();

  mkdirSync(resolve(dir, '.opencode/tools'), { 'recursive': true });
  mkdirSync(resolve(dir, 'repo'), { 'recursive': true });

  const changed: string[] = [];
  if (writeIfChanged(resolve(dir, 'opencode.json'), renderWorkspaceConfig())) changed.push('opencode.json');
  if (writeIfChanged(resolve(dir, 'AGENTS.md'), renderAgentsFile(guildName))) changed.push('AGENTS.md');
  if (writeIfChanged(resolve(dir, '.opencode/tools/discord.ts'), renderDiscordToolFile())) changed.push('discord.ts');
  if (writeIfChanged(resolve(dir, '.gitignore'), 'repo/\nMEMORY.md\n')) changed.push('.gitignore');
  if (!existsSync(resolve(dir, 'MEMORY.md'))) writeFileSync(resolve(dir, 'MEMORY.md'), `# Memory — ${guildName}\n`);

  workspaces.upsert({
    'guild_id': guildId,
    dir,
    'port': existing?.port ?? null,
    'password': existing?.password ?? null,
    'bridge_token': bridgeToken,
  });

  logger.info('workspace provisioned', { guildId, dir, 'regenerated': changed });
  return { dir, bridgeToken };
}
