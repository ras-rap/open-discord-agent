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

export const RISK_NAMES = ['read', 'reversible', 'destructive', 'admin'] as const;
export const RANK_NAMES = ['guest', 'member', 'trusted', 'admin', 'owner'] as const;
export const VERDICTS = ['allow', 'ask', 'deny'] as const;
export const POLICY_MODES = ['ask', 'vibe', 'locked'] as const;

const Verdict = z.enum(VERDICTS);
const RankName = z.enum(RANK_NAMES);

/** One rank's override of the built-in risk ceiling; omitted cells keep the table value. */
const RiskCell = z.object({
  'read': Verdict.optional(),
  'reversible': Verdict.optional(),
  'destructive': Verdict.optional(),
  'admin': Verdict.optional(),
});

const PolicySchema = z
  .object({
    /**
     * ask    — anything the ceiling does not allow outright becomes an approval card
     * vibe   — the same actions run unattended; Jev screens them and only stops what looks destructive
     * locked — nothing above `read` ever runs, whatever the rank says
     */
    'mode': z.enum(POLICY_MODES).default('ask'),
    'matrix': z.record(RankName, RiskCell).default({}),
    'tools': z
      .object({
        /** Run without an approval card for every rank. Safety-critical: owner-only. */
        'allow': z.array(z.string()).default([]),
        /** Never run, not even for the owner. */
        'deny': z.array(z.string()).default([]),
      })
      .default({}),
    'vibe': z
      .object({
        /** The riskiest class vibe mode will run unattended; anything above still asks. */
        'maxRisk': z.enum(['read', 'reversible', 'destructive']).default('destructive'),
        'screen': z.enum(['off', 'shadow', 'enforce']).default('enforce'),
        /**
         * Jev's "would an admin approve this" score has to reach this before vibe runs it. Calibrated against
         * real readings: a plain `message_send` scores ~0.66, a shell `rm` ~0.23, an out-of-repo edit ~0.08.
         */
        'minApproval': z.number().min(0).max(1).default(0.4),
        /** When Jev cannot be reached: `true` asks a human, `false` trusts the ceiling. */
        'askOnUncertain': z.boolean().default(true),
      })
      .default({}),
  })
  .default({});

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
  'policy': PolicySchema,
});

export type GuildPolicy = z.infer<typeof PolicySchema>;

/** Every default in one object, so `/config reset` restores exactly what the schema says. */
export const guildDefaults = (): GuildSettings => GuildConfigSchema.parse({});
export type SettingMatrix = z.infer<typeof RiskCell>;

export type GuildSettings = z.infer<typeof GuildConfigSchema>;

const GuildsFile = z.record(z.string(), GuildConfigSchema);

/** `GUILDS_FILE` exists so a deployment (and the policy tests) can point at a different registry. */
export const guildsFilePath = () => optionalEnv('GUILDS_FILE') ?? `${paths.config}/guilds.json`;

function readGuilds(): z.infer<typeof GuildsFile> {
  const file = guildsFilePath();
  if (file.startsWith(paths.config)) mkdirSync(paths.config, { 'recursive': true });
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
  /** Effective policy for a guild: schema defaults when the guild has never been touched. */
  'policy': (id: string): GuildPolicy => GuildConfigSchema.parse(readGuilds()[id] ?? {}).policy,
  paths,
  'raw': () => readGuilds(),
  'guild': (id: string): GuildSettings | undefined => readGuilds()[id],
  'setGuild': (id: string, value: unknown): void => {
    const all = readGuilds();
    all[id] = GuildConfigSchema.parse(value);
    writeFileSync(guildsFilePath(), `${JSON.stringify(all, null, 2)}\n`);
  },
  /** Partial update that keeps the other guild keys, so `/model set` cannot drop `/enable`'s settings. */
  'patchGuild': (id: string, patch: Record<string, unknown>): GuildSettings => {
    const all = readGuilds();
    const next = GuildConfigSchema.parse({ ...(all[id] ?? {}), ...patch });
    all[id] = next;
    writeFileSync(guildsFilePath(), `${JSON.stringify(all, null, 2)}\n`);
    return next;
  },
};

mkdirSync(paths.data, { 'recursive': true });
mkdirSync(paths.workspaces, { 'recursive': true });
export const isOwner = (userId: string) => userId === OWNER_ID;
