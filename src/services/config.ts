import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { BRIDGE_PORT, JEV_MODE, OPENCODE_BIN, OPENCODE_CLI, OWNER_ID, optionalEnv } from '@utils/env.ts';
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
  /** `/model set` writes here; unset roles fall back to the deployment defaults in MODELS. */
  'model': z.object({ 'primary': z.string().min(3).optional(), 'fast': z.string().min(3).optional() }).default({}),
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

/**
 * Role → `provider/model`. Every role is overridable from `.env`, and `/model set` overrides a role for one
 * guild. `MODEL_FAST` is used for reflection/consolidation so bulk text never touches the expensive model.
 *
 * The default pair is the OpenCode Go subscription: the provider is served from
 * https://opencode.ai/inference/go — a different base URL from the free tier, which is what "Free usage
 * exceeded, subscribe to Go" means. Point these at any other provider (see `config/providers.example.json`).
 */
export const MODELS = {
  'primary': optionalEnv('MODEL_PRIMARY') ?? 'opencode-go/crouton-alpha-free',
  'fast': optionalEnv('MODEL_FAST') ?? 'opencode-go/beam-free',
  /** Bare id: Jev is called directly, not through opencode, so it has no provider prefix. */
  'jev': optionalEnv('MODEL_JEV') ?? 'jev-1.13-free',
} as const;

/** Go is served separately from pay-as-you-go and the free tier; this is the endpoint the doctor probes. */
export const GO_CHAT_ENDPOINT = 'https://opencode.ai/inference/go/openai/v1/chat/completions';

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
  /** Partial update that keeps the other guild keys, so `/model set` cannot drop `/enable`'s settings. */
  'patchGuild': (id: string, patch: Record<string, unknown>): GuildSettings => {
    const all = readGuilds();
    const next = GuildConfigSchema.parse({ ...(all[id] ?? {}), ...patch });
    all[id] = next;
    mkdirSync(paths.config, { 'recursive': true });
    writeFileSync(`${paths.config}/guilds.json`, `${JSON.stringify(all, null, 2)}\n`);
    return next;
  },
};

mkdirSync(paths.data, { 'recursive': true });
mkdirSync(paths.workspaces, { 'recursive': true });
export const isOwner = (userId: string) => userId === OWNER_ID;
