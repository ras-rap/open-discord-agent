import { MODELS, config } from '@services/config.ts';
import { optionalEnv } from '@utils/env.ts';

import { CATALOG_PROVIDERS, resolveProviders } from './providers.ts';

export type ModelRef = { providerID: string; modelID: string };

export type ModelRole = 'primary' | 'fast';

/**
 * Optional hard lockdown. Unset (the default) means "any model from a provider this deployment is configured
 * for"; set it to a comma-separated list to pin exactly those ids — the old behaviour, now opt-in.
 */
export function modelAllowlist(): string[] {
  return (optionalEnv('MODEL_ALLOWLIST') ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

/** Every provider id this deployment can name: the server catalogue plus `config/providers.json`. */
export function knownProviderIds(): string[] {
  return [...CATALOG_PROVIDERS.map(provider => provider.id), ...resolveProviders().map(entry => entry.id)]
    .filter((id, index, all) => all.indexOf(id) === index)
    .sort();
}

/**
 * Splits `provider/model`. The provider is matched against the known ids rather than against the first or last
 * slash, because model ids themselves contain slashes (`openrouter/anthropic/claude-sonnet-4.5`) while
 * provider ids never do. Anything else — an id outside `MODEL_ALLOWLIST` when one is set, or a provider this
 * deployment cannot reach — throws with the list of what would work.
 */
export function modelRef(id: string): ModelRef {
  const trimmed = id.trim();
  if (!trimmed.includes('/')) throw new Error(`model "${trimmed}" must be provider/model`);
  const known = knownProviderIds();
  const providerID = known
    .filter(candidate => trimmed.startsWith(`${candidate}/`))
    .sort((left, right) => right.length - left.length)[0];

  if (!providerID || providerID.length === trimmed.length - 1) {
    const attempted = trimmed.includes('/') ? trimmed.slice(0, trimmed.indexOf('/')) : trimmed;
    throw new Error(
      `model "${trimmed}": unknown provider "${attempted}". Known: ${known.join(', ')} — ` +
        'add a credential to .env or declare the provider in config/providers.json',
    );
  }

  const allowlist = modelAllowlist();
  if (allowlist.length > 0 && !allowlist.includes(trimmed))
    throw new Error(`model "${trimmed}" is not in MODEL_ALLOWLIST (${allowlist.join(', ')})`);

  return { 'providerID': providerID, 'modelID': trimmed.slice(providerID.length + 1) };
}

/** The id a role resolves to: the guild's `/model` override when set, otherwise the deployment default. */
export function effectiveModel(role: ModelRole, guildId?: string): { id: string; source: 'guild' | 'default' } {
  const override = guildId ? config.guild(guildId)?.model?.[role] : undefined;
  return override ? { 'id': override, 'source': 'guild' } : { 'id': MODELS[role], 'source': 'default' };
}

export const models = {
  'primary': (guildId?: string) => modelRef(effectiveModel('primary', guildId).id),
  'fast': (guildId?: string) => modelRef(effectiveModel('fast', guildId).id),
  'jev': MODELS.jev,
  'label': (ref: ModelRef) => `${ref.providerID}/${ref.modelID}`,
  'providerIds': (guildId?: string): string[] =>
    [effectiveModel('primary', guildId).id, effectiveModel('fast', guildId).id].map(id => modelRef(id).providerID),
};
