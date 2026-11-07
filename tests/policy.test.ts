import { modelRef } from '@services/agent/models.ts';
import { capabilityByName } from '@services/bridge/lookup.ts';
import { chunkMessage } from '@services/discord/render.ts';
import { decide, tierOf } from '@services/policy/gate.ts';
import { describe, expect, test } from 'bun:test';

import type { GuildMember } from 'discord.js';

/** Structural stub: discord.js members cannot be constructed, and only id/roles/guild.ownerId are read. */
const memberStub = (id: string, roleIds: string[], guildOwnerId: string) =>
  ({
    id,
    'roles': { 'cache': new Map(roleIds.map(roleId => [roleId, { 'id': roleId }])) },
    'guild': { 'ownerId': guildOwnerId },
  }) as unknown as GuildMember;

describe('session policy', () => {
  test('a guest may read but not destroy', async () => {
    const read = await decide('g', null, capabilityByName('channels_list'), {});
    const destroy = await decide('g', null, capabilityByName('member_timeout'), { 'user_id': '1', 'minutes': 5 });
    expect(read.verdict).toBe('allow');
    expect(destroy.verdict).toBe('deny');
  });

  test('the owner bypasses the tier ceiling', async () => {
    const owner = memberStub('owner-1', [], 'owner-1');
    expect(tierOf('g', owner)).toBe(4);
    const decision = await decide('g', owner, capabilityByName('message_delete'), {
      'channel_id': '1',
      'message_id': '2',
    });
    expect(decision.verdict).toBe('allow');
  });
});

describe('model allowlist', () => {
  test('splits provider and model for allowed ids', () => {
    expect(modelRef('opencode/crouton-alpha-free')).toEqual({
      'providerID': 'opencode',
      'modelID': 'crouton-alpha-free',
    });
  });

  test('rejects any model outside the fixed list', () => {
    expect(() => modelRef('opencode/gpt-6-luna')).toThrow(/not allowed/);
  });
});

describe('chunkMessage', () => {
  test('keeps every chunk under the Discord limit and closes fences', () => {
    const code = Array.from({ 'length': 200 }, (_, index) => `const line${index} = ${index};`).join('\n');
    const chunks = chunkMessage(`intro\n\`\`\`ts\n${code}\n\`\`\`\noutro`);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1990);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });
});
