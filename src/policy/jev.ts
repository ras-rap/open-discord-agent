import { existsSync, readFileSync } from "node:fs";
import { paths } from "../config.ts";
import { log } from "../log.ts";

const logger = log("jev");
const ENDPOINT = "https://opencode.ai/inference/systemone/v1/systemone";
const TIMEOUT_MS = 4000;

export type JevMode = "off" | "shadow" | "enforce";

export const jevMode: JevMode = (() => {
  const raw = (Bun.env.JEV_MODE ?? "shadow").toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "shadow";
})();

type StoredToken = { access?: string; refresh?: string; expires?: number };

/**
 * Jev is served by OpenCode Zen, not TypeSafe, and authenticates with the OpenCode console OAuth access
 * token (PLAN.md §0.1). The token is read from the bot's private dir first, then the environment.
 */
export function consoleToken(): string | undefined {
  if (Bun.env.OPENCODE_CONSOLE_TOKEN) return Bun.env.OPENCODE_CONSOLE_TOKEN;
  if (!existsSync(paths.token)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(paths.token, "utf8")) as StoredToken;
    return parsed.access;
  } catch (error) {
    logger.warn("console token file unreadable", { error: String(error).slice(0, 120) });
    return undefined;
  }
}

export type JevQuestions = Record<string, Record<string, unknown>>;
export type JevAnswers = Record<string, { choice?: string; confidence?: number; noul?: number; score?: number }>;

/** Typed decision call: returns `undefined` on any failure so callers stay fail-closed instead of assuming. */
export async function askJev(state: string, questions: JevQuestions): Promise<JevAnswers | undefined> {
  const token = consoleToken();
  if (!token) {
    logger.debug("no console token; skipping jev");
    return undefined;
  }
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "jev-1.13-free", state, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn("jev call failed", { status: response.status, body: (await response.text()).slice(0, 160) });
      return undefined;
    }
    const body = (await response.json()) as { answers?: JevAnswers };
    return body.answers;
  } catch (error) {
    logger.warn("jev call threw", { error: String(error).slice(0, 160) });
    return undefined;
  }
}

export const SAFETY_QUESTIONS: JevQuestions = {
  blast_radius: {
    type: "choice",
    instructions: "How destructive is this action if it proceeded exactly as described?",
    criteria: {
      read_only: "Only reads or inspects state",
      reversible: "Writes that a competent admin could undo",
      destructive: "Deletes, overwrites or silences something that cannot be restored",
      catastrophic: "Server-wide or irreversible damage, mass actions, or remote code execution",
    },
  },
  admin_would_approve: {
    type: "noul",
    instructions: "Would a reasonable server admin approve this action when requested in a Discord channel?",
  },
};
