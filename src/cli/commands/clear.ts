import { DISCORD_CLIENT_ID, DISCORD_TOKEN, IS_PRODUCTION, developmentGuildId } from '@utils/env.ts';
import { log } from '@utils/logger.ts';
import { REST, Routes } from 'discord.js';

import type { DeployScope } from './registry.ts';

const logger = log('cli/clear');
const rest = new REST({ 'version': '10' }).setToken(DISCORD_TOKEN);

export async function clear(scopeOverride?: DeployScope): Promise<void> {
  const scope = scopeOverride ?? (IS_PRODUCTION ? 'global' : 'guild');
  const route =
    scope === 'guild'
      ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, developmentGuildId())
      : Routes.applicationCommands(DISCORD_CLIENT_ID);
  try {
    await rest.put(route, { 'body': [] });
    logger.info(`✅ cleared all commands ${scope === 'guild' ? `from guild ${developmentGuildId()}` : 'globally'}`);
  } catch (error) {
    logger.error('failed to clear commands', { 'error': String(error).slice(0, 300) });
  }
}
