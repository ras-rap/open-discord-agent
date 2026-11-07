import { EPHEMERAL } from '@utils/constants.ts';
import { log } from '@utils/logger.ts';
import { Events } from 'discord.js';
import { Discord, On } from 'discordx';

import type { Interaction } from 'discord.js';

import { client } from '@/client.ts';

const logger = log('events/interaction-create');

/**
 * discordx dispatches decorated handlers; anything that throws before acknowledging leaves Discord showing
 * "The application did not respond" with no trace in our logs. Both failure modes are made visible here:
 * exceptions are logged and reported, and a handler that returns without replying is caught.
 */
@Discord()
export class InteractionCreateEvent {
  @On({ 'event': Events.InteractionCreate })
  async onInteraction([interaction]: [Interaction]) {
    const label = interaction.isChatInputCommand()
      ? `/${interaction.commandName}`
      : interaction.isButton()
        ? `button ${interaction.customId}`
        : `type ${interaction.type}`;
    const latency = Date.now() - interaction.createdTimestamp;
    logger.info('interaction received', { label, 'guild': interaction.guildId ?? 'dm', 'latencyMs': latency });
    if (latency > 2500)
      logger.warn('interaction arrived late; the gateway session is unhealthy', {
        label,
        'latencyMs': latency,
        'hint':
          'Discord expires interactions after 3s. Usual cause: a second process on the same bot token, or a paused/throttled host.',
      });

    try {
      await client.executeInteraction(interaction);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const expired = typeof error === 'object' && error !== null && 'code' in error && error.code === 10062;
      if (expired) {
        logger.error('interaction expired before we could answer', { label, 'latencyMs': latency });
        return;
      }
      logger.error('interaction handler threw', { label, 'error': message.slice(0, 400) });
      if (!interaction.isRepliable()) return;
      const payload = { 'content': `⚠️ internal error: ${message.slice(0, 300)}`, 'flags': EPHEMERAL };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch (nested) {
        logger.error('could not report interaction error', { label, 'error': String(nested).slice(0, 200) });
      }
      return;
    }

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      logger.warn('handler returned without replying', { label });
      await interaction
        .reply({ 'content': '⚠️ handler finished without a reply — check the bot logs', 'flags': EPHEMERAL })
        .catch(() => undefined);
    }
  }
}
