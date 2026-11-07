import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { paths } from "../config.ts";
import { log } from "../log.ts";
import { memory } from "./store.ts";

const logger = log("memory");
const BUDGET_CHARS = 1500;

/** Retrieval block injected into the user turn: BM25 + recency + importance, capped to a small budget. */
export function memoryContext(guildId: string, query: string): string {
  const hits = memory.search(guildId, query, 8);
  if (hits.length === 0) return "";
  memory.touch(hits.map((hit) => hit.id));
  const lines = hits.map((hit) => `- (${hit.kind}) ${hit.text}`).join("\n").slice(0, BUDGET_CHARS);
  return `\n\n<memory>\n${lines}\n</memory>`;
}

/** Rewrites the workspace digest that the model also sees as project instructions on the next turn. */
export function writeDigest(guildId: string): void {
  const digest = memory.digest(guildId);
  if (digest.length === 0) return;
  try {
    writeFileSync(resolve(paths.workspaces, guildId, "MEMORY.md"), `# Memory\n\n${digest}\n`);
  } catch (error) {
    logger.warn("could not write memory digest", { guildId, error: String(error).slice(0, 120) });
  }
}
