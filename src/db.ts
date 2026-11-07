import { Database } from "bun:sqlite";
import { paths } from "./config.ts";

export const db = new Database(paths.db, { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  guild_id     TEXT PRIMARY KEY,
  dir          TEXT NOT NULL,
  port         INTEGER,
  password     TEXT,
  bridge_token TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  chat_key   TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor_id   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_sessions_by_session ON chat_sessions(session_id);

CREATE TABLE IF NOT EXISTS approvals (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  guild_id   TEXT NOT NULL,
  chat_key   TEXT NOT NULL,
  session_id TEXT,
  request_id TEXT,
  payload    TEXT NOT NULL,
  message_id TEXT,
  state      TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(state, session_id);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  guild_id   TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  channel_id TEXT,
  tool       TEXT NOT NULL,
  args       TEXT NOT NULL,
  verdict    TEXT NOT NULL,
  layer      TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS audit_by_guild ON audit(guild_id, ts DESC);

CREATE TABLE IF NOT EXISTS reflect_sessions (
  guild_id   TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_stats (
  guild_id TEXT NOT NULL,
  tool     TEXT NOT NULL,
  ok       INTEGER NOT NULL DEFAULT 0,
  fail     INTEGER NOT NULL DEFAULT 0,
  ms       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, tool)
);
`);

export type WorkspaceRow = {
  guild_id: string;
  dir: string;
  port: number | null;
  password: string | null;
  bridge_token: string | null;
};

export const workspaces = {
  get: (guildId: string) =>
    db.query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE guild_id = ?").get(guildId),
  upsert: (row: WorkspaceRow) =>
    db
      .query(
        `INSERT INTO workspaces (guild_id, dir, port, password, bridge_token, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET dir = excluded.dir, bridge_token = excluded.bridge_token`,
      )
      .run(row.guild_id, row.dir, row.port, row.password, row.bridge_token, Date.now()),
  setRuntime: (guildId: string, port: number, password: string) =>
    db.query("UPDATE workspaces SET port = ?, password = ? WHERE guild_id = ?").run(port, password, guildId),
  clearRuntime: (guildId: string) =>
    db.query("UPDATE workspaces SET port = NULL, password = NULL WHERE guild_id = ?").run(guildId),
  count: () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM workspaces").get()?.n ?? 0,
};

export type ChatSessionRow = {
  chat_key: string;
  guild_id: string;
  channel_id: string;
  session_id: string;
  actor_id: string | null;
};

export const sessions = {
  get: (chatKey: string) =>
    db.query<ChatSessionRow, [string]>("SELECT * FROM chat_sessions WHERE chat_key = ?").get(chatKey),
  byOpenCodeId: (sessionId: string) =>
    db.query<ChatSessionRow, [string]>("SELECT * FROM chat_sessions WHERE session_id = ?").get(sessionId),
  set: (row: { chat_key: string; guild_id: string; channel_id: string; session_id: string; actor_id: string }) =>
    db
      .query(
        `INSERT INTO chat_sessions (chat_key, guild_id, channel_id, session_id, actor_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_key) DO UPDATE SET session_id = excluded.session_id, actor_id = excluded.actor_id, updated_at = excluded.updated_at`,
      )
      .run(row.chat_key, row.guild_id, row.channel_id, row.session_id, row.actor_id, Date.now(), Date.now()),
  rotate: (chatKey: string, sessionId: string) =>
    db.query("UPDATE chat_sessions SET session_id = ?, updated_at = ? WHERE chat_key = ?").run(sessionId, Date.now(), chatKey),
  touch: (chatKey: string) => db.query("UPDATE chat_sessions SET updated_at = ? WHERE chat_key = ?").run(Date.now(), chatKey),
  count: () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chat_sessions").get()?.n ?? 0,
};

export type ApprovalRow = {
  id: string;
  kind: "bridge" | "permission";
  guild_id: string;
  chat_key: string;
  session_id: string | null;
  request_id: string | null;
  payload: string;
  message_id: string | null;
  state: "pending" | "allowed" | "denied" | "expired";
  created_by: string;
  created_at: number;
};

export const approvals = {
  create: (row: ApprovalRow) =>
    db
      .query(
        `INSERT INTO approvals (id, kind, guild_id, chat_key, session_id, request_id, payload, message_id, state, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.kind,
        row.guild_id,
        row.chat_key,
        row.session_id,
        row.request_id,
        row.payload,
        row.message_id,
        row.state,
        row.created_by,
        row.created_at,
      ),
  get: (id: string) => db.query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE id = ?").get(id),
  pendingBySession: (sessionId: string) =>
    db.query<ApprovalRow, [string]>("SELECT * FROM approvals WHERE session_id = ? AND state = 'pending'").all(sessionId),
  setMessage: (id: string, messageId: string) =>
    db.query("UPDATE approvals SET message_id = ? WHERE id = ?").run(messageId, id),
  decide: (id: string, state: ApprovalRow["state"], decidedBy: string) =>
    db.query("UPDATE approvals SET state = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(state, decidedBy, Date.now(), id),
  pendingCount: () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM approvals WHERE state = 'pending'").get()?.n ?? 0,
};

export type AuditRow = {
  id: number;
  ts: number;
  guild_id: string;
  actor_id: string;
  channel_id: string | null;
  tool: string;
  args: string;
  verdict: string;
  layer: string;
  detail: string | null;
};

export const audit = {
  write: (row: {
    guildId: string;
    actorId: string;
    channelId?: string;
    tool: string;
    args: unknown;
    verdict: string;
    layer: string;
    detail?: string;
  }) =>
    db
      .query("INSERT INTO audit (ts, guild_id, actor_id, channel_id, tool, args, verdict, layer, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        Date.now(),
        row.guildId,
        row.actorId,
        row.channelId ?? null,
        row.tool,
        JSON.stringify(row.args).slice(0, 4000),
        row.verdict,
        row.layer,
        row.detail ?? null,
      ),
  recent: (guildId: string, limit = 10) =>
    db.query<AuditRow, [string, number]>("SELECT * FROM audit WHERE guild_id = ? ORDER BY ts DESC LIMIT ?").all(guildId, limit),
};

export const toolStats = {
  bump: (guildId: string, tool: string, ok: boolean, ms: number) =>
    db
      .query(
        `INSERT INTO tool_stats (guild_id, tool, ok, fail, ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, tool) DO UPDATE SET ok = ok + excluded.ok, fail = fail + excluded.fail, ms = ms + excluded.ms`,
      )
      .run(guildId, tool, ok ? 1 : 0, ok ? 0 : 1, Math.round(ms)),
};
