import { Events, IntentsBitField, Partials, TextChannel, type ApplicationCommandDataResolvable } from "discord.js";
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

  /**
   * discordx dispatches decorated handlers; anything that throws before acknowledging leaves Discord showing
   * "The application did not respond" with no trace in our logs. Both failure modes are made visible here:
   * exceptions are logged and reported to the user, and a handler that returns without replying is caught.
   */
  client.on(Events.InteractionCreate, async (interaction) => {
    const label = interaction.isChatInputCommand()
      ? `/${interaction.commandName}`
      : interaction.isButton()
        ? `button ${interaction.customId}`
        : `type ${interaction.type}`;
    logger.info("interaction received", { label, guild: interaction.guildId ?? "dm" });
    try {
      await client.executeInteraction(interaction);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("interaction handler threw", { label, error: message.slice(0, 400) });
      if (!interaction.isRepliable()) return;
      const payload = { content: `⚠️ internal error: ${message.slice(0, 300)}`, flags: ["Ephemeral"] as const };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch (nested) {
        logger.error("could not report interaction error", { label, error: String(nested).slice(0, 200) });
      }
      return;
    }

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      logger.warn("handler returned without replying", { label, guild: interaction.guildId ?? "dm" });
      await interaction
        .reply({ content: "⚠️ handler finished without a reply — check the bot logs", flags: ["Ephemeral"] as const })
        .catch(() => undefined);
    }
  });

  client.once(Events.ClientReady, async () => {
    logger.info("logged in", { user: client.user?.tag, guilds: client.guilds.cache.size });
    await client.initApplicationCommands();
    logger.info("application commands registered");

    // Global commands can take up to an hour to reach a client's cache, which shows up as a command that
    // "does not respond". Setting REGISTER_GUILD_ID mirrors them into that guild immediately.
    const guildId = Bun.env.REGISTER_GUILD_ID;
    if (guildId && client.application) {
      try {
        const global = await client.application.commands.fetch();
        const guild = await client.guilds.fetch(guildId);
        // discord.js types toJSON() as unknown; the payload is the same shape the REST call expects.
        const payload = [...global.values()].map((command) => command.toJSON() as ApplicationCommandDataResolvable);
        await guild.commands.set(payload);
        logger.info("guild-scoped commands published", { guild: guild.name, count: global.size });
      } catch (error) {
        logger.warn("could not publish guild-scoped commands", { error: String(error).slice(0, 200) });
      }
    }
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
