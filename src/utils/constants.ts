import { GatewayIntentBits, Partials } from 'discord.js';

export const DEFAULT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.DirectMessages,
] as const;

export const DEFAULT_PARTIALS = [Partials.Message, Partials.Channel, Partials.User] as const;

/** Colour used by every informational embed so the bot looks consistent. */
export const BRAND_COLOR = 0x5865f2;

/** discord.js 14.28 rejects the numeric enum in , so the string form is the portable spelling. */
export const EPHEMERAL = ['Ephemeral'] as const;
