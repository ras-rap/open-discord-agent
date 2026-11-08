import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { paths } from '@services/config.ts';
import { consoleToken } from '@services/policy/jev.ts';
import { optionalEnv } from '@utils/env.ts';
import { z } from 'zod';

/**
 * A provider known to the pinned server's own catalogue (models.dev). Declaring one in the workspace config
 * is only ever a credential declaration: the model list comes from the server, so there is nothing to
 * enumerate here.
 *
 * `envKeys` are the exact variable names the server itself looks for (verified against `opencode models`
 * with each one set), so a credential placed in `.env` under a different name would be ignored silently.
 */
export type CatalogProvider = {
  id: string;
  label: string;
  envKeys: string[];
  /** Providers that answer without a credential (free tier / local runtime). */
  keyless?: boolean;
  /** Catalog providers that must be declared explicitly for the server to enumerate their models. */
  declareAlways?: boolean;
};

export const CATALOG_PROVIDERS: readonly CatalogProvider[] = [
  {
    'id': 'opencode-go',
    'label': 'OpenCode Go (subscription)',
    'envKeys': ['OPENCODE_GO_API_KEY'],
    'declareAlways': true,
  },
  { 'id': 'opencode', 'label': 'OpenCode Zen (free tier)', 'envKeys': ['OPENCODE_API_KEY'], 'keyless': true },
  { 'id': 'openai', 'label': 'OpenAI', 'envKeys': ['OPENAI_API_KEY'] },
  { 'id': 'anthropic', 'label': 'Anthropic', 'envKeys': ['ANTHROPIC_API_KEY'] },
  {
    'id': 'google',
    'label': 'Google Gemini',
    'envKeys': ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  },
  { 'id': 'openrouter', 'label': 'OpenRouter', 'envKeys': ['OPENROUTER_API_KEY'] },
  { 'id': 'deepseek', 'label': 'DeepSeek', 'envKeys': ['DEEPSEEK_API_KEY'] },
  { 'id': 'groq', 'label': 'Groq', 'envKeys': ['GROQ_API_KEY'] },
  { 'id': 'mistral', 'label': 'Mistral', 'envKeys': ['MISTRAL_API_KEY'] },
  { 'id': 'xai', 'label': 'xAI', 'envKeys': ['XAI_API_KEY'] },
  { 'id': 'cerebras', 'label': 'Cerebras', 'envKeys': ['CEREBRAS_API_KEY'] },
  { 'id': 'togetherai', 'label': 'Together AI', 'envKeys': ['TOGETHER_API_KEY', 'TOGETHERAI_API_KEY'] },
];

const COMPATIBLE_NPM = '@ai-sdk/openai-compatible';

/**
 * A provider that is not in the server's catalogue (a local runtime, a gateway, an internal endpoint).
 * `apiKeyEnv` names the variable holding the key instead of the key itself: the rendered workspace config is
 * a git repository, so no credential may ever be written into it.
 */
const CompatibleModel = z.object({
  'name': z.string().optional(),
  'reasoning': z.boolean().optional(),
  'toolCall': z.boolean().optional(),
  'attachment': z.boolean().optional(),
  'contextLimit': z.number().int().positive().optional(),
  'outputLimit': z.number().int().positive().optional(),
});

const CompatibleProvider = z.object({
  'label': z.string().min(1),
  'baseUrl': z.string().url(),
  'npm': z.string().default(COMPATIBLE_NPM),
  'apiKeyEnv': z.string().min(1).optional(),
  'models': z.record(z.string(), CompatibleModel).default({}),
  'headers': z.record(z.string(), z.string()).default({}),
});

const ProvidersFile = z.record(z.string().min(1), CompatibleProvider);

export type CompatibleModelSpec = z.infer<typeof CompatibleModel>;
export type CompatibleProviderSpec = z.infer<typeof CompatibleProvider>;

export type ProviderEntry = {
  id: string;
  label: string;
  source: 'catalog' | 'config';
  /** Set when a credential exists, so the workspace config can reference it by name. */
  keyEnv?: string;
  keyed: boolean;
  keyless: boolean;
  npm: string;
  baseUrl?: string;
  models: Record<string, CompatibleModelSpec>;
  headers: Record<string, string>;
};

/** `PROVIDERS_FILE` exists so a deployment (and the provider tests) can point at a different registry. */
export const providersFilePath = () => optionalEnv('PROVIDERS_FILE') ?? resolve(paths.config, 'providers.json');

export const providersExampleFile = resolve(paths.config, 'providers.example.json');

/**
 * Missing file means "no extra providers", which is the default deployment; a malformed file is an error
 * rather than a silently ignored one, because the models it declares are what `/model` offers.
 */
export function readCompatibleProviders(): Record<string, CompatibleProviderSpec> {
  const file = providersFilePath();
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`config/providers.json is not valid JSON: ${String(error).slice(0, 160)}`);
  }
  const parsed = ProvidersFile.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `config/providers.json invalid: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );

  return parsed.data;
}

/** The name of the variable that holds `provider`'s credential, independent of whether one is set. */
const keyEnvName = (provider: CatalogProvider): string | undefined => {
  // Go's key is stored by `bun run auth` and injected by the supervisor under the name the server expects.
  if (provider.id === 'opencode-go' && !optionalEnv('OPENCODE_GO_API_KEY') && consoleToken())
    return 'OPENCODE_GO_API_KEY';
  const set = provider.envKeys.find(key => optionalEnv(key) !== undefined);
  return set ?? provider.envKeys[0];
};

/**
 * Every provider this deployment could name: the whole catalogue (a credential is reported, not required —
 * role models may name one before its key exists) plus whatever `config/providers.json` declares. Role models
 * are resolved against this set, so a typo in a provider id fails at boot instead of at the first prompt.
 */
export function resolveProviders(): ProviderEntry[] {
  const entries: ProviderEntry[] = [];

  for (const provider of CATALOG_PROVIDERS)
    entries.push({
      'id': provider.id,
      'label': provider.label,
      'source': 'catalog',
      'keyEnv': keyEnvName(provider),
      'keyed':
        provider.envKeys.some(key => optionalEnv(key) !== undefined) ||
        (provider.id === 'opencode-go' && Boolean(consoleToken())),
      'keyless': provider.keyless === true,
      'npm': '',
      'models': {},
      'headers': {},
    });

  for (const [id, spec] of Object.entries(readCompatibleProviders())) {
    if (CATALOG_PROVIDERS.some(provider => provider.id === id))
      throw new Error(
        `config/providers.json: "${id}" is a built-in provider id; use another id or set its key in .env`,
      );
    const keyed = spec.apiKeyEnv ? optionalEnv(spec.apiKeyEnv) !== undefined : false;
    entries.push({
      id,
      'label': spec.label,
      'source': 'config',
      'keyEnv': spec.apiKeyEnv,
      keyed,
      'keyless': spec.apiKeyEnv === undefined,
      'npm': spec.npm,
      'baseUrl': spec.baseUrl,
      'models': spec.models,
      'headers': spec.headers,
    });
  }

  return entries;
}

/** Exported name is the seam the model resolver and the doctor both validate against. */
export const isCatalogProvider = (id: string) => CATALOG_PROVIDERS.some(provider => provider.id === id);

export type ProviderConfigBlock = {
  name?: string;
  npm?: string;
  options?: { apiKey?: string; baseURL?: string; headers?: Record<string, string> };
  models?: Record<string, unknown>;
};

/** snake_case because that is the shape the pinned server parses for `provider.*.models`. */
const modelBlock = (spec: CompatibleModelSpec): Record<string, unknown> => ({
  'name': spec.name,
  ...(spec.reasoning === undefined ? {} : { 'reasoning': spec.reasoning }),
  ...(spec.toolCall === undefined ? {} : { 'tool_call': spec.toolCall }),
  ...(spec.attachment === undefined ? {} : { 'attachment': spec.attachment }),
  ...(spec.contextLimit === undefined && spec.outputLimit === undefined
    ? {}
    : {
        'limit': {
          ...(spec.contextLimit ? { 'context': spec.contextLimit } : {}),
          ...(spec.outputLimit ? { 'output': spec.outputLimit } : {}),
        },
      }),
});

/**
 * Renders the `provider` block of the workspace config. Credentials are referenced as `{env:NAME}` so the
 * workspace repository (committed every turn, pushed nowhere but still a git repo) never contains a secret.
 *
 * `usedIds` are the providers named by the active role models; they are declared even without a credential so
 * a missing key surfaces as the provider's own auth error instead of "provider not found".
 */
export function providerConfigBlocks(usedIds: readonly string[] = []): Record<string, ProviderConfigBlock> {
  const blocks: Record<string, ProviderConfigBlock> = {};

  for (const entry of resolveProviders()) {
    const used = usedIds.includes(entry.id);
    if (!entry.keyed && !entry.keyless && !used) continue;
    if (entry.source === 'catalog') {
      if (!entry.keyEnv) continue;
      // The catalogue block only ever needs the key; its models come from the server itself.
      blocks[entry.id] = { 'options': { 'apiKey': `{env:${entry.keyEnv}}` } };
      continue;
    }
    blocks[entry.id] = {
      'name': entry.label,
      'npm': entry.npm,
      'options': {
        'baseURL': entry.baseUrl ?? '',
        ...(entry.keyEnv ? { 'apiKey': `{env:${entry.keyEnv}}` } : {}),
        ...(Object.keys(entry.headers).length > 0 ? { 'headers': entry.headers } : {}),
      },
      ...(Object.keys(entry.models).length > 0
        ? { 'models': Object.fromEntries(Object.entries(entry.models).map(([id, spec]) => [id, modelBlock(spec)])) }
        : {}),
    };
  }

  return blocks;
}

export type ProviderSummary = {
  id: string;
  label: string;
  source: 'catalog' | 'config';
  ready: boolean;
  /** Variable the credential belongs in, or undefined for keyless providers. */
  keyEnv?: string;
  models: string[];
};

/** What `doctor`, `/status`, and `bun run setup` report: one row per reachable provider. */
export function providerSummary(): ProviderSummary[] {
  return resolveProviders().map(entry => ({
    'id': entry.id,
    'label': entry.label,
    'source': entry.source,
    'ready': entry.keyed || entry.keyless,
    'keyEnv': entry.keyEnv,
    'models': Object.keys(entry.models),
  }));
}

/** Providers whose credential exists and that the roles may therefore use. */
export const readyProviderIds = () =>
  resolveProviders()
    .filter(entry => entry.keyed || entry.keyless)
    .map(entry => entry.id);
