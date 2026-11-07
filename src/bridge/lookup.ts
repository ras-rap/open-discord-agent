import { capabilities, type Capability } from "./capabilities.ts";

const table: Record<string, Capability> = Object.fromEntries(capabilities.map((capability) => [capability.name, capability]));

/** Capability lookup by model-facing tool name; throws instead of returning undefined so callers stay simple. */
export function capabilityByName(name: string): Capability {
  const capability = table[name];
  if (!capability) throw new Error(`unknown capability: ${name}`);
  return capability;
}
