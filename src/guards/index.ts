import { config } from '@services/config.ts';
import { tierOf } from '@services/policy/gate.ts';
import { EPHEMERAL } from '@utils/constants.ts';
import { OWNER_ID } from '@utils/env.ts';

import type { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import type { Client, GuardFunction, Next } from 'discordx';

type CooldownScope = 'user' | 'guild' | 'channel' | 'global';

/** @internal exported for tests — reset between runs. */
export const cooldowns = new Map<string, number>();

export const cooldown =
  (seconds: number, scope: CooldownScope = 'user'): GuardFunction =>
  async (interaction: ChatInputCommandInteraction, _client: Client, next: Next) => {
    let key: string;
    switch (scope) {
      case 'user':
        key = `${interaction.user.id}-${interaction.commandName}`;
        break;
      case 'guild':
        key = interaction.guildId
          ? `guild-${interaction.guildId}-${interaction.commandName}`
          : `dm-${interaction.user.id}`;
        break;
      case 'channel':
        key = `channel-${interaction.channelId}-${interaction.commandName}`;
        break;
      case 'global':
        key = `global-${interaction.commandName}`;
        break;
    }
    const now = Date.now();
    const until = cooldowns.get(key);
    if (until !== undefined && now < until) {
      const left = Math.ceil((until - now) / 1000);
      await interaction.reply({
        'content': `Please wait ${left}s before using this command again.`,
        'flags': EPHEMERAL,
      });
      return;
    }
    cooldowns.set(key, now + seconds * 1000);
    setTimeout(() => cooldowns.delete(key), seconds * 1000);
    return next();
  };

export const guildOnly: GuardFunction = async (
  interaction: ChatInputCommandInteraction,
  _client: Client,
  next: Next,
) => {
  if (interaction.guild !== null) return next();
  await interaction.reply({ 'content': 'This command can only be used in servers.', 'flags': EPHEMERAL });
  return;
};

export const ownerOnly: GuardFunction = async (
  interaction: ChatInputCommandInteraction,
  _client: Client,
  next: Next,
) => {
  if (interaction.user.id === OWNER_ID) return next();
  await interaction.reply({ 'content': 'Only the bot owner can use this command.', 'flags': EPHEMERAL });
  return;
};

/** Every agent command requires the guild to be enabled in config/guilds.json (see /enable). */
export const guildEnabled: GuardFunction = async (
  interaction: ChatInputCommandInteraction,
  _client: Client,
  next: Next,
) => {
  if (interaction.guildId && config.guild(interaction.guildId)?.enabled) return next();
  await interaction.reply({
    'content': 'This server is not enabled yet — the owner can run `/enable`.',
    'flags': EPHEMERAL,
  });
  return;
};

/** Guild managers and above: the rank the bridge gate requires for destructive actions. */
export const managerOnly: GuardFunction = async (
  interaction: ChatInputCommandInteraction,
  _client: Client,
  next: Next,
) => {
  const member = interaction.member as GuildMember | null;
  if (tierOf(interaction.guildId ?? '', member) >= 3) return next();
  await interaction.reply({
    'content': 'This needs an admin (or the bot owner).',
    'flags': EPHEMERAL,
  });
  return;
};
