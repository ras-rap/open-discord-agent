import { importx } from '@discordx/importer';
import { DISCORD_CLIENT_ID, DISCORD_TOKEN, IS_PRODUCTION, developmentGuildId } from '@utils/env.ts';
import { log } from '@utils/logger.ts';
import { REST, Routes } from 'discord.js';
import { Client } from 'discordx';

import type { DeployScope } from './registry.ts';
import type { ApplicationCommandDataResolvable } from 'discord.js';

const logger = log('cli/deploy');

await importx(`${import.meta.dirname}/../../{commands,guards}/**/*.ts`);

const rest = new REST({ 'version': '10' }).setToken(DISCORD_TOKEN);

export type DeployFlags = { scope?: DeployScope; force?: boolean };

const resolveScope = (override?: DeployScope): DeployScope => override ?? (IS_PRODUCTION ? 'global' : 'guild');

const routeFor = (scope: DeployScope) =>
  scope === 'guild'
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, developmentGuildId())
    : Routes.applicationCommands(DISCORD_CLIENT_ID);

const labelFor = (scope: DeployScope) => (scope === 'guild' ? `to guild ${developmentGuildId()}` : 'globally');

/**
 * Publishes the decorated commands to exactly one scope. Discord lists global and guild commands as separate
 * entries, so the other scope is cleared — that duplication is what made commands appear twice before.
 */
export async function syncCommands(flags: DeployFlags = {}): Promise<void> {
  const scope = resolveScope(flags.scope);
  const payload = Client.applicationCommandSlashes.map(command =>
    command.toJSON(),
  ) as ApplicationCommandDataResolvable[];
  const otherScope: DeployScope = scope === 'guild' ? 'global' : 'guild';

  try {
    if (!flags.force) {
      const remote = await rest.get(routeFor(scope)).catch(() => undefined);
      if (Array.isArray(remote) && JSON.stringify(remote) === JSON.stringify(payload)) {
        logger.info(`✅ ${payload.length} command(s) already current ${labelFor(scope)}`);
        await rest.put(routeFor(otherScope), { 'body': [] });
        return;
      }
    }
    await rest.put(routeFor(scope), { 'body': payload });
    await rest.put(routeFor(otherScope), { 'body': [] });
    logger.info(`✅ registered ${payload.length} command(s) ${labelFor(scope)} (other scope cleared)`);
  } catch (error) {
    logger.error('failed to register commands', { 'error': String(error).slice(0, 300) });
    throw error;
  }
}
