import { MetadataStorage } from 'discordx';

export type DeployScope = 'guild' | 'global';

/**
 * Finalises decorated metadata: `@SlashOption` and `@SlashGroup` are applied by `build()`, not by importing
 * the decorated modules, so anything that reads a command payload must call this first — otherwise the
 * payload ships `/ask` without its `prompt` argument and `/model current` as a bare top-level command.
 *
 * This must never run at module scope. `main.ts` statically imports `deploy.ts` for boot-time syncing, so a
 * module-scope build would run before `main.ts` imports `events/`: every `@On` handler would then be imported
 * after metadata was finalised and never bound, and the bot would connect and answer nothing at all.
 * `build()` is idempotent, so calling it from `syncCommands()` after `client.build()` has run is a no-op.
 */
export async function buildCommandMetadata(): Promise<void> {
  await MetadataStorage.instance.build();
}
