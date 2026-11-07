import { existsSync } from "node:fs";
import { config, paths } from "../config.ts";
import { assertPinnedBinary } from "../agent/binary.ts";
import { consoleToken, jevMode } from "../policy/jev.ts";
import { shellStatus } from "../workspace/shell.ts";
import { capabilities } from "../bridge/capabilities.ts";
import { models } from "../agent/models.ts";
import { log } from "../log.ts";

const logger = log("doctor");

type Check = { name: string; severity: "ok" | "warn" | "error"; detail: string };

/**
 * Pre-flight report. Warnings (e.g. no docker daemon on a dev machine) never block boot: the shell runner
 * fails closed per call with an explicit message instead. Errors do block.
 */
async function main(): Promise<void> {
  const checks: Check[] = [];

  try {
    const { binary, version } = await assertPinnedBinary();
    checks.push({ name: "opencode binary", severity: "ok", detail: `${version} at ${binary}` });
  } catch (error) {
    checks.push({ name: "opencode binary", severity: "error", detail: error instanceof Error ? error.message : String(error) });
  }

  checks.push({
    name: "discord token",
    severity: config.discord.token.length > 40 ? "ok" : "error",
    detail: `bot ${config.discord.clientId}`,
  });
  checks.push({
    name: "model allowlist",
    severity: "ok",
    detail: [models.primary(), models.fast()].map(models.label).join(", ") + `, jev ${models.jev}`,
  });
  const token = consoleToken();
  checks.push({
    name: "jev",
    severity: token ? "ok" : jevMode === "enforce" ? "error" : "warn",
    detail: `mode=${jevMode} token=${token ? "present" : "missing (run `bun run auth` to shadow-calibrate)"}`,
  });

  const shell = await shellStatus();
  const shellOk = shell.mode === "host" || shell.docker;
  checks.push({
    name: "shell sandbox",
    severity: shellOk ? "ok" : "warn",
    detail: `mode=${shell.mode} docker=${shell.docker ? shell.detail : `unavailable — ${shell.detail}`}${shellOk ? "" : " (shell calls will refuse until the daemon is reachable)"}`,
  });

  checks.push({ name: "bridge", severity: "ok", detail: `${config.bridge.host}:${config.bridge.port}` });

  // Discord expires interactions after 3s, so a skewed host clock shows up as evry command failing with 10062.
  try {
    const response = await fetch("https://discord.com/api/v10/gateway", { method: "HEAD", signal: AbortSignal.timeout(5000) });
    const header = response.headers.get("date");
    const skewMs = header ? Date.now() - new Date(header).getTime() : 0;
    checks.push({
      name: "clock skew",
      severity: Math.abs(skewMs) > 5000 ? "warn" : "ok",
      detail: `${skewMs}ms vs discord.com${Math.abs(skewMs) > 5000 ? " — interactions will expire before we answer; fix NTP" : ""}`,
    });
  } catch (error) {
    checks.push({ name: "clock skew", severity: "warn", detail: `could not reach discord.com: ${String(error).slice(0, 120)}` });
  }
  checks.push({ name: "capabilities", severity: "ok", detail: `${capabilities.length} discord tools` });
  checks.push({ name: "data dir", severity: existsSync(paths.data) ? "ok" : "error", detail: paths.data });
  checks.push({ name: "guilds enabled", severity: "ok", detail: `${Object.keys(config.raw()).length} in config/guilds.json` });

  for (const check of checks) {
    const tag = check.severity === "ok" ? "✅" : check.severity === "warn" ? "⚠️ " : "❌";
    logger.info(`${tag} ${check.name}`, { detail: check.detail });
  }
  const errors = checks.filter((check) => check.severity === "error");
  if (errors.length > 0) {
    logger.error("doctor found blocking problems", { failed: errors.map((check) => check.name) });
    process.exit(1);
  }
}

await main();
