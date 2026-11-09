import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { Runtime } from '@services/agent/runtime.ts';
import { capabilityByName } from '@services/bridge/lookup.ts';
import { guildDefaults, type GuildSettings } from '@services/config.ts';
import { audit, sessions } from '@services/database/sqlite.ts';
import { ceilingFor, decide, vibeVerdict } from '@services/policy/gate.ts';
import {
  defaultFor,
  describeSetting,
  parseSetting,
  readSetting,
  setSetting,
  settingByPath,
  SETTINGS,
} from '@services/policy/settings.ts';
import { afterEach, describe, expect, test } from 'bun:test';

/** `GUILDS_FILE` is read per call, so each test can own the guild registry without touching config/. */
const tempDirs: string[] = [];
const savedGuildsFile = process.env.GUILDS_FILE;

const useGuilds = (guilds: Record<string, unknown>): void => {
  const dir = mkdtempSync(resolve(tmpdir(), 'oda-guilds-'));
  tempDirs.push(dir);
  const file = resolve(dir, 'guilds.json');
  writeFileSync(file, JSON.stringify(guilds));
  process.env.GUILDS_FILE = file;
};

afterEach(() => {
  if (savedGuildsFile === undefined) delete process.env.GUILDS_FILE;
  else process.env.GUILDS_FILE = savedGuildsFile;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { 'recursive': true, 'force': true });
});

const policyWith = (overrides: Partial<GuildSettings['policy']>): GuildSettings['policy'] => ({
  ...guildDefaults().policy,
  ...overrides,
});

describe('setting registry', () => {
  test('every path is unique and every scope is one of the two known ones', () => {
    const paths = SETTINGS.map(setting => setting.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(SETTINGS.every(setting => setting.scope === 'owner' || setting.scope === 'admin')).toBe(true);
  });

  test('safety-critical keys are bot-owner only', () => {
    // Anything that widens what the agent may do to the machine or the server belongs to the owner alone.
    for (const path of [
      'shell.mode',
      'shell.fallback',
      'policy.tools.allow',
      'roles.admin',
      'policy.matrix.member.destructive',
    ])
      expect(settingByPath(path)?.scope).toBe('owner');
    // Feel-and-coordination knobs stay with guild admins.
    for (const path of ['policy.mode', 'policy.vibe.maxRisk', 'model.primary', 'policy.tools.deny'])
      expect(settingByPath(path)?.scope).toBe('admin');
  });

  test('every rank × risk cell is addressable', () => {
    expect(settingByPath('policy.matrix.guest.read')).toBeDefined();
    expect(settingByPath('policy.matrix.owner.admin')).toBeDefined();
    expect(SETTINGS.filter(setting => setting.path.startsWith('policy.matrix.'))).toHaveLength(20);
  });

  test('parsing rejects nonsense before anything is written', () => {
    expect(parseSetting('policy.mode', 'vibe')).toBe('vibe');
    expect(() => parseSetting('policy.mode', 'yolo')).toThrow(/must be one of ask, vibe, locked/);
    expect(() => parseSetting('policy.tools.deny', 'channel_delete,not_a_tool')).toThrow(/not_a_tool/);
    expect(parseSetting('policy.tools.deny', 'channel_delete, member_ban')).toEqual(['channel_delete', 'member_ban']);
    expect(() => parseSetting('roles.admin', 'not-an-id')).toThrow(/not a Discord id/);
    expect(() => parseSetting('model.primary', 'gpt-5')).toThrow(/provider\/model/);
    expect(parseSetting('policy.vibe.askOnUncertain', 'off')).toBe(false);
  });

  test('writes are immutable and reset restores the schema default', () => {
    const before = guildDefaults();
    const after = setSetting(before, 'policy.matrix.member.destructive', 'deny');
    expect(readSetting(before, 'policy.matrix.member.destructive')).toBeUndefined();
    expect(readSetting(after, 'policy.matrix.member.destructive')).toBe('deny');
    expect(describeSetting(after, 'policy.mode')).toBe('ask');
    expect(
      setSetting(after, 'policy.matrix.member.destructive', defaultFor('policy.matrix.member.destructive')),
    ).toEqual(before);
    expect(defaultFor('policy.tools.deny')).toEqual([]);
    expect(defaultFor('shell.mode')).toBe('docker');
  });
});

describe('configurable ceiling', () => {
  test('the built-in table applies where the guild says nothing', () => {
    expect(ceilingFor(policyWith({}), 1, 'destructive')).toEqual({ 'verdict': 'deny', 'source': 'tier' });
    expect(ceilingFor(policyWith({}), 2, 'destructive')).toEqual({ 'verdict': 'ask', 'source': 'tier' });
  });

  test('a single matrix cell overrides one rank, leaving the rest alone', () => {
    const policy = policyWith({ 'matrix': { 'trusted': { 'destructive': 'deny' } } });
    expect(ceilingFor(policy, 2, 'destructive')).toEqual({ 'verdict': 'deny', 'source': 'matrix' });
    expect(ceilingFor(policy, 2, 'reversible')).toEqual({ 'verdict': 'allow', 'source': 'tier' });
    expect(ceilingFor(policy, 3, 'destructive')).toEqual({ 'verdict': 'allow', 'source': 'tier' });
  });
});

describe('vibe verdict', () => {
  const vibe = (overrides: Partial<GuildSettings['policy']['vibe']> = {}) => ({
    ...guildDefaults().policy.vibe,
    ...overrides,
  });
  const answers = (
    blast: 'read_only' | 'reversible' | 'destructive' | 'catastrophic',
    approval: number,
    confidence = 0.9,
  ) => ({
    'blast_radius': { 'choice': blast, 'confidence': confidence },
    'admin_would_approve': { 'noul': approval },
  });

  test('a reversible action Jev likes runs unattended', () => {
    expect(vibeVerdict({ 'risk': 'reversible', 'vibe': vibe(), 'jev': answers('reversible', 0.67) }).verdict).toBe(
      'allow',
    );
  });

  test('a catastrophic reading is refused whatever the class', () => {
    expect(vibeVerdict({ 'risk': 'reversible', 'vibe': vibe(), 'jev': answers('catastrophic', 0.9) }).verdict).toBe(
      'deny',
    );
    expect(vibeVerdict({ 'risk': 'destructive', 'vibe': vibe(), 'jev': answers('catastrophic', 0.9) }).verdict).toBe(
      'deny',
    );
  });

  test('a destructive reading needs the approval floor even on a reversible class', () => {
    // `bash` inside the sandbox is classed reversible, which must not make a destructive-looking command free.
    expect(vibeVerdict({ 'risk': 'reversible', 'vibe': vibe(), 'jev': answers('destructive', 0.23) }).verdict).toBe(
      'deny',
    );
    expect(vibeVerdict({ 'risk': 'reversible', 'vibe': vibe(), 'jev': answers('destructive', 0.7) }).verdict).toBe(
      'allow',
    );
  });

  test('destructive-class calls need more than the base floor, because Jev reads coarse classes loosely', () => {
    // A `permission_set Administrator` once came back "reversible" at 0.45.
    expect(vibeVerdict({ 'risk': 'destructive', 'vibe': vibe(), 'jev': answers('reversible', 0.5) }).verdict).toBe(
      'deny',
    );
    expect(vibeVerdict({ 'risk': 'destructive', 'vibe': vibe(), 'jev': answers('reversible', 0.65) }).verdict).toBe(
      'allow',
    );
    // `admin` is above the default maxRisk, so it always reaches a human: vibe never runs that class itself.
    expect(vibeVerdict({ 'risk': 'admin', 'vibe': vibe(), 'jev': answers('reversible', 1) }).verdict).toBe('ask');
  });

  test('an unconfident "safe" reading asks instead of running a dangerous call', () => {
    expect(vibeVerdict({ 'risk': 'destructive', 'vibe': vibe(), 'jev': answers('read_only', 0.9, 0.2) }).verdict).toBe(
      'ask',
    );
    expect(vibeVerdict({ 'risk': 'destructive', 'vibe': vibe(), 'jev': answers('read_only', 0.9, 0.8) }).verdict).toBe(
      'allow',
    );
  });

  test('risk above vibe.maxRisk still reaches a human', () => {
    expect(
      vibeVerdict({ 'risk': 'destructive', 'vibe': vibe({ 'maxRisk': 'reversible' }), 'jev': answers('reversible', 1) })
        .verdict,
    ).toBe('ask');
  });

  test('an unreachable Jev asks by default and runs only when the guild opted out', () => {
    expect(vibeVerdict({ 'risk': 'destructive', 'vibe': vibe(), 'jev': undefined }).verdict).toBe('ask');
    expect(
      vibeVerdict({ 'risk': 'destructive', 'vibe': vibe({ 'askOnUncertain': false }), 'jev': undefined }).verdict,
    ).toBe('allow');
  });

  test('the approval floor is configurable', () => {
    const strict = vibeVerdict({
      'risk': 'reversible',
      'vibe': vibe({ 'minApproval': 0.9 }),
      'jev': answers('destructive', 0.7),
    });
    expect(strict.verdict).toBe('deny');
  });

  test('screening off runs it without asking', () => {
    expect(vibeVerdict({ 'risk': 'destructive', 'vibe': vibe({ 'screen': 'off' }), 'jev': undefined }).verdict).toBe(
      'allow',
    );
  });
});

describe('decide with a guild policy', () => {
  const owner = {
    'id': 'owner-1',
    'roles': { 'cache': new Map() },
    'guild': { 'ownerId': 'owner-1' },
  } as unknown as Parameters<typeof decide>[1];
  const member = {
    'id': 'member-1',
    'roles': { 'cache': new Map() },
    'guild': { 'ownerId': 'owner-1' },
  } as unknown as Parameters<typeof decide>[1];

  test('a deny-listed tool is refused even for the owner', async () => {
    useGuilds({ 'g': { 'enabled': true, 'policy': { 'tools': { 'deny': ['channel_delete'] } } } });
    const decision = await decide('g', owner, capabilityByName('channel_delete'), { 'channel_id': '1' });
    expect(decision.verdict).toBe('deny');
    expect(decision.layer).toBe('tools');
  });

  test('an allow-listed tool skips the approval card', async () => {
    useGuilds({ 'g': { 'enabled': true, 'policy': { 'tools': { 'allow': ['message_send'] } } } });
    const decision = await decide('g', member, capabilityByName('message_send'), {
      'channel_id': '1',
      'content': 'hi',
    });
    expect(decision.verdict).toBe('allow');
    expect(decision.layer).toBe('tools');
  });

  test('locked mode refuses a destructive call from an admin', async () => {
    useGuilds({ 'g': { 'enabled': true, 'policy': { 'mode': 'locked' } } });
    const admin = {
      'id': 'admin-1',
      'roles': { 'cache': new Map([['r1', { 'id': 'r1' }]]) },
      'guild': { 'ownerId': 'owner-1' },
    } as unknown as Parameters<typeof decide>[1];
    useGuilds({ 'g': { 'enabled': true, 'roles': { 'admin': ['r1'] }, 'policy': { 'mode': 'locked' } } });
    const decision = await decide('g', admin, capabilityByName('channel_delete'), { 'channel_id': '1' });
    expect(decision.verdict).toBe('deny');
    expect(decision.layer).toBe('mode');
    // reads still work
    expect((await decide('g', admin, capabilityByName('channels_list'), {})).verdict).toBe('allow');
  });

  test('a matrix override turns a member destructive call from ask into deny', async () => {
    useGuilds({ 'g': { 'enabled': true, 'policy': { 'matrix': { 'member': { 'destructive': 'deny' } } } } });
    const decision = await decide('g', member, capabilityByName('role_delete'), { 'role_id': '1' });
    expect(decision.verdict).toBe('deny');
    expect(decision.layer).toBe('matrix');
  });

  test('a matrix override can hand trusted the run without asking', async () => {
    useGuilds({
      'g': {
        'enabled': true,
        'roles': { 'trusted': ['rt'] },
        'policy': { 'matrix': { 'trusted': { 'destructive': 'allow' } } },
      },
    });
    const trusted = {
      'id': 'trusted-1',
      'roles': { 'cache': new Map([['rt', { 'id': 'rt' }]]) },
      'guild': { 'ownerId': 'owner-1' },
    } as unknown as Parameters<typeof decide>[1];
    const decision = await decide('g', trusted, capabilityByName('member_kick'), { 'user_id': '2' });
    expect(decision.verdict).toBe('allow');
  });

  test('a vibe-mode permission decision is recorded so /audit can explain it', async () => {
    // JEV_MODE=off in tests, so vibe runs unscreened and allows without the network.
    useGuilds({ 'g': { 'enabled': true, 'policy': { 'mode': 'vibe' } } });
    const sessionId = `ses_perm_${Date.now()}`;
    sessions.set({
      'chat_key': 'g:chan-perm',
      'guild_id': 'g',
      'channel_id': 'chan-perm',
      'session_id': sessionId,
      'actor_id': 'member-1',
    });

    const replies: string[] = [];
    const opencode = {
      'replyPermission': async (_id: string, reply: string) => {
        replies.push(reply);
        return true;
      },
    };
    const runtime = new Runtime(
      { 'channels': { 'fetch': async () => undefined }, 'guilds': { 'cache': new Map() } } as never,
      {
        'get': () => ({ opencode }),
      } as never,
    );

    runtime.handleEvent('g', {
      'type': 'permission.asked',
      'properties': {
        'id': 'per_1',
        'sessionID': sessionId,
        'permission': 'bash',
        'patterns': ['bun test'],
        'always': [],
      },
    } as never);
    await Bun.sleep(50);

    expect(replies).toEqual(['once']);
    const row = audit.recent('g', 1)[0];
    expect(row?.tool).toBe('permission:bash');
    expect(row?.verdict).toBe('allow');
    expect(row?.layer).toBe('vibe');
  });
});
