import { feedback } from '@services/database/sqlite.ts';
import { log } from '@utils/logger.ts';
import { Events } from 'discord.js';
import { Discord, On } from 'discordx';

import type { MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';

import { client } from '@/client.ts';

const logger = log('events/reactions');

const SIGNALS: Record<string, 'positive' | 'negative'> = {
  '👍': 'positive',
  '✅': 'positive',
  '👎': 'negative',
  '❌': 'negative',
};

/**
 * 👍/👎 on the bot's own message is the cheapest quality signal available, and it is the one the reflector
 * reads back. Only reactions on this bot's messages count, and the unique index makes re-adding idempotent.
 */
@Discord()
export class ReactionEvent {
  @On({ 'event': Events.MessageReactionAdd })
  async onReaction([reaction, user]: [MessageReaction | PartialMessageReaction, User | PartialUser]) {
    if (user.bot) return;
    const signal = reaction.emoji.name ? SIGNALS[reaction.emoji.name] : undefined;
    if (!signal) return;

    const message = reaction.message.partial ? await reaction.message.fetch().catch(() => undefined) : reaction.message;
    if (!message || message.author?.id !== client.user?.id) return;
    if (!message.inGuild()) return;

    feedback.record({
      'guild_id': message.guildId,
      'channel_id': message.channelId,
      'message_id': message.id,
      'actor_id': user.id,
      'signal': signal,
      'note': null,
    });
    logger.info('feedback recorded', { 'guildId': message.guildId, signal, 'by': user.id, 'message': message.id });
  }
}
