import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config, paths } from "../config.ts";
import { log } from "../log.ts";

const logger = log("shell");
const MAX_OUTPUT = 20_000;
const TIMEOUT_MS = 300_000;

export type ShellOutcome = { code: number | null; output: string; mode: "docker" | "host" };

const trim = (value: string) =>
  value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n… truncated ${value.length - MAX_OUTPUT} chars` : value;

async function dockerUsable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "version", "--format", "{{.Server.Version}}"], { stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** One long-lived container per guild so `apt-get install` style state survives between commands. */
async function ensureContainer(guildId: string, image: string, workspace: string): Promise<string> {
  const name = `oda-${guildId}`;
  const inspect = Bun.spawn(["docker", "inspect", "-f", "{{.State.Running}}", name], { stdout: "pipe", stderr: "pipe" });
  const running = (await new Response(inspect.stdout).text()).trim();
  await inspect.exited;
  if (running === "true") return name;
  if (running === "false") {
    const start = Bun.spawn(["docker", "start", name], { stdout: "pipe", stderr: "pipe" });
    if ((await start.exited) === 0) return name;
  }
  const created = Bun.spawn(
    [
      "docker",
      "run",
      "-d",
      "--name",
      name,
      "-w",
      "/work",
      "-v",
      `${resolve(workspace)}:/work`,
      "--label",
      "open-discord-agent=1",
      image,
      "sleep",
      "infinity",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, code] = await Promise.all([new Response(created.stderr).text(), created.exited]);
  if (code !== 0) throw new Error(`docker run failed (${code}): ${stderr.trim().slice(0, 500)}`);
  logger.info("container started", { guildId, name, image });
  return name;
}

async function spawnCaptured(argv: string[], cwd?: string): Promise<ShellOutcome & { mode: "docker" | "host" }> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, TERM: "dumb", NO_COLOR: "1" } });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const combined = [stdout, stderr].filter((part) => part.length > 0).join("\n").trim();
  return { code, output: trim(combined || "(no output)"), mode: cwd === undefined ? "docker" : "host" };
}

/**
 * Shell execution is denied unless it can run sandboxed: docker is the default, host is opt-in per guild
 * (`config/guilds.json`), and `fallback: "error"` keeps a missing docker daemon from silently degrading.
 */
export async function runShell(guildId: string, command: string): Promise<string> {
  const guild = config.guild(guildId);
  const shellConfig = { ...config.shellDefaults, ...(guild?.shell ?? {}) };
  const workspace = resolve(paths.workspaces, guildId);
  if (!existsSync(workspace)) throw new Error(`workspace missing for guild ${guildId}`);

  if (shellConfig.mode === "host") {
    const argv =
      process.platform === "win32"
        ? [Bun.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
        : [Bun.env.SHELL ?? "/bin/sh", "-lc", command];
    const result = await spawnCaptured(argv, workspace);
    return `[host] exit=${result.code}\n${result.output}`;
  }

  if (!(await dockerUsable())) {
    if (shellConfig.fallback === "host") {
      logger.warn("docker unavailable; falling back to host shell", { guildId });
      const result = await spawnCaptured([Bun.env.SHELL ?? "/bin/sh", "-lc", command], workspace);
      return `[host fallback: docker unavailable] exit=${result.code}\n${result.output}`;
    }
    throw new Error("docker is not available and shell.fallback is \"error\"; refusing to run on the host");
  }

  const container = await ensureContainer(guildId, shellConfig.image, workspace);
  const result = await spawnCaptured(["docker", "exec", "-i", "-w", "/work", container, "sh", "-lc", command]);
  return `[docker ${container}] exit=${result.code}\n${result.output}`;
}

export async function shellStatus(): Promise<{ docker: boolean; mode: string }> {
  return { docker: await dockerUsable(), mode: config.shellDefaults.mode };
}
