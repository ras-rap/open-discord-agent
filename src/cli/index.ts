import { log } from '@utils/logger.ts';

import type { DeployScope } from './commands/registry.ts';

const logger = log('cli');

const SUBCOMMANDS = ['setup', 'deploy', 'clear', 'list', 'auth', 'doctor', 'smoke', 'e2e', 'backup'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const printUsage = () => {
  logger.info('Usage: bun run commands <subcommand> [--global|--guild] [--force]');
  logger.info('  setup    interactive: validate the token, choose a provider, write .env, deploy commands');
  logger.info('  deploy   publish slash commands (default: guild in development, global in production)');
  logger.info('  clear    remove registered commands from the resolved scope');
  logger.info('  list     diff local commands against the registered ones');
  logger.info('  auth     store the OpenCode credential that Jev accepts');
  logger.info('  doctor   preflight: binary, models, token, docker, clock skew, capabilities');
  logger.info('  smoke    offline end-to-end: spawn a server, prompt, stream, permission round-trip, jev');
  logger.info(
    '  e2e      live end-to-end: model calls a Discord tool through the bridge (--write for structural tools)',
  );
  logger.info('  backup   consistent SQLite snapshot into .data/backups (keeps the last 14)');
};

const [subcommand, ...args] = process.argv.slice(2);

if (!subcommand || !(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
  printUsage();
  process.exit(subcommand ? 1 : 0);
}

const hasFlag = (flag: '--global' | '--guild' | '--force') => args.includes(flag);

if (hasFlag('--global') && hasFlag('--guild')) {
  logger.error('cannot specify both --global and --guild');
  process.exit(1);
}

const scope: DeployScope | undefined = hasFlag('--global') ? 'global' : hasFlag('--guild') ? 'guild' : undefined;
const force = hasFlag('--force');

const run = async (name: Subcommand) => {
  switch (name) {
    case 'setup':
      await import('./setup.ts');
      break;
    case 'deploy': {
      const { syncCommands } = await import('./commands/deploy.ts');
      await syncCommands({ scope, force });
      break;
    }
    case 'clear': {
      const { clear } = await import('./commands/clear.ts');
      await clear(scope);
      break;
    }
    case 'list': {
      const { list } = await import('./commands/list.ts');
      await list(scope);
      break;
    }
    case 'auth':
      await import('./auth.ts');
      break;
    case 'doctor':
      await import('./doctor.ts');
      break;
    case 'smoke':
      await import('./smoke.ts');
      break;
    case 'e2e':
      await import('./e2e.ts');
      break;
    case 'backup': {
      const { backup } = await import('./backup.ts');
      await backup();
      process.exit(0);
    }
  }
};

await run(subcommand as Subcommand);
