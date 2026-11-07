import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config, paths } from "../config.ts";

const osMap: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
const archMap: Record<string, string> = { x64: "x64", arm64: "arm64", arm: "arm" };

const platformPkg = () => {
  const os = osMap[process.platform] ?? process.platform;
  const arch = archMap[process.arch] ?? process.arch;
  return `opencode-${os}-${arch}`;
};

/**
 * The pinned `opencode-ai` package ships the platform binary through an optional dependency whose
 * postinstall copies it to `opencode-ai/bin/opencode.exe` on every platform (Windows included), so the
 * `OPENCODE_BIN` env var, the package bin, and the raw platform package are all probed in that order.
 * The globally installed CLI is deliberately not used: its API surface differs (see PLAN.md §0).
 */
export function resolveOpencodeBinary(): string {
  const candidates = [
    config.opencode.binary,
    resolve(paths.root, "node_modules/opencode-ai/bin/opencode.exe"),
    resolve(paths.root, "node_modules/opencode-ai/bin/opencode"),
    resolve(paths.root, "node_modules/.bin/opencode"),
    resolve(paths.root, "node_modules/.bin/opencode.exe"),
    resolve(paths.root, `node_modules/${platformPkg()}/bin/opencode.exe`),
    resolve(paths.root, `node_modules/${platformPkg()}/bin/opencode`),
    resolve(paths.root, `node_modules/${platformPkg()}-baseline/bin/opencode`),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(
    `opencode binary not found. Run \`bun install\` (and \`bun pm trust opencode-ai\` if the postinstall was skipped), ` +
      `or set OPENCODE_BIN. Probed:\n  ${candidates.join("\n  ")}`,
  );
}

export async function opencodeBinaryVersion(binary = resolveOpencodeBinary()): Promise<string> {
  const proc = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`\`${binary} --version\` failed (${code}): ${stderr.trim() || stdout.trim()}`);
  return stdout.trim().split("\n").at(-1)?.trim() ?? "";
}

export async function assertPinnedBinary(): Promise<{ binary: string; version: string }> {
  const binary = resolveOpencodeBinary();
  const version = await opencodeBinaryVersion(binary);
  if (version !== config.opencode.version) {
    throw new Error(
      `opencode binary version ${version} does not match the pinned ${config.opencode.version} (${binary}). ` +
        `The SDK and server only agree on 1.19.5; see PLAN.md §0.1.`,
    );
  }
  return { binary, version };
}
