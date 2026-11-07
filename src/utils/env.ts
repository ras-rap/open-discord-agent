// Bun loads .env automatically; this module is the only place that reads it. Values are read lazily so unit
// tests can import domain modules without a .env, and `assertRuntimeEnv()` fails loudly before anything that
// needs Discord starts.
const optional = (key: string, ...aliases: string[]): string | undefined => {
  for (const candidate of [key, ...aliases]) {
    const value = process.env[candidate]?.trim();
    if (value && value.length > 0) return value;
  }
  return undefined;
};

export const NODE_ENV = optional('NODE_ENV') ?? 'development';
export const IS_PRODUCTION = NODE_ENV === 'production';
export const LOG_LEVEL = optional('LOG_LEVEL') ?? (IS_PRODUCTION ? 'info' : 'debug');

export const DISCORD_TOKEN = optional('DISCORD_TOKEN') ?? '';
export const DISCORD_CLIENT_ID = optional('DISCORD_CLIENT_ID', 'BOT_CLIENT_ID') ?? '';
export const DISCORD_DEVELOPMENT_GUILD_ID = optional('DISCORD_DEVELOPMENT_GUILD_ID', 'REGISTER_GUILD_ID') ?? '';
export const OWNER_ID = optional('OWNER_ID') ?? '';

/** Development registers to one guild (instant); production registers globally. */
export const AUTO_REGISTER_COMMANDS = (optional('AUTO_REGISTER_COMMANDS') ?? String(!IS_PRODUCTION)) === 'true';

export const BRIDGE_PORT = Number(optional('BRIDGE_PORT') ?? 7071);
export const JEV_MODE = (optional('JEV_MODE') ?? 'shadow').toLowerCase();
export const OPENCODE_BIN = optional('OPENCODE_BIN');
export const OPENCODE_CLI = optional('OPENCODE_CLI');
export const OPENCODE_CONSOLE_TOKEN = optional('OPENCODE_CONSOLE_TOKEN');

export type EnvKey = 'DISCORD_TOKEN' | 'DISCORD_CLIENT_ID' | 'OWNER_ID';

const values: Record<EnvKey, string> = { DISCORD_TOKEN, DISCORD_CLIENT_ID, OWNER_ID };

/** Boot-time validation: every command that talks to Discord calls this first. */
export function assertRuntimeEnv(): void {
  const missing = (Object.keys(values) as EnvKey[]).filter(key => values[key].length === 0);
  if (missing.length === 0) return;
  throw new Error(
    `missing required environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and fill them in.`,
  );
}

/** Guild-scoped registration needs a target guild; failing here beats a silent 404 from Discord. */
export function developmentGuildId(): string {
  if (DISCORD_DEVELOPMENT_GUILD_ID.length === 0)
    throw new Error('DISCORD_DEVELOPMENT_GUILD_ID is required for guild-scoped command registration');

  return DISCORD_DEVELOPMENT_GUILD_ID;
}
