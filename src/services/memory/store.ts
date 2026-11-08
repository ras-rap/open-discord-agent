import { db as appDb } from '@services/database/sqlite.ts';

import type { Database } from 'bun:sqlite';

export type MemoryKind = 'fact' | 'preference' | 'lesson' | 'pointer';

export type MemoryRow = {
  id: number;
  guild_id: string;
  kind: MemoryKind;
  key: string;
  text: string;
  importance: number;
  confidence: number;
  source: string | null;
  created_at: number;
  last_used_at: number | null;
  uses: number;
  superseded_by: number | null;
};

export type MemoryHit = MemoryRow & { score: number };

export type NewMemory = {
  guildId: string;
  kind: MemoryKind;
  key: string;
  text: string;
  importance?: number;
  confidence?: number;
  source?: string;
};

/** Keys are compared case-, punctuation- and whitespace-insensitively so duplicates collapse. */
export function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_>"']/g, '')
    .replace(/[^a-z0-9\s:./-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const DECAY_HALF_LIFE_DAYS = 45;

/**
 * Lexical memory store: FTS5 for recall, importance and recency as secondary signals, and an explicit
 * `superseded_by` link so a corrected fact replaces an old one instead of contradicting it in context.
 */
export class Memory {
  constructor(private readonly db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id      TEXT NOT NULL,
        kind          TEXT NOT NULL,
        key           TEXT NOT NULL,
        text          TEXT NOT NULL,
        importance    REAL NOT NULL DEFAULT 0.5,
        confidence    REAL NOT NULL DEFAULT 0.7,
        source        TEXT,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER,
        uses          INTEGER NOT NULL DEFAULT 0,
        superseded_by INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memory_key ON memory(guild_id, kind, key) WHERE superseded_by IS NULL;
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, key, content='memory', content_rowid='id');

      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, text, key) VALUES (new.id, new.text, new.key);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, text, key) VALUES('delete', old.id, old.text, old.key);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, text, key) VALUES('delete', old.id, old.text, old.key);
        INSERT INTO memory_fts(rowid, text, key) VALUES (new.id, new.text, new.key);
      END;
    `);
  }

  /** Returns the row id; an existing live row with the same key is updated instead of duplicated. */
  add(input: NewMemory): number {
    const key = normalizeKey(input.key || input.text);
    if (key.length === 0 || input.text.trim().length === 0) throw new Error('memory needs key or text');
    const existing = this.db
      .query<MemoryRow, [string, string, string]>(
        'SELECT * FROM memory WHERE guild_id = ? AND kind = ? AND key = ? AND superseded_by IS NULL',
      )
      .get(input.guildId, input.kind, key);
    const text = input.text.trim().slice(0, 2000);
    if (existing) {
      this.db
        .query(
          'UPDATE memory SET text = ?, importance = MAX(importance, ?), confidence = MAX(confidence, ?), uses = uses + 1 WHERE id = ?',
        )
        .run(text, input.importance ?? 0.5, input.confidence ?? 0.7, existing.id);
      return existing.id;
    }
    const result = this.db
      .query(
        `INSERT INTO memory (guild_id, kind, key, text, importance, confidence, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.guildId,
        input.kind,
        key,
        text,
        input.importance ?? 0.5,
        input.confidence ?? 0.7,
        input.source ?? null,
        Date.now(),
      );
    return Number(result.lastInsertRowid);
  }

  /** Marks `id` superseded by a newer row; the pair is kept so the correction stays auditable. */
  supersede(oldId: number, newId: number): void {
    this.db.query('UPDATE memory SET superseded_by = ? WHERE id = ?').run(newId, oldId);
  }

  search(guildId: string, query: string, limit = 8): MemoryHit[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return this.recent(guildId, limit);
    const terms = normalizeKey(trimmed)
      .split(' ')
      .filter(word => word.length > 2)
      .slice(0, 8)
      .map(word => `${word.replace(/"/g, '')}*`);
    if (terms.length === 0) return this.recent(guildId, limit);

    const rows = this.db
      .query<MemoryRow & { bm25: number }, [string, string, number]>(
        `SELECT m.*, bm25(memory_fts) AS bm25
           FROM memory_fts JOIN memory m ON m.id = memory_fts.rowid
          WHERE memory_fts MATCH ? AND m.guild_id = ? AND m.superseded_by IS NULL
          ORDER BY bm25 LIMIT ?`,
      )
      .all(terms.join(' OR '), guildId, limit * 3);

    const now = Date.now();
    const scored = rows.map(row => {
      const lexical = 1 / (1 + Math.max(row.bm25, 0));
      const ageDays = (now - row.created_at) / 86_400_000;
      const recency = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
      const score = 0.6 * lexical + 0.25 * recency + 0.15 * row.importance;
      return { ...row, score };
    });
    scored.sort((left, right) => right.score - left.score);
    return scored.slice(0, limit);
  }

  recent(guildId: string, limit = 8): MemoryHit[] {
    return this.db
      .query<MemoryRow, [string, number]>(
        'SELECT * FROM memory WHERE guild_id = ? AND superseded_by IS NULL ORDER BY importance DESC, created_at DESC LIMIT ?',
      )
      .all(guildId, limit)
      .map(row => ({ ...row, 'score': row.importance }));
  }

  touch(ids: number[]): void {
    for (const id of ids)
      this.db.query('UPDATE memory SET uses = uses + 1, last_used_at = ? WHERE id = ?').run(Date.now(), id);
  }

  forget(guildId: string, id: number): boolean {
    return this.db.query('DELETE FROM memory WHERE guild_id = ? AND id = ?').run(guildId, id).changes > 0;
  }

  digest(guildId: string, limit = 40): string {
    const rows = this.db
      .query<MemoryRow, [string, number]>(
        'SELECT * FROM memory WHERE guild_id = ? AND superseded_by IS NULL ORDER BY importance DESC, created_at DESC LIMIT ?',
      )
      .all(guildId, limit);
    if (rows.length === 0) return '';
    const section = (kind: MemoryKind, title: string) => {
      const items = rows.filter(row => row.kind === kind).map(row => `- ${row.text}`);
      return items.length > 0 ? `## ${title}\n${items.join('\n')}` : '';
    };
    return [
      section('fact', 'Facts'),
      section('preference', 'Preferences'),
      section('lesson', 'Lessons'),
      section('pointer', 'Pointers'),
    ]
      .filter(part => part.length > 0)
      .join('\n\n');
  }

  stats(guildId: string): { total: number; byKind: Record<string, number>; superseded: number } {
    const byKind = this.db
      .query<{ kind: string; n: number }, [string]>(
        'SELECT kind, COUNT(*) AS n FROM memory WHERE guild_id = ? AND superseded_by IS NULL GROUP BY kind',
      )
      .all(guildId);
    const superseded = this.db
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM memory WHERE guild_id = ? AND superseded_by IS NOT NULL',
      )
      .get(guildId);
    return {
      'total': byKind.reduce((sum, row) => sum + row.n, 0),
      'byKind': Object.fromEntries(byKind.map(row => [row.kind, row.n])),
      'superseded': superseded?.n ?? 0,
    };
  }
}

/** App-bound instance: the bot's own SQLite database, created once at boot. */
export const memory = new Memory(appDb);

/** Consolidation helpers live on the store so prune/decay rules stay next to the schema they touch. */
export class MemoryMaintenance {
  constructor(private readonly db: Database) {}

  /** Drops rows nothing ever recalled, that are old, and that nobody rates highly. */
  prune(guildId: string, opts: { olderThanDays?: number; maxImportance?: number } = {}): number {
    const olderThanDays = opts.olderThanDays ?? 90;
    const maxImportance = opts.maxImportance ?? 0.3;
    const cutoff = Date.now() - olderThanDays * 86_400_000;
    // sqlite3_changes also counts the FTS trigger's work, so the row count is measured before deleting.
    const doomed = this.db
      .query<{ n: number }, [string, number, number]>(
        'SELECT COUNT(*) AS n FROM memory WHERE guild_id = ? AND created_at < ? AND importance < ? AND uses = 0 AND superseded_by IS NULL',
      )
      .get(guildId, cutoff, maxImportance);
    this.db
      .query(
        'DELETE FROM memory WHERE guild_id = ? AND created_at < ? AND importance < ? AND uses = 0 AND superseded_by IS NULL',
      )
      .run(guildId, cutoff, maxImportance);
    return doomed?.n ?? 0;
  }

  /** Old rows lose importance gradually unless they keep being recalled. */
  applyDecay(guildId: string, factor = 0.98): number {
    const cutoff = Date.now() - 30 * 86_400_000;
    const affected = this.db
      .query<{ n: number }, [string, number]>(
        'SELECT COUNT(*) AS n FROM memory WHERE guild_id = ? AND created_at < ? AND uses = 0 AND superseded_by IS NULL',
      )
      .get(guildId, cutoff);
    this.db
      .query(
        'UPDATE memory SET importance = MAX(importance * ?, 0.05) WHERE guild_id = ? AND created_at < ? AND uses = 0 AND superseded_by IS NULL',
      )
      .run(factor, guildId, cutoff);
    return affected?.n ?? 0;
  }

  /** Collapses rows with the same normalised text, keeping the most important and superseding the rest. */
  dedupe(guildId: string): number {
    const rows = this.db
      .query<MemoryRow, [string]>(
        'SELECT * FROM memory WHERE guild_id = ? AND superseded_by IS NULL ORDER BY importance DESC, created_at DESC',
      )
      .all(guildId);
    const keeper = new Map<string, MemoryRow>();
    let superseded = 0;
    for (const row of rows) {
      const signature = `${row.kind}:${normalizeKey(row.text)}`;
      const existing = keeper.get(signature);
      if (!existing) {
        keeper.set(signature, row);
        continue;
      }
      this.db.query('UPDATE memory SET superseded_by = ? WHERE id = ?').run(existing.id, row.id);
      superseded += 1;
    }
    return superseded;
  }
}

/** App-bound maintenance helpers. */
export const memoryMaintenance = new MemoryMaintenance(appDb);
