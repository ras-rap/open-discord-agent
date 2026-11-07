import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..");

export const paths = {
  root,
  data: resolve(root, ".data"),
  workspaces: resolve(root, ".data/workspaces"),
  config: resolve(root, "config"),
  db: resolve(root, ".data/agent.db"),
  token: resolve(root, ".data/console-token.json"),
};

const GuildConfig = z.object({
  enabled: z.boolean().default(false),
  shell: z
    .object({
      mode: z.enum(["docker", "host"]).default("docker"),
      image: z.string().default("debian:bookworm-slim"),
      fallback: z.enum(["error", "host"]).default("error"),
    })
    .default({}),
  roles: z
    .object({ admin: z.array(z.string()).default([]), trusted: z.array(z.string()).default([]) })
    .default({}),
});

export type GuildConfig = z.infer<typeof GuildConfig>;

const GuildsFile = z.record(z.string(), GuildConfig);

function readGuilds(): z.infer<typeof GuildsFile> {
  mkdirSync(paths.config, { recursive: true });
  const file = `${paths.config}/guilds.json`;
  if (!existsSync(file)) {
    writeFileSync(file, "{}\n");
    return {};
  }
  const parsed = GuildsFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`config/guilds.json invalid: ${parsed.error.message}`);
  return parsed.data;
}

const env = Bun.env;
const required = (name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`missing ${name} in .env`);
  return value;
};

export const MODELS = {
  primary: "opencode/crouton-alpha-free",
  fast: "opencode/beam-free",
  jev: "jev-1.13-free",
} as const;

export const config = {
  discord: {
    token: required("DISCORD_TOKEN"),
    clientId: required("BOT_CLIENT_ID"),
    ownerId: required("OWNER_ID"),
  },
  bridge: {
    host: "127.0.0.1",
    port: Number(env.BRIDGE_PORT ?? 7071),
  },
  opencode: {
    binary: env.OPENCODE_BIN,
    version: "1.19.5",
    host: "127.0.0.1",
    portRange: [4100, 4300] as [number, number],
    idleUnloadMs: 30 * 60_000,
    startupTimeoutMs: 30_000,
  },
  models: MODELS,
  shellDefaults: { mode: "docker" as const, image: "debian:bookworm-slim", fallback: "error" as const },
  paths,
  raw: () => readGuilds(),
  guild: (id: string): GuildConfig | undefined => readGuilds()[id],
  setGuild: (id: string, value: unknown): void => {
    const all = readGuilds();
    all[id] = GuildConfig.parse(value);
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(`${paths.config}/guilds.json`, `${JSON.stringify(all, null, 2)}\n`);
  },
};

mkdirSync(paths.data, { recursive: true });
mkdirSync(paths.workspaces, { recursive: true });
export const isOwner = (userId: string) => userId === config.discord.ownerId;
