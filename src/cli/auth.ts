import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { paths } from "../config.ts";
import { log } from "../log.ts";

const logger = log("auth");

type ExportedCredential = {
  integrationID?: string;
  label?: string;
  active?: boolean;
  value?: { type?: string; access?: string; refresh?: string; expires?: number; metadata?: Record<string, unknown> };
};

/**
 * `opencode auth export` only exists on the globally installed CLI (the pinned 1.19.5 has no export
 * subcommand), and Bun puts `node_modules/.bin` first on PATH, so the global binary is resolved explicitly.
 */
function globalCli(): string {
  if (Bun.env.OPENCODE_CLI) return Bun.env.OPENCODE_CLI;
  const stripped = (Bun.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => !entry.includes(`${join("node_modules", ".bin")}`))
    .join(delimiter);
  const found = Bun.which("opencode", { PATH: stripped });
  if (!found) throw new Error("global `opencode` CLI not found; set OPENCODE_CLI to its path");
  return found;
}

/**
 * Jev is billed through OpenCode Zen and authenticated by the console OAuth token, so the bot needs that
 * token once. It is copied into the bot's private dir (mode 0600) rather than .env, never logged, and never
 * written to memory rows.
 */
async function main(): Promise<void> {
  const binary = globalCli();
  const proc = Bun.spawn([binary, "auth", "export"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`\`${binary} auth export\` failed (${code}): ${stderr.trim().slice(0, 300)}`);

  const exported = JSON.parse(stdout) as ExportedCredential[];
  const credential = exported.find((entry) => entry.integrationID === "opencode" && entry.value?.access);
  if (!credential?.value?.access) throw new Error("no opencode console credential found; run `opencode auth login` first");

  const payload = {
    access: credential.value.access,
    refresh: credential.value.refresh,
    expires: credential.value.expires,
    label: credential.label ?? "default",
    account: credential.value.metadata?.email ?? null,
    capturedAt: Date.now(),
  };
  writeFileSync(paths.token, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(paths.token, 0o600);
  logger.info("console token stored", { path: paths.token, binary, expires: credential.value.expires });
}

await main().catch((error) => {
  logger.error("auth failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
