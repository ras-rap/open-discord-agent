import { guildEnabled, guildOnly, cooldown } from '@guards/index.ts';
import { services } from '@services/discord/services.ts';
import { EPHEMERAL } from '@utils/constants.ts';
import { log } from '@utils/logger.ts';
import { Discord, Guard, Slash, SlashOption } from 'discordx';

import type { ApplicationCommandOptionType as OptionType, ChatInputCommandInteraction, TextChannel } from 'discord.js';

const logger = log('commands/agent');

@Discord()
export class AgentCommand {
  @Slash({ 'description': 'Ask the agent to do something (code, Discord admin, research)', 'name': 'ask' })
  @Guard(guildOnly, guildEnabled, cooldown(3, 'channel'))
  async ask(
    @SlashOption({
      'description': 'what you want done',
      'name': 'prompt',
      'required': true,
      'type': 3 as OptionType.String,
    })
    prompt: string,
    interaction: ChatInputCommandInteraction,
  ) {
    const { runtime } = services.get();
    if (!interaction.guild || !(interaction.channel instanceof Object) || interaction.channel === null) return;
    await interaction.deferReply({ 'flags': EPHEMERAL });
    await interaction.editReply({ 'content': '🧠 working — progress shows in the channel' });
    await runtime.ask({
      'guildId': interaction.guild.id,
      'guildName': interaction.guild.name,
      'channel': interaction.channel as TextChannel,
      'actorId': interaction.user.id,
      'actorName': interaction.user.username,
      'member': interaction.guild.members.cache.get(interaction.user.id) ?? null,
      'text': prompt,
    });
  }

  @Slash({ 'description': 'Start a fresh conversation in this channel', 'name': 'new' })
  @Guard(guildOnly, guildEnabled)
  async fresh(interaction: ChatInputCommandInteraction) {
    const { runtime } = services.get();
    if (!interaction.guildId || !interaction.guild) return;
    const sessionId = await runtime.reset(
      `${interaction.guildId}:${interaction.channelId}`,
      interaction.guildId,
      interaction.guild.name,
      interaction.channelId,
      interaction.user.id,
    );
    logger.info('session rotated', { 'guildId': interaction.guildId, sessionId });
    await interaction.reply({ 'content': `🆕 new session \`${sessionId}\``, 'flags': EPHEMERAL });
  }

  @Slash({ 'description': 'Stop the agent in this channel', 'name': 'abort' })
  @Guard(guildOnly, guildEnabled)
  async abort(interaction: ChatInputCommandInteraction) {
    const { runtime } = services.get();
    const stopped = await runtime.abort(`${interaction.guildId}:${interaction.channelId}`);
    await interaction.reply({
      'content': stopped ? '🛑 abort sent' : 'nothing running in this channel',
      'flags': EPHEMERAL,
    });
  }
}
