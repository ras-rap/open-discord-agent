import { EPHEMERAL } from '@utils/constants.ts';
import { log } from '@utils/logger.ts';
import { Discord, Slash } from 'discordx';

import type { ChatInputCommandInteraction } from 'discord.js';

const logger = log('commands/ping');

@Discord()
export class PingCommand {
  @Slash({ 'description': 'Replies with pong and the interaction latency', 'name': 'ping' })
  async ping(interaction: ChatInputCommandInteraction) {
    const latency = Date.now() - interaction.createdTimestamp;
    const gateway = Math.round(interaction.client.ws.ping);
    logger.info('ping', { latency, gateway, 'guild': interaction.guildId ?? 'dm' });
    await interaction.reply({
      'content': `🏓 pong · interaction ${latency}ms · gateway ${gateway}ms · pid ${process.pid}`,
      'flags': EPHEMERAL,
    });
  }
}
