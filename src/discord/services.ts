import type { Client } from "discord.js";
import type { Runtime } from "../agent/runtime.ts";
import type { Supervisor } from "../agent/supervisor.ts";

export type Services = { client: Client; supervisor: Supervisor; runtime: Runtime };

/**
 * discordx instantiates decorated classes itself (no constructor arguments), so the wired services are
 * published here once at boot instead of being injected.
 */
let current: Services | undefined;

export const services = {
  set: (value: Services) => {
    current = value;
  },
  get: (): Services => {
    if (!current) throw new Error("services not initialised yet");
    return current;
  },
};
