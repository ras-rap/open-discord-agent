import { syncCommands } from '@cli/commands/deploy.ts';
import { importx } from '@discordx/importer';
import { Runtime } from '@services/agent/runtime.ts';
import { Supervisor } from '@services/agent/supervisor.ts';
import { startBridge } from '@services/bridge/server.ts';
import { services } from '@services/discord/services.ts';
import { writeDigest } from '@services/memory/inject.ts';
import { memory } from '@services/memory/store.ts';
import { AUTO_REGISTER_COMMANDS, DISCORD_TOKEN, IS_PRODUCTION, NODE_ENV, assertRuntimeEnv } from '@utils/env.ts';
import { acquireInstanceLock } from '@utils/instance-lock.ts';
import { log } from '@utils/logger.ts';
import { Scheduler } from '@workers/scheduler.ts';

import { client } from '@/client.ts';

const logger = log('main');

async function main() {
  assertRuntimeEnv();
  acquireInstanceLock();

  // Decorated classes are discovered from disk, so new commands/events/guards need no registration step.
  await importx(`${import.meta.dirname}/{commands,events,guards}/**/*.ts`);
  await client.build();

  const holder: { runtime?: Runtime } = {};
  const supervisor = new Supervisor((guildId, event) => holder.runtime?.handleEvent(guildId, event));
  const runtime = new Runtime(client, supervisor);
  holder.runtime = runtime;
  services.set({ client, supervisor, runtime, 'memoryStore': memory, writeDigest });

  const bridge = startBridge(client);
  await supervisor.start();
  const scheduler = new Scheduler(supervisor);
  scheduler.start();
  logger.info('runtime ready', { 'env': NODE_ENV, 'production': IS_PRODUCTION, 'bridge': bridge.port ?? 0 });

  if (AUTO_REGISTER_COMMANDS) await syncCommands();

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    bridge.stop(true);
    scheduler.stop();
    await supervisor.stopAll();
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(DISCORD_TOKEN);
}

await main().catch(error => {
  logger.error('failed to start bot', { 'error': error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
