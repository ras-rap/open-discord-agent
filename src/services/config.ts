import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BRIDGE_PORT, JEV_MODE, OPENCODE_BIN, OPENCODE_CLI, OWNER_ID } from '@utils/env.ts';
import { z } from 'zod';

const root = resolve(import.meta.dirname, '../..');

export const paths = {
  root,
  'data': resolve(root, '.data'),
  'workspaces': resolve(root, '.data/workspaces'),
  'config': resolve(root, 'config'),
  'db': resolve(root, '.data/agent.db'),
  'token': resolve(root, '.data/console-token.json'),
};

const GuildConfigSchema = z.object({
  'enabled': z.boolean().default(false),
  'shell': z
    .object({
      'mode': z.enum(['docker', 'host']).default('docker'),
      'image': z.string().default('debian:bookworm-slim'),
      'fallback': z.enum(['error', 'host']).default('error'),
    })
    .default({}),
  'roles': z
    .object({ 'admin': z.array(z.string()).default([]), 'trusted': z.array(z.string()).default([]) })
    .default({}),
});

export type GuildSettings = z.infer<typeof GuildConfigSchema>;

const GuildsFile = z.record(z.string(), GuildConfigSchema);

function readGuilds(): z.infer<typeof GuildsFile> {
  mkdirSync(paths.config, { 'recursive': true });
  const file = `${paths.config}/guilds.json`;
  if (!existsSync(file)) {
    writeFileSync(file, '{}\n');
    return {};
  }
  const parsed = GuildsFile.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`config/guilds.json invalid: ${parsed.error.message}`);
  return parsed.data;
}

export const MODELS = {
  'primary': 'opencode/crouton-alpha-free',
  'fast': 'opencode/beam-free',
  'jev': 'jev-1.13-free',
} as const;

export const config = {
  'bridge': { 'host': '127.0.0.1', 'port': BRIDGE_PORT },
  'opencode': {
    'host': '127.0.0.1',
    'binary': OPENCODE_BIN,
    'cli': OPENCODE_CLI,
    'version': '1.19.5',
    'portRange': [4100, 4300] as [number, number],
    'idleUnloadMs': 30 * 60_000,
    'startupTimeoutMs': 30_000,
  },
  'jevMode': JEV_MODE,
  'models': MODELS,
  'shellDefaults': { 'mode': 'docker' as const, 'image': 'debian:bookworm-slim', 'fallback': 'error' as const },
  paths,
  'raw': () => readGuilds(),
  'guild': (id: string): GuildSettings | undefined => readGuilds()[id],
  'setGuild': (id: string, value: unknown): void => {
    const all = readGuilds();
    all[id] = GuildConfigSchema.parse(value);
    mkdirSync(paths.config, { 'recursive': true });
    writeFileSync(`${paths.config}/guilds.json`, `${JSON.stringify(all, null, 2)}\n`);
  },
};

mkdirSync(paths.data, { 'recursive': true });
mkdirSync(paths.workspaces, { 'recursive': true });
export const isOwner = (userId: string) => userId === OWNER_ID;
