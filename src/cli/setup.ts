import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { CATALOG_PROVIDERS, providerConfigBlocks } from '@services/agent/providers.ts';
import { paths } from '@services/config.ts';
import { log } from '@utils/logger.ts';

import type { Interface } from 'node:readline/promises';

const logger = log('setup');

type DiscordApplication = {
  id: string;
  name: string;
  flags: number;
  owner?: { id: string };
  approximate_guild_count?: number;
};

/**
 * Guild Members and Message Content are privileged intents: the bot needs them for `member_list` and to read
 * mentions at all. They surface as application flags — either the plain bit or the `_LIMITED` bit, which is
 * what an app in fewer than 100 guilds gets — so both are accepted.
 */
const GUILD_MEMBERS_FLAGS = (1 << 14) | (1 << 15);
const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);

const envPath = resolve(paths.root, '.env');
const examplePath = resolve(paths.root, '.env.example');

/**
 * The bot accepts a few historical names for the Discord variables, so the wizard must recognise them too:
 * otherwise re-running setup appends a second `DISCORD_CLIENT_ID` next to the `BOT_CLIENT_ID` already there.
 */
const ENV_ALIASES: Record<string, string[]> = {
  'DISCORD_TOKEN': ['BOT_TOKEN'],
  'DISCORD_CLIENT_ID': ['BOT_CLIENT_ID'],
  'DISCORD_DEVELOPMENT_GUILD_ID': ['REGISTER_GUILD_ID'],
};

const readRawValues = (): Record<string, string> => {
  const source = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const values: Record<string, string> = {};
  for (const line of source.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1]) values[match[1]] = match[2] ?? '';
  }
  return values;
};

/** Canonical key → the value and the line it actually lives on (which may be an alias). */
const readValues = (): Record<string, { value: string; lineKey: string }> => {
  const raw = readRawValues();
  const resolved: Record<string, { value: string; lineKey: string }> = {};
  const canonical = Object.keys(ENV_ALIASES);
  for (const key of canonical) {
    const lineKey = [key, ...(ENV_ALIASES[key] ?? [])].find(candidate => raw[candidate] !== undefined);
    if (lineKey) resolved[key] = { 'value': raw[lineKey] ?? '', lineKey };
  }
  return resolved;
};

/**
 * Writes keys into `.env` without disturbing anything else in it: an operator's comments and extra variables
 * survive, and a key that already exists is replaced in place rather than duplicated.
 */
const writeValues = (updates: Record<string, string>): void => {
  const source = existsSync(envPath)
    ? readFileSync(envPath, 'utf8')
    : existsSync(examplePath)
      ? readFileSync(examplePath, 'utf8')
      : '';
  const lines = source.split('\n').map(line => line.replace(/\r$/, ''));
  const pending = new Map(Object.entries(updates));

  const next = lines.map(line => {
    const match = /^([A-Z0-9_]+)=/.exec(line.trim());
    const key = match?.[1];
    if (!key || !pending.has(key)) return line;
    const value = pending.get(key) ?? '';
    pending.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of pending) next.push(`${key}=${value}`);
  writeFileSync(envPath, `${next.join('\n').replace(/\n+$/, '')}\n`, { 'mode': 0o600 });
};

/** `--yes` answers every prompt with its default, which is what re-validating a finished `.env` needs. */
let assumeYes = false;
let inputClosed = false;

const ask = async (rl: Interface, question: string, fallback?: string): Promise<string> => {
  if (assumeYes || inputClosed) return fallback ?? '';
  const suffix = fallback ? ` [${fallback}]` : '';
  try {
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer.length > 0 ? answer : (fallback ?? '');
  } catch {
    // stdin ended (piped input, Ctrl-D): stop pretending to be interactive instead of dying on a closed reader.
    inputClosed = true;
    logger.warn('stdin closed — using defaults for the remaining questions');
    return fallback ?? '';
  }
};

const askYes = async (rl: Interface, question: string, fallback = true): Promise<boolean> => {
  const answer = (await ask(rl, `${question} (y/n)`, fallback ? 'y' : 'n')).toLowerCase();
  return answer.startsWith('y');
};

const discordError = (status: number): string => {
  if (status === 401) return 'Discord rejected the token (401). Copy it again from the Bot tab — not the OAuth secret.';
  if (status === 403) return 'Discord refused the request (403): the token is valid but not allowed to read this.';
  if (status === 429) return 'Discord is rate limiting this IP (429). Wait a minute and retry.';
  return `Discord answered HTTP ${status}.`;
};

/**
 * Model discovery uses the same pinned binary the bot runs, in a throwaway workspace whose config is rendered
 * by the same code the guild workspaces use — so what the wizard offers is exactly what the server will list.
 */
async function discoverModels(providerId: string): Promise<string[]> {
  const binary = resolve(paths.root, 'node_modules/opencode-ai/bin/opencode.exe');
  if (!existsSync(binary)) return [];

  const dir = mkdtempSync(resolve(paths.data, `.setup-${providerId}-`));
  const xdg = (name: string) => {
    const path = resolve(dir, name);
    mkdirSync(path, { 'recursive': true });
    return path;
  };

  writeFileSync(
    resolve(dir, 'opencode.json'),
    `${JSON.stringify({ '$schema': 'https://opencode.ai/config.json', 'provider': providerConfigBlocks([providerId]) }, null, 2)}\n`,
  );

  try {
    const proc = Bun.spawnSync([binary, 'models'], {
      'cwd': dir,
      'stdout': 'pipe',
      'stderr': 'pipe',
      'env': {
        ...Bun.env,
        'XDG_DATA_HOME': xdg('data'),
        'XDG_STATE_HOME': xdg('state'),
        'XDG_CACHE_HOME': xdg('cache'),
      },
      'timeout': 30_000,
    });
    const output = new TextDecoder().decode(proc.stdout);
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith(`${providerId}/`))
      .map(line => line.slice(providerId.length + 1));
  } catch (error) {
    logger.warn('model discovery failed', { providerId, 'error': String(error).slice(0, 160) });
    return [];
  } finally {
    rmSync(dir, { 'recursive': true, 'force': true });
  }
}

/** Offers the discovered models as numbers and accepts either a number or a literal id. */
const pickModel = async (
  rl: Interface,
  question: string,
  providerId: string,
  models: string[],
  fallback?: string,
): Promise<string> => {
  if (models.length > 0) {
    const shown = models.slice(0, 40);
    logger.info(`${providerId} models:\n${shown.map((model, index) => `  ${index + 1}. ${model}`).join('\n')}`);
    if (models.length > 40) logger.info(`  … and ${models.length - 40} more`);
  }
  const answer = (await ask(rl, question, fallback)).trim();
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= models.length) return `${providerId}/${models[index - 1]}`;
  if (answer.includes('/')) return answer;
  return answer ? `${providerId}/${answer}` : '';
};

type ProviderChoice = { id: string; envKey?: string; key?: string; label: string };

const PROVIDER_MENU: Array<{ id: string; label: string; envKey?: string }> = [
  { 'id': 'opencode-go', 'label': 'OpenCode Go subscription (`bun run auth` already stored a key)' },
  { 'id': 'openai', 'label': 'OpenAI (OPENAI_API_KEY)' },
  { 'id': 'anthropic', 'label': 'Anthropic (ANTHROPIC_API_KEY)' },
  { 'id': 'google', 'label': 'Google Gemini (GOOGLE_GENERATIVE_AI_API_KEY)' },
  { 'id': 'openrouter', 'label': 'OpenRouter (OPENROUTER_API_KEY)' },
  { 'id': 'deepseek', 'label': 'DeepSeek (DEEPSEEK_API_KEY)' },
  { 'id': 'groq', 'label': 'Groq (GROQ_API_KEY)' },
  { 'id': 'xai', 'label': 'xAI (XAI_API_KEY)' },
  { 'id': 'custom', 'label': 'Local / OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, a gateway)' },
];

async function chooseProvider(rl: Interface): Promise<ProviderChoice | undefined> {
  logger.info('which model provider should this bot use?');
  PROVIDER_MENU.forEach((entry, index) => logger.info(`  ${index + 1}. ${entry.label}`));
  const answer = await ask(rl, 'provider number (leave empty to keep the current setup)', '1');
  const index = Number(answer);
  const entry = PROVIDER_MENU[Number.isInteger(index) && index >= 1 ? index - 1 : 0];
  if (!entry) return undefined;

  if (entry.id === 'opencode-go') {
    if (!existsSync(paths.token)) {
      logger.warn('no OpenCode credential stored yet', {
        'hint': 'run `bun run auth` after setup, or paste a key now',
      });
      const key = await ask(rl, 'OPENCODE_GO_API_KEY (leave empty to run `bun run auth` later)');
      if (key.length === 0) return { 'id': entry.id, 'label': entry.label };
      process.env.OPENCODE_GO_API_KEY = key;
      return { 'id': entry.id, 'label': entry.label, 'envKey': 'OPENCODE_GO_API_KEY', key };
    }
    return { 'id': entry.id, 'label': entry.label };
  }

  if (entry.id === 'custom') return configureCustom(rl);

  const spec = CATALOG_PROVIDERS.find(provider => provider.id === entry.id);
  const envKey = spec?.envKeys[0] ?? `${entry.id.toUpperCase()}_API_KEY`;
  const key = await ask(rl, `${envKey}`);
  if (key.length === 0) {
    logger.warn('no key entered; the provider will not be usable until one is set');
    return { 'id': entry.id, 'label': entry.label, 'envKey': envKey };
  }
  process.env[envKey] = key;
  return { 'id': entry.id, 'label': entry.label, envKey, key };
}

/** Writes one entry into `config/providers.json`: the file is user-owned state, so entries are merged. */
async function configureCustom(rl: Interface): Promise<ProviderChoice | undefined> {
  const label = await ask(rl, 'a name for this provider', 'Local');
  const baseUrl = await ask(rl, 'OpenAI-compatible base URL', 'http://127.0.0.1:11434/v1');
  const id =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'local';
  const apiKeyEnv = await ask(rl, 'env variable holding the key (leave empty if none is needed)');
  if (apiKeyEnv.length > 0) {
    const key = await ask(rl, `value for ${apiKeyEnv}`);
    if (key.length > 0) process.env[apiKeyEnv] = key;
  }

  const models = await discoverEndpointModels(baseUrl, apiKeyEnv);
  if (models.length === 0)
    logger.warn('could not list models from that endpoint', {
      'hint': 'start the runtime first, or add `models` by hand to config/providers.json',
    });

  const file = resolve(paths.config, 'providers.json');
  const existing = ((): Record<string, unknown> => {
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  existing[id] = {
    label,
    baseUrl,
    ...(apiKeyEnv.length > 0 ? { 'apiKeyEnv': apiKeyEnv } : {}),
    'models': Object.fromEntries(models.slice(0, 60).map(model => [model, { 'name': model }])),
  };
  writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`);
  logger.info('provider written to config/providers.json', { id, baseUrl, 'models': models.length });

  return { id, 'label': `${label} (${baseUrl})` };
}

/** `/v1/models` is the one endpoint every OpenAI-compatible runtime implements. */
async function discoverEndpointModels(baseUrl: string, apiKeyEnv: string): Promise<string[]> {
  const key = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      'headers': key ? { 'authorization': `Bearer ${key}` } : {},
      'signal': AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .map(entry => entry.id)
      .filter((id): id is string => typeof id === 'string')
      .sort();
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const argv = new Set(process.argv.slice(2));
  assumeYes = argv.has('--yes') || argv.has('-y');
  const rl = createInterface({ 'input': process.stdin, 'output': process.stdout });
  try {
    const resolved = readValues();
    const existing = Object.fromEntries(Object.entries(resolved).map(([key, entry]) => [key, entry.value]));

    /** Writes under the line the value already uses, so an alias never gains a canonical twin. */
    const lineKey = (key: string) => resolved[key]?.lineKey ?? key;
    logger.info('open-discord-agent setup', { 'envFile': envPath });

    const token = await ask(rl, 'Discord bot token (Bot tab → Reset/Copy)', existing.DISCORD_TOKEN ?? undefined);
    if (token.length === 0) throw new Error('a Discord token is required: create one in the Dev Portal → Bot tab');

    const me = await fetch('https://discord.com/api/v10/users/@me', {
      'headers': { 'authorization': `Bot ${token}` },
      'signal': AbortSignal.timeout(10_000),
    });
    if (!me.ok) throw new Error(discordError(me.status) + ' (`GET /users/@me`)');
    const bot = (await me.json()) as { id: string; username: string; discriminator?: string };
    logger.info('✅ token valid', { 'bot': `${bot.username}#${bot.discriminator ?? '0'}`, 'id': bot.id });

    const appResponse = await fetch('https://discord.com/api/v10/applications/@me', {
      'headers': { 'authorization': `Bot ${token}` },
      'signal': AbortSignal.timeout(10_000),
    });
    const app = appResponse.ok ? ((await appResponse.json()) as DiscordApplication) : undefined;
    if (app) {
      const missing = [
        (app.flags & GUILD_MEMBERS_FLAGS) === 0 ? 'Server Members Intent' : '',
        (app.flags & MESSAGE_CONTENT_FLAGS) === 0 ? 'Message Content Intent' : '',
      ].filter(Boolean);
      if (missing.length > 0)
        logger.warn('privileged intents look disabled — enable them in the Dev Portal → Bot tab', { missing });
      else logger.info('✅ privileged intents enabled');
    }

    const clientId = app?.id ?? (await ask(rl, 'application (client) id', existing.DISCORD_CLIENT_ID ?? undefined));
    const ownerId = await ask(
      rl,
      'your Discord user id (owner: bypasses tier checks, owns /enable)',
      existing.OWNER_ID ?? app?.owner?.id,
    );
    if (!/^\d{16,20}$/.test(ownerId))
      logger.warn('that does not look like a snowflake id', {
        'hint': 'Discord → Settings → Advanced → Developer Mode → right-click yourself → Copy User ID',
      });

    const guildId = await ask(
      rl,
      'guild id for instant command registration (leave empty for global commands)',
      existing.DISCORD_DEVELOPMENT_GUILD_ID ?? undefined,
    );

    const provider = await chooseProvider(rl);
    const updates: Record<string, string> = {
      [lineKey('DISCORD_TOKEN')]: token,
      [lineKey('DISCORD_CLIENT_ID')]: clientId,
      [lineKey('OWNER_ID')]: ownerId,
      ...(guildId.length > 0 ? { [lineKey('DISCORD_DEVELOPMENT_GUILD_ID')]: guildId } : {}),
      ...(provider?.envKey && provider.key ? { [provider.envKey]: provider.key } : {}),
    };

    if (provider) {
      const models = await discoverModels(provider.id);
      if (models.length > 0) {
        const primary = await pickModel(
          rl,
          'primary model (number or id, empty keeps the default)',
          provider.id,
          models,
          existing.MODEL_PRIMARY,
        );
        const fast = await pickModel(
          rl,
          'fast model for reflection/memory (number or id, empty keeps the default)',
          provider.id,
          models,
          existing.MODEL_FAST,
        );
        if (primary) updates.MODEL_PRIMARY = primary;
        if (fast) updates.MODEL_FAST = fast;
      } else
        logger.warn('no models discovered — set MODEL_PRIMARY/MODEL_FAST in .env by hand', {
          'example': `${provider.id}/<model-id>`,
        });
    }

    writeValues(updates);
    logger.info('✅ wrote .env', { 'keys': Object.keys(updates).join(', '), 'mode': '0600' });

    process.env.DISCORD_TOKEN = token;
    process.env.DISCORD_CLIENT_ID = clientId;
    process.env.OWNER_ID = ownerId;
    if (guildId.length > 0) process.env.DISCORD_DEVELOPMENT_GUILD_ID = guildId;

    if (!argv.has('--no-deploy') && (await askYes(rl, 'publish the slash commands now?', true))) {
      // deploy.ts imports the decorated commands and reads DISCORD_TOKEN at module load, so it can only be
      // loaded after `.env` has been written and process.env updated — a static import would run too early.
      const { syncCommands } = await import('./commands/deploy.ts');
      await syncCommands({ 'force': true });
    }

    logger.info('next steps');
    logger.info('  1. bun run doctor        # binary, models, token, sandbox, providers');
    logger.info('  2. bun run start         # run the bot');
    logger.info('  3. in your server: /enable (owner), then /ask or mention the bot');
    logger.info('  optional: bun run auth   # OpenCode Go credential (required for the default models)');
  } finally {
    rl.close();
  }
}

await main().catch(error => {
  logger.error('setup failed', { 'error': error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
