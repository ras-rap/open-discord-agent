import { loadFixtures, scoreFixture } from '@services/evolution/fixtures.ts';
import { Memory, MemoryMaintenance } from '@services/memory/store.ts';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

describe('eval fixtures', () => {
  test('the shipped fixtures load and are well formed', () => {
    const fixtures = loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    for (const fixture of fixtures) {
      expect(fixture.name.length).toBeGreaterThan(2);
      expect(fixture.prompt.length).toBeGreaterThan(2);
    }
  });

  test('scores tool calls, matches and forbidden output', () => {
    const fixture = {
      'name': 'x',
      'prompt': 'y',
      'expect': {
        'tools': ['discord_channels_list'],
        'textMatches': ['total=\\d+'],
        'textForbids': ['error'],
        'minLength': 5,
      },
    };
    const good = scoreFixture(fixture, { 'toolCalls': ['discord_channels_list'], 'text': 'total=5 channels' });
    expect(good.ok).toBe(true);

    const missingTool = scoreFixture(fixture, { 'toolCalls': [], 'text': 'total=5 channels' });
    expect(missingTool.ok).toBe(false);
    expect(missingTool.checks.some(check => check.check === 'tool:discord_channels_list' && !check.ok)).toBe(true);

    const hallucinated = scoreFixture(fixture, {
      'toolCalls': ['discord_channels_list'],
      'text': 'total=5 error pages',
    });
    expect(hallucinated.ok).toBe(false);
    expect(hallucinated.checks.some(check => check.check.startsWith('forbid:') && !check.ok)).toBe(true);
  });
});

describe('memory maintenance', () => {
  const setup = () => {
    const db = new Database(':memory:');
    const memory = new Memory(db);
    return { db, memory, 'upkeep': new MemoryMaintenance(db) };
  };

  test('dedupe keeps the most important row and supersedes the rest', () => {
    const { memory, upkeep } = setup();
    memory.add({ 'guildId': 'g', 'kind': 'fact', 'key': 'a', 'text': 'deploys go to staging', 'importance': 0.4 });
    memory.add({ 'guildId': 'g', 'kind': 'fact', 'key': 'b', 'text': 'Deploys go to staging!', 'importance': 0.9 });
    const superseded = upkeep.dedupe('g');
    expect(superseded).toBe(1);
    const hits = memory.search('g', 'deploys staging');
    expect(hits.length).toBe(1);
    expect(hits[0]?.importance).toBeCloseTo(0.9, 5);
  });

  test('prune only drops old, unused, unimportant rows', () => {
    const { db, memory, upkeep } = setup();
    const keep = memory.add({
      'guildId': 'g',
      'kind': 'fact',
      'key': 'keep',
      'text': 'important thing',
      'importance': 0.9,
    });
    const drop = memory.add({
      'guildId': 'g',
      'kind': 'fact',
      'key': 'drop',
      'text': 'forgettable thing',
      'importance': 0.1,
    });
    // Age both rows past the cutoff explicitly, so the test never depends on clock granularity.
    const aged = Date.now() - 200 * 86_400_000;
    db.query('UPDATE memory SET created_at = ? WHERE id = ?').run(aged, keep);
    db.query('UPDATE memory SET created_at = ? WHERE id = ?').run(aged, drop);
    const pruned = upkeep.prune('g', { 'olderThanDays': 90, 'maxImportance': 0.3 });
    expect(pruned).toBe(1);
    const remaining = memory.recent('g').map(row => row.id);
    expect(remaining).toContain(keep);
  });
});
