import { Events, IntentsBitField, Partials, TextChannel } from "discord.js";
import { Client } from "discordx";
import { log } from "../log.ts";
import type { Runtime } from "../agent/runtime.ts";
import { config } from "../config.ts";
import "./commands.ts";

const logger = log("discord");

/** discordx Client: same as discord.js, but it dispatches decorated slash/button handlers. */
export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      IntentsBitField.Flags.Guilds,
      IntentsBitField.Flags.GuildMessages,
      IntentsBitField.Flags.GuildMembers,
      IntentsBitField.Flags.MessageContent,
      IntentsBitField.Flags.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
    silent: false,
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void client.executeInteraction(interaction);
  });

  client.once(Events.ClientReady, async () => {
    logger.info("logged in", { user: client.user?.tag, guilds: client.guilds.cache.size });
    await client.initApplicationCommands();
    logger.info("application commands registered");
  });

  return client;
}

/**
 * A mention or a reply to the bot is a prompt. Guild allowlisting happens before any model call, and the
 * channel must be a normal text channel so the streaming renderer has somewhere to write.
 */
export function attachMessageHandler(client: Client, runtime: Runtime): void {
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.inGuild()) return;
    const mentioned = message.mentions.users.has(client.user?.id ?? "");
    const replied = message.mentions.repliedUser?.id === client.user?.id;
    if (!mentioned && !replied) return;

    const guildConfig = config.guild(message.guildId);
    if (!guildConfig?.enabled) {
      await message.reply("this server is not enabled yet — the owner can run `/enable`").catch(() => undefined);
      return;
    }
    if (!(message.channel instanceof TextChannel)) return;

    const text = message.content
      .replace(new RegExp(`<@!?${client.user?.id}>`, "g"), "")
      .trim();
    if (text.length === 0) {
      await message.reply("what should I do?").catch(() => undefined);
      return;
    }

    await runtime.ask({
      guildId: message.guildId,
      guildName: message.guild?.name ?? "guild",
      channel: message.channel,
      actorId: message.author.id,
      actorName: message.author.username,
      member: message.member,
      text,
    });
  });
}
