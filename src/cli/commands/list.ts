import { importx } from '@discordx/importer';
import { DISCORD_CLIENT_ID, DISCORD_TOKEN, IS_PRODUCTION, developmentGuildId } from '@utils/env.ts';
import { log } from '@utils/logger.ts';
import { REST, Routes } from 'discord.js';
import { Client } from 'discordx';

import type { DeployScope } from './registry.ts';

const logger = log('cli/list');

await importx(`${import.meta.dirname}/../../{commands,guards}/**/*.ts`);

const rest = new REST({ 'version': '10' }).setToken(DISCORD_TOKEN);

type NamedCommand = { name: string; json: unknown };

// Discord echoes server-side fields (id, application_id, version, ...) on registered commands, so the diff
// compares only the parts we author.
const canonical = (command: unknown): string => {
  if (typeof command !== 'object' || command === null) return JSON.stringify(command);
  const source = command as Record<string, unknown>;
  const options = Array.isArray(source.options)
    ? source.options
        .map(option => (typeof option === 'object' && option !== null && 'name' in option ? String(option.name) : '?'))
        .sort()
    : [];
  return JSON.stringify({ 'name': source.name, 'description': source.description, options });
};

const toNamed = (raw: unknown): NamedCommand | undefined => {
  if (typeof raw !== 'object' || raw === null || !('name' in raw) || typeof raw.name !== 'string') return undefined;
  return { 'name': raw.name, 'json': raw };
};

export async function list(scopeOverride?: DeployScope): Promise<void> {
  const scope = scopeOverride ?? (IS_PRODUCTION ? 'global' : 'guild');
  const route =
    scope === 'guild'
      ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, developmentGuildId())
      : Routes.applicationCommands(DISCORD_CLIENT_ID);

  const local = Client.applicationCommandSlashes
    .map(command => ({ 'name': command.toJSON().name, 'json': command.toJSON() }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const remotePayload = await rest.get(route).catch(() => []);
  const remote = (Array.isArray(remotePayload) ? remotePayload : [])
    .map(toNamed)
    .filter((entry): entry is NamedCommand => entry !== undefined);

  const remoteByName = new Map(remote.map(entry => [entry.name, entry.json]));
  const localNames = new Set(local.map(entry => entry.name));

  const added = local.filter(entry => !remoteByName.has(entry.name)).map(entry => entry.name);
  const removed = remote.filter(entry => !localNames.has(entry.name)).map(entry => entry.name);
  const modified = local
    .filter(entry => remoteByName.has(entry.name) && canonical(entry.json) !== canonical(remoteByName.get(entry.name)))
    .map(entry => entry.name);
  const unchanged = local
    .filter(entry => remoteByName.has(entry.name) && canonical(entry.json) === canonical(remoteByName.get(entry.name)))
    .map(entry => entry.name);

  logger.info('command diff', { scope, added, removed, modified, unchanged });
  const changes = added.length + removed.length + modified.length;
  logger.info(changes === 0 ? '✅ local and remote commands are in sync' : `${changes} change(s) detected`);
}
