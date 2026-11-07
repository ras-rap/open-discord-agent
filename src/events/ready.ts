import { log } from '@utils/logger.ts';
import { Events } from 'discord.js';
import { Discord, Once } from 'discordx';

import { client } from '@/client.ts';

const logger = log('events/ready');

@Discord()
export class ReadyEvent {
  @Once({ 'event': Events.ClientReady })
  async onReady() {
    logger.info('logged in', { 'user': client.user?.tag, 'guilds': client.guilds.cache.size, 'pid': process.pid });
  }
}
