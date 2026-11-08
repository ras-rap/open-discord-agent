import { importx } from '@discordx/importer';
import { describe, expect, test } from 'bun:test';
import { Client, MetadataStorage } from 'discordx';

/** discordx keeps the handler→instance binding only on its internal metadata, so this one read needs a cast. */
type BoundHandler = { name?: string; identity?: string; discord?: unknown };

const handlers = () => (MetadataStorage.instance as unknown as { events: BoundHandler[] }).events;

/**
 * Regression: `main.ts` statically imports `@cli/commands/deploy.ts` for boot-time command syncing, so that
 * module's top-level code runs *before* `main.ts` imports `events/`. When the deploy CLI finalised metadata at
 * module scope, every `@On` handler was imported after metadata was built, never got bound to a discord
 * instance, and the bot connected to the gateway and answered nothing — commands, mentions, all of it.
 */
describe('boot wiring', () => {
  test('handlers imported after the deploy CLI are still bound once the client builds', async () => {
    // Exactly main.ts's order: the deploy CLI first, then the rest of the decorations.
    await import('@cli/commands/deploy.ts');
    const root = import.meta.dirname.replace(/tests$/, 'src');
    await importx(`${root}/{commands,events,guards}/**/*.ts`);

    const client = new Client({ 'intents': 0 });
    await client.build();

    expect(handlers().length).toBeGreaterThan(0);
    const unbound = handlers()
      .filter(handler => handler.discord === undefined)
      .map(handler => handler.name ?? handler.identity ?? 'unknown');
    expect(unbound).toEqual([]);

    // The same ordering must also keep the command payloads: options and slash groups are applied by build().
    const ask = Client.applicationCommandSlashes.find(command => command.toJSON().name === 'ask');
    expect(ask?.toJSON().options?.map(option => option.name)).toContain('prompt');
    const model = Client.applicationCommandSlashes.find(command => command.toJSON().name === 'model');
    expect(model?.toJSON().options?.map(option => option.name)).toEqual(
      expect.arrayContaining(['current', 'list', 'reset', 'set']),
    );
  });
});
