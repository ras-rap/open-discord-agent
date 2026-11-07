import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { config, paths } from '@services/config.ts';
import { workspaces } from '@services/database/sqlite.ts';
import { provisionWorkspace } from '@services/workspace/provision.ts';
import { log } from '@utils/logger.ts';

import { assertPinnedBinary } from './binary.ts';
import { Opencode } from './opencode.ts';

import type { AgentEvent } from './events.ts';

const logger = log('supervisor');

export type RunningServer = {
  guildId: string;
  dir: string;
  port: number;
  password: string;
  bridgeToken: string;
  opencode: Opencode;
  lastUsed: number;
  events: (event: AgentEvent) => void;
  eventsAbort: AbortController;
};

const freePort = (): Promise<number> => {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const probe = createServer();
  probe.unref();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    probe.close(() => (port >= 1024 ? resolve(port) : reject(new Error('no free port'))));
  });
  return promise;
};

/**
 * Config, custom tools and permission rules are resolved from a server's own cwd (PLAN.md §0.1), so each
 * guild gets its own `opencode serve` rooted at its workspace, its own port and password, and its own
 * bridge secret. Idle servers are unloaded; sessions live in the shared bot data dir and survive respawns.
 */
export class Supervisor {
  private readonly servers = new Map<string, RunningServer>();
  private readonly binary = resolve(paths.root, 'node_modules/opencode-ai/bin/opencode.exe');
  private reaper?: Timer;

  constructor(private readonly onGuildEvent: (guildId: string, event: AgentEvent) => void) {}

  async start(): Promise<void> {
    await assertPinnedBinary();
    this.reaper = setInterval(() => this.reapIdle(), 5 * 60_000);
  }

  async ensure(guildId: string, guildName: string): Promise<RunningServer> {
    const running = this.servers.get(guildId);
    if (running) {
      running.lastUsed = Date.now();
      return running;
    }

    const workspace = provisionWorkspace(guildId, guildName);
    const port = await freePort();
    const password = crypto.randomUUID().replaceAll('-', '');
    const proc = Bun.spawn([this.binary, 'serve', '--hostname', config.opencode.host, '--port', String(port)], {
      'cwd': workspace.dir,
      'stdout': 'inherit',
      'stderr': 'pipe',
      'env': {
        ...Bun.env,
        'XDG_DATA_HOME': resolve(paths.data, 'opencode/data'),
        'XDG_STATE_HOME': resolve(paths.data, 'opencode/state'),
        'XDG_CACHE_HOME': resolve(paths.data, 'opencode/cache'),
        'OPENCODE_SERVER_PASSWORD': password,
        'BRIDGE_URL': `http://${config.bridge.host}:${config.bridge.port}/rpc`,
        'BRIDGE_TOKEN': workspace.bridgeToken,
        'BRIDGE_GUILD': guildId,
      },
    });

    const opencode = new Opencode(port, password);
    const entry: RunningServer = {
      guildId,
      'dir': workspace.dir,
      port,
      password,
      'bridgeToken': workspace.bridgeToken,
      opencode,
      'lastUsed': Date.now(),
      'events': event => this.onGuildEvent(guildId, event),
      'eventsAbort': new AbortController(),
    };

    const deadline = Date.now() + config.opencode.startupTimeoutMs;
    let health: { healthy: boolean; version: string } | undefined;
    while (Date.now() < deadline) {
      health = await opencode.health().catch(() => undefined);
      if (health?.healthy) break;
      if (proc.exitCode !== null) break;
      await Bun.sleep(150);
    }
    if (!health?.healthy) {
      proc.kill();
      const stderr = (await new Response(proc.stderr).text()).slice(0, 800);
      throw new Error(`opencode server for guild ${guildId} failed to start: ${stderr || 'no health response'}`);
    }
    if (health.version !== config.opencode.version) {
      proc.kill();
      throw new Error(`server reported version ${health.version}, expected ${config.opencode.version}`);
    }

    workspaces.setRuntime(guildId, port, password);
    this.servers.set(guildId, entry);
    opencode.subscribe(entry.events, entry.eventsAbort.signal);
    this.watch(entry, proc);
    logger.info('server up', { guildId, port, 'dir': workspace.dir, 'version': health.version });
    return entry;
  }

  /**
   * stderr must be drained continuously: leaving a pipe unread blocks the child once the OS buffer fills,
   * which shows up as a server that accepts connections and then stalls mid-prompt. Only the tail is kept.
   */
  private watch(entry: RunningServer, proc: Bun.Subprocess): void {
    const tail: string[] = [];
    const stderr = proc.stderr;
    if (stderr instanceof ReadableStream) {
      const reader = stderr.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.decode(value, { 'stream': true }).split('\n')) {
            if (line.trim().length === 0) continue;
            tail.push(line.trim().slice(0, 300));
            if (tail.length > 40) tail.shift();
          }
        }
      })().catch(() => undefined);
    }

    void proc.exited.then(code => {
      logger.warn('server exited', { 'guildId': entry.guildId, code, 'stderr': tail.slice(-8) });
      if (this.servers.get(entry.guildId) === entry) this.servers.delete(entry.guildId);
      workspaces.clearRuntime(entry.guildId);
    });
  }

  get(guildId: string): RunningServer | undefined {
    const entry = this.servers.get(guildId);
    if (entry) entry.lastUsed = Date.now();
    return entry;
  }

  touch(guildId: string): void {
    const entry = this.servers.get(guildId);
    if (entry) entry.lastUsed = Date.now();
  }

  async stop(guildId: string): Promise<void> {
    const entry = this.servers.get(guildId);
    if (!entry) return;
    this.servers.delete(guildId);
    entry.eventsAbort.abort();
    workspaces.clearRuntime(guildId);
    await fetch(`http://127.0.0.1:${entry.port}/instance/dispose`, {
      'method': 'POST',
      'headers': { 'authorization': `Basic ${Buffer.from(`opencode:${entry.password}`).toString('base64')}` },
    }).catch(() => undefined);
    logger.info('server stopped', { guildId });
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [guildId, entry] of this.servers)
      if (now - entry.lastUsed > config.opencode.idleUnloadMs) {
        logger.info('unloading idle server', { guildId, 'idleMinutes': Math.round((now - entry.lastUsed) / 60_000) });
        void this.stop(guildId);
      }
  }

  async stopAll(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.all([...this.servers.keys()].map(guildId => this.stop(guildId)));
  }

  stats(): Array<{ guildId: string; port: number; idleMinutes: number }> {
    const now = Date.now();
    return [...this.servers.values()].map(entry => ({
      'guildId': entry.guildId,
      'port': entry.port,
      'idleMinutes': Math.round((now - entry.lastUsed) / 60_000),
    }));
  }
}
