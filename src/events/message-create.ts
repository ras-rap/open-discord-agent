import { config } from '@services/config.ts';
import { services } from '@services/discord/services.ts';
import { log } from '@utils/logger.ts';
import { Events, MessageFlags } from 'discord.js';
import { Discord, On } from 'discordx';

import type { Message, TextChannel } from 'discord.js';

import { client } from '@/client.ts';

const logger = log('events/message-create');

/**
 * A mention or a reply to the bot is a prompt. Guild enablement is checked before any model call, and the
 * channel must be a plain text channel so the streaming renderer has somewhere to write.
 */
@Discord()
export class MessageCreateEvent {
  @On({ 'event': Events.MessageCreate })
  async onMessage([message]: [Message]) {
    if (message.author.bot || !message.inGuild()) return;
    const mentioned = message.mentions.users.has(client.user?.id ?? '');
    const replied = message.mentions.repliedUser?.id === client.user?.id;
    if (!mentioned && !replied) return;

    if (!config.guild(message.guildId)?.enabled) {
      await message.reply('this server is not enabled yet — the owner can run `/enable`').catch(() => undefined);
      return;
    }
    if (!(message.channel instanceof Object) || message.channel === null) return;

    const text = message.content.replace(new RegExp(`<@!?${client.user?.id}>`, 'g'), '').trim();
    if (text.length === 0) {
      await message.reply('what should I do?').catch(() => undefined);
      return;
    }

    logger.info('prompt via mention', { 'guild': message.guildId, 'author': message.author.id, 'length': text.length });
    await services.get().runtime.ask({
      'guildId': message.guildId,
      'guildName': message.guild?.name ?? 'guild',
      'channel': message.channel as TextChannel,
      'actorId': message.author.id,
      'actorName': message.author.username,
      'member': message.member,
      text,
    });
    void MessageFlags;
  }
}
