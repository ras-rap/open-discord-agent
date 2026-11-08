import { Memory, matchTerms, normalizeKey } from '@services/memory/store.ts';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

const fresh = () => new Memory(new Database(':memory:'));

describe('memory keys', () => {
  test('punctuation and casing collapse to one key', () => {
    expect(normalizeKey('  Deploys: **always** use #staging! ')).toBe('deploys: always use staging');
  });
});

describe('memory store', () => {
  test('the same key updates one row instead of duplicating it', () => {
    const memory = fresh();
    const first = memory.add({
      'guildId': 'g',
      'kind': 'fact',
      'key': 'deploy target',
      'text': 'deploys go to staging',
    });
    const second = memory.add({
      'guildId': 'g',
      'kind': 'fact',
      'key': 'Deploy target',
      'text': 'deploys go to staging then prod',
    });
    expect(second).toBe(first);
    expect(memory.stats('g').total).toBe(1);
    expect(memory.search('g', 'staging')[0]?.text).toContain('prod');
  });

  test('search finds by term and survives a missing match', () => {
    const memory = fresh();
    memory.add({
      'guildId': 'g',
      'kind': 'fact',
      'key': 'mod channel',
      'text': 'moderation happens in #staff-room',
      'importance': 0.9,
    });
    memory.add({ 'guildId': 'g', 'kind': 'preference', 'key': 'tone', 'text': 'people here prefer terse answers' });
    expect(memory.search('g', 'staff room').length).toBe(1);
    expect(memory.search('g', 'kubernetes')).toEqual([]);
  });

  test('superseded rows leave search results but stay in stats', () => {
    const memory = fresh();
    const oldId = memory.add({
      'guildId': 'g',
      'kind': 'fact',
      'key': 'release day',
      'text': 'releases happen on friday',
    });
    const newId = memory.add({
      'guildId': 'g',
      'kind': 'fact',
      'key': 'release day new',
      'text': 'releases happen on tuesday',
    });
    memory.supersede(oldId, newId);
    const hits = memory.search('g', 'releases');
    expect(hits.map(hit => hit.id)).toEqual([newId]);
    expect(memory.stats('g').superseded).toBe(1);
  });

  test('forget removes only the matching guild row', () => {
    const memory = fresh();
    const id = memory.add({ 'guildId': 'g', 'kind': 'fact', 'key': 'k', 'text': 'v' });
    expect(memory.forget('other', id)).toBe(false);
    expect(memory.forget('g', id)).toBe(true);
    expect(memory.stats('g').total).toBe(0);
  });

  test('digest groups rows by kind', () => {
    const memory = fresh();
    memory.add({ 'guildId': 'g', 'kind': 'fact', 'key': 'a', 'text': 'the bot is named kirby' });
    memory.add({ 'guildId': 'g', 'kind': 'lesson', 'key': 'b', 'text': 'run bun install before tests' });
    const digest = memory.digest('g');
    expect(digest).toContain('## Facts');
    expect(digest).toContain('## Lessons');
  });

  /**
   * Regression: the recall query was built from the raw prompt, so a mention containing `.env` reached FTS5
   * MATCH as syntax and threw `fts5: syntax error near "."`, which aborted the whole turn before the model ran.
   */
  test('a prompt full of query syntax is recalled, not thrown back', () => {
    const memory = fresh();
    // Deliberately the least important and oldest row: only a working MATCH can surface it, since the recency
    // fallback ranks importance first and is asked for fewer rows than exist.
    memory.add({
      'guildId': 'g',
      'kind': 'fact',
      'key': 'role',
      'text': 'kirby is the moderation bot',
      'importance': 0.1,
    });
    for (let index = 0; index < 4; index += 1)
      memory.add({
        'guildId': 'g',
        'kind': 'fact',
        'key': `filler-${index}`,
        'text': `unrelated note ${index}`,
        'importance': 0.9,
      });

    const prompt =
      "@Kirby I gave you a file called for-agent.env containing a discord bot token, the bot is @Chloe's test " +
      'bot, turn it into a moderation bot using this bot template https://github.com/ras-rap/discord-bot-template';

    expect(memory.search('g', prompt, 2).map(hit => hit.text)).toContain('kirby is the moderation bot');
  });

  test('match terms are quoted literals, so punctuation and operators carry no meaning', () => {
    expect(matchTerms('for-agent.env')).toEqual(['"for"*', '"agent"*', '"env"*']);
    // `AND`, `OR`, `NOT`, `NEAR` are FTS5 operators unless quoted; short words (a, b, c) are dropped.
    expect(matchTerms('a AND b OR "c" NOT d* (e)')).toEqual(['"and"*', '"not"*']);
    expect(matchTerms('https://github.com/ras-rap/x').every(term => /^"[\p{L}\p{N}]+"\*$/u.test(term))).toBe(true);
    expect(matchTerms('   ')).toEqual([]);
  });
});
