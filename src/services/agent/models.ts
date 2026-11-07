import { MODELS } from '@services/config.ts';

/** Static membership table, not a mutable Set: the allowlist is fixed at build time. */
const ALLOWED: Record<string, true> = {
  [MODELS.primary]: true,
  [MODELS.fast]: true,
  [MODELS.jev]: true,
};

export type ModelRef = { providerID: string; modelID: string };

/**
 * Splits `provider/model` on the last slash because model ids can contain slashes.
 * Any model outside the fixed allowlist throws: this bot may only run on crouton/beam/jev.
 */
export function modelRef(id: string): ModelRef {
  if (!ALLOWED[id]) throw new Error(`model ${id} is not allowed; allowed: ${Object.keys(ALLOWED).join(', ')}`);
  const cut = id.lastIndexOf('/');
  if (cut <= 0) throw new Error(`model ${id} must be provider/model`);
  return { 'providerID': id.slice(0, cut), 'modelID': id.slice(cut + 1) };
}

export const models = {
  'primary': () => modelRef(MODELS.primary),
  'fast': () => modelRef(MODELS.fast),
  'jev': MODELS.jev,
  'label': (ref: ModelRef) => `${ref.providerID}/${ref.modelID}`,
};
