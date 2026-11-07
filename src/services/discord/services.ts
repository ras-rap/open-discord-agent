import { writeDigest } from '@services/memory/inject.ts';
import { memory } from '@services/memory/store.ts';

import type { Runtime } from '@services/agent/runtime.ts';
import type { Supervisor } from '@services/agent/supervisor.ts';
import type { Client } from 'discord.js';

export type Services = {
  client: Client;
  supervisor: Supervisor;
  runtime: Runtime;
  memoryStore: typeof memory;
  writeDigest: typeof writeDigest;
};

/**
 * discordx instantiates decorated classes itself (no constructor arguments), so the wired services are
 * published here once at boot instead of being injected.
 */
let current: Services | undefined;

export const services = {
  'set': (value: Services) => {
    current = value;
  },
  'get': (): Services => {
    if (!current) throw new Error('services not initialised yet');
    return current;
  },
};
