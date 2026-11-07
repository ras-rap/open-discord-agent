import { config } from "./config.ts";
import { log } from "./log.ts";
import { Runtime } from "./agent/runtime.ts";
import { Supervisor } from "./agent/supervisor.ts";
import { startBridge } from "./bridge/server.ts";
import { attachMessageHandler, createDiscordClient } from "./discord/client.ts";
import { services } from "./discord/services.ts";

const logger = log("boot");

async function main(): Promise<void> {
  const client = createDiscordClient();
  let runtime: Runtime | undefined;
  const supervisor = new Supervisor((guildId, event) => runtime?.handleEvent(guildId, event));
  runtime = new Runtime(client, supervisor);
  services.set({ client, supervisor, runtime });

  const bridge = startBridge(client);
  await supervisor.start();
  attachMessageHandler(client, runtime);

  const shutdown = async (signal: string) => {
    logger.info("shutting down", { signal });
    bridge.stop(true);
    await supervisor.stopAll();
    client.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await client.login(config.discord.token);
  logger.info("bridge listening", { host: config.bridge.host, port: config.bridge.port });
  logger.info("workspaces enabled", { guilds: Object.keys(config.raw()).length });
}

await main().catch((error) => {
  logger.error("boot failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
