import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { paths } from "./config.ts";

const lockPath = resolve(paths.data, "bot.lock");

type LockFile = { pid: number; startedAt: number; argv: string };

const isAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * One process per bot token is a hard requirement: a second login invalidates the first gateway session,
 * which then delivers interactions late (Discord reports `Unknown interaction` / 10062 because the 3s
 * acknowledgement window is already gone). This refuses to start instead of failing that way.
 */
export function acquireInstanceLock(): void {
  if (existsSync(lockPath)) {
    try {
      const held = JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
      if (held.pid !== process.pid && isAlive(held.pid)) {
        throw new Error(
          `another instance is already running with this bot token (pid ${held.pid}, started ${new Date(held.startedAt).toISOString()}). ` +
            `Stop it first: \`kill ${held.pid}\` — two sessions make Discord deliver interactions late and every reply fails with 10062.`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("another instance")) throw error;
      // Unreadable lock (older version or partial write): treat as stale.
    }
  }
  const record: LockFile = { pid: process.pid, startedAt: Date.now(), argv: Bun.argv.join(" ") };
  writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`);
  const release = () => {
    try {
      const held = JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
      if (held.pid === process.pid) rmSync(lockPath, { force: true });
    } catch {
      // Nothing to release.
    }
  };
  process.on("exit", release);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
