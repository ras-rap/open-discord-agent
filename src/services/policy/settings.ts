import { modelRef } from '@services/agent/models.ts';
import { capabilities } from '@services/bridge/capabilities.ts';
import { RISK_NAMES, RANK_NAMES, POLICY_MODES, VERDICTS, guildDefaults, type GuildSettings } from '@services/config.ts';

/**
 * Who may change a setting. `admin` means a guild admin (tier 3, or the bot owner); `owner` means the bot
 * owner alone — anything that widens what the agent may do to the machine or the server lives there, so a
 * guild admin cannot turn the sandbox off or hand themselves a capability.
 */
export type SettingScope = 'owner' | 'admin';

export type Setting = {
  path: string;
  scope: SettingScope;
  description: string;
  /** Parses the raw slash-command string; throws an `Error` with a message fit to show in Discord. */
  parse: (raw: string) => unknown;
};

const TOOL_NAMES = capabilities.map(capability => capability.name);

const nonEmpty = (value: string, what: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${what} cannot be empty`);
  return trimmed;
};

const boolean = (raw: string): boolean => {
  const value = raw.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(value)) return true;
  if (['false', 'no', 'off', '0'].includes(value)) return false;
  throw new Error(`expected true or false, got "${raw}"`);
};

const snowflakes = (raw: string): string[] => {
  const ids = raw
    .split(/[\s,]+/)
    .map(id => id.trim())
    .filter(id => id.length > 0);
  const bad = ids.find(id => !/^\d{16,20}$/.test(id));
  if (bad) throw new Error(`"${bad}" is not a Discord id`);
  return ids;
};

const toolNames = (raw: string): string[] => {
  const names = raw
    .split(/[\s,]+/)
    .map(name => name.trim())
    .filter(name => name.length > 0);
  const unknown = names.find(name => !TOOL_NAMES.includes(name));
  if (unknown) throw new Error(`"${unknown}" is not one of the ${TOOL_NAMES.length} tools`);
  return names;
};

const oneOf =
  <T extends string>(allowed: readonly T[], what: string) =>
  (raw: string): T => {
    const value = raw.trim().toLowerCase() as T;
    if (!allowed.includes(value)) throw new Error(`${what} must be one of ${allowed.join(', ')}`);
    return value;
  };

/** Rank × risk overrides are generated so `/config set` can address any single cell of the table. */
const matrixSettings: Setting[] = RANK_NAMES.flatMap(rank =>
  RISK_NAMES.map(risk => ({
    'path': `policy.matrix.${rank}.${risk}`,
    'scope': 'owner' as const,
    'description': `what a ${rank} may do with ${risk} actions`,
    'parse': oneOf(VERDICTS, 'verdict'),
  })),
);

export const SETTINGS: Setting[] = [
  {
    'path': 'enabled',
    'scope': 'owner',
    'description': 'whether the agent answers in this server at all',
    'parse': boolean,
  },
  {
    'path': 'policy.mode',
    'scope': 'admin',
    'description': 'ask = approval cards, vibe = run unattended with a Jev veto, locked = read only',
    'parse': oneOf(POLICY_MODES, 'mode'),
  },
  {
    'path': 'policy.vibe.maxRisk',
    'scope': 'admin',
    'description': 'riskiest class vibe mode runs unattended',
    'parse': oneOf(['read', 'reversible', 'destructive'] as const, 'maxRisk'),
  },
  {
    'path': 'policy.vibe.screen',
    'scope': 'admin',
    'description': 'Jev screening in vibe mode: off, shadow (log only) or enforce',
    'parse': oneOf(['off', 'shadow', 'enforce'] as const, 'screen'),
  },
  {
    'path': 'policy.vibe.minApproval',
    'scope': 'admin',
    'description': 'Jev approval score (0-1) a call must reach in vibe mode; below it the call is refused',
    'parse': raw => {
      const value = Number(raw.trim());
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('minApproval must be a number 0-1');
      return value;
    },
  },
  {
    'path': 'policy.vibe.askOnUncertain',
    'scope': 'admin',
    'description': 'ask a human when Jev cannot be reached or is unsure',
    'parse': boolean,
  },
  {
    'path': 'policy.tools.deny',
    'scope': 'admin',
    'description': 'comma-separated tools nobody may run here',
    'parse': toolNames,
  },
  {
    'path': 'policy.tools.allow',
    'scope': 'owner',
    'description': 'comma-separated tools that skip the approval card for everyone',
    'parse': toolNames,
  },
  ...matrixSettings,
  {
    'path': 'shell.mode',
    'scope': 'owner',
    'description': 'sandbox for shell calls: docker (isolated) or host (runs as the bot user)',
    'parse': oneOf(['docker', 'host'] as const, 'shell mode'),
  },
  {
    'path': 'shell.image',
    'scope': 'owner',
    'description': 'container image used for the shell sandbox',
    'parse': raw => nonEmpty(raw, 'image'),
  },
  {
    'path': 'shell.fallback',
    'scope': 'owner',
    'description': 'what to do when docker is missing: error (refuse) or host (run anyway)',
    'parse': oneOf(['error', 'host'] as const, 'fallback'),
  },
  {
    'path': 'roles.admin',
    'scope': 'owner',
    'description': 'comma-separated role ids treated as admins',
    'parse': snowflakes,
  },
  {
    'path': 'roles.trusted',
    'scope': 'owner',
    'description': 'comma-separated role ids treated as trusted',
    'parse': snowflakes,
  },
  {
    'path': 'model.primary',
    'scope': 'admin',
    'description': 'provider/model for chat, code and tool use',
    'parse': raw => {
      modelRef(nonEmpty(raw, 'model'));
      return raw.trim();
    },
  },
  {
    'path': 'model.fast',
    'scope': 'admin',
    'description': 'provider/model for reflection and memory',
    'parse': raw => {
      modelRef(nonEmpty(raw, 'model'));
      return raw.trim();
    },
  },
];

export const settingByPath = (path: string): Setting | undefined => SETTINGS.find(setting => setting.path === path);

const segments = (path: string): string[] => path.split('.').filter(segment => segment.length > 0);

/** Dotted read that never throws: an unset key reads as `undefined`. */
export function readSetting(settings: unknown, path: string): unknown {
  let cursor: unknown = settings;
  for (const segment of segments(path)) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Immutable dotted write. Values are cloned first so a caller holding the previous settings object never sees
 * a half-applied change.
 */
export function setSetting<T>(settings: T, path: string, value: unknown): T {
  const clone = structuredClone(settings) as Record<string, unknown>;
  const keys = segments(path);
  const containers: Array<Record<string, unknown>> = [clone];
  for (const key of keys.slice(0, -1)) {
    const parent = containers.at(-1) ?? clone;
    const child = parent[key];
    if (typeof child !== 'object' || child === null) parent[key] = {};
    containers.push(parent[key] as Record<string, unknown>);
  }

  const last = keys.at(-1) ?? '';
  const leafParent = containers.at(-1) ?? clone;
  // Resetting to `undefined` means "unset": the key is removed and so is any ancestor that only existed to
  // hold it, so a reset restores the exact shape the schema default has.
  if (value !== undefined) {
    leafParent[last] = value;
    return clone as T;
  }
  delete leafParent[last];
  for (let depth = keys.length - 1; depth >= 1; depth -= 1) {
    // Stop at any container the schema itself defines: `policy.matrix` stays `{}`, `policy.matrix.member`
    // did not exist by default and is pruned.
    if (readSetting(guildDefaults(), keys.slice(0, depth).join('.')) !== undefined) break;
    const parent = containers[depth - 1];
    if (!parent) break;
    const key = keys[depth - 1] ?? '';
    const child = parent[key];
    if (typeof child !== 'object' || child === null || Object.keys(child).length > 0) break;
    delete parent[key];
  }
  return clone as T;
}

/** What `/config reset` writes: the schema default for that exact path. */
export function defaultFor(path: string): unknown {
  return readSetting(guildDefaults(), path);
}

/** Parses a raw value against the registry entry, so `/config set` fails before anything is written. */
export function parseSetting(path: string, raw: string): unknown {
  const setting = settingByPath(path);
  if (!setting) throw new Error(`unknown setting "${path}"`);
  return setting.parse(raw);
}

/** Human-readable current value, used by `/config show` and the confirmations. */
export function describeSetting(settings: GuildSettings, path: string): string {
  const value = readSetting(settings, path);
  if (value === undefined) return 'unset';
  if (Array.isArray(value)) return value.length === 0 ? 'empty' : value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}
