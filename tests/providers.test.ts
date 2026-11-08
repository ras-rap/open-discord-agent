import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { modelAllowlist, modelRef, knownProviderIds } from '@services/agent/models.ts';
import { providerConfigBlocks, providerSummary, resolveProviders } from '@services/agent/providers.ts';
import { afterEach, describe, expect, test } from 'bun:test';

/**
 * Every function here reads `PROVIDERS_FILE` and the credential variables when it is called, so a test can
 * point the registry at its own file and set its own keys without touching the host's configuration.
 */
const tempDirs: string[] = [];
const saved = new Map<string, string | undefined>();

const useEnv = (key: string, value: string | undefined): void => {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const useProviders = (contents: unknown): void => {
  const dir = mkdtempSync(resolve(tmpdir(), 'oda-providers-'));
  tempDirs.push(dir);
  const file = resolve(dir, 'providers.json');
  writeFileSync(file, JSON.stringify(contents));
  useEnv('PROVIDERS_FILE', file);
};

afterEach(() => {
  for (const [key, value] of saved)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;

  saved.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { 'recursive': true, 'force': true });
});

describe('workspace provider config', () => {
  test('a catalogue credential is referenced by name, never inlined', () => {
    useEnv('OPENAI_API_KEY', 'sk-live-should-not-appear');
    const blocks = providerConfigBlocks([]);

    expect(blocks.openai?.options?.apiKey).toBe('{env:OPENAI_API_KEY}');
    expect(JSON.stringify(blocks)).not.toContain('sk-live-should-not-appear');
  });

  test('a role provider is declared without a credential so its own auth error surfaces', () => {
    useEnv('OPENROUTER_API_KEY', undefined);
    expect(providerConfigBlocks(['openrouter']).openrouter).toEqual({
      'options': { 'apiKey': '{env:OPENROUTER_API_KEY}' },
    });
    expect(providerConfigBlocks([]).openrouter).toBeUndefined();
  });

  test('an OpenAI-compatible provider renders npm, baseURL and snake_case model fields', () => {
    useEnv('PROVIDERS_FILE', undefined);
    useProviders({
      'local': {
        'label': 'Local runtime',
        'baseUrl': 'http://127.0.0.1:11434/v1',
        'models': { 'qwen3-coder': { 'name': 'Qwen3 Coder', 'toolCall': true, 'contextLimit': 262144 } },
      },
    });

    expect(providerConfigBlocks([]).local).toEqual({
      'name': 'Local runtime',
      'npm': '@ai-sdk/openai-compatible',
      'options': { 'baseURL': 'http://127.0.0.1:11434/v1' },
      'models': {
        'qwen3-coder': { 'name': 'Qwen3 Coder', 'tool_call': true, 'limit': { 'context': 262144 } },
      },
    });
  });

  test('a declared provider whose key variable is empty is reported as not ready', () => {
    useProviders({
      'gateway': { 'label': 'Gateway', 'baseUrl': 'https://gw.example/v1', 'apiKeyEnv': 'ODA_TEST_GATEWAY_KEY' },
    });
    useEnv('ODA_TEST_GATEWAY_KEY', undefined);

    const summary = providerSummary().find(entry => entry.id === 'gateway');
    expect(summary?.ready).toBe(false);
    expect(summary?.keyEnv).toBe('ODA_TEST_GATEWAY_KEY');
  });

  test('reusing a built-in provider id is rejected', () => {
    useProviders({ 'openai': { 'label': 'Shadowed', 'baseUrl': 'https://example.com/v1' } });
    expect(() => resolveProviders()).toThrow(/built-in provider id/);
  });
});

describe('model refs', () => {
  test('matches the longest known provider id, because model ids contain slashes', () => {
    useProviders({});
    expect(modelRef('opencode-go/crouton-alpha-free')).toEqual({
      'providerID': 'opencode-go',
      'modelID': 'crouton-alpha-free',
    });
    expect(modelRef('openrouter/anthropic/claude-sonnet-4.5')).toEqual({
      'providerID': 'openrouter',
      'modelID': 'anthropic/claude-sonnet-4.5',
    });
  });

  test('an id without a provider is rejected', () => {
    expect(() => modelRef('crouton-alpha-free')).toThrow(/must be provider\/model/);
  });

  test('an unknown provider is rejected and the known ones are listed', () => {
    useProviders({});
    expect(() => modelRef('opengai/gpt-5')).toThrow(/unknown provider "opengai"/);
    expect(knownProviderIds()).toContain('opencode-go');
  });

  test('MODEL_ALLOWLIST pins the deployment when it is set', () => {
    useProviders({});
    useEnv('MODEL_ALLOWLIST', 'opencode-go/beam-free, opencode-go/crouton-alpha-free');
    expect(modelAllowlist()).toEqual(['opencode-go/beam-free', 'opencode-go/crouton-alpha-free']);
    expect(() => modelRef('openai/gpt-5')).toThrow(/MODEL_ALLOWLIST/);
    expect(modelRef('opencode-go/beam-free').modelID).toBe('beam-free');
  });

  test('no allowlist means any model from a known provider is accepted', () => {
    useProviders({});
    useEnv('MODEL_ALLOWLIST', undefined);
    expect(modelAllowlist()).toEqual([]);
    expect(modelRef('openai/gpt-5').providerID).toBe('openai');
  });
});
