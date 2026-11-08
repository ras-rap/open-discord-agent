# open-discord-agent

A Discord-native agent that answers in chat **and acts** — creates channels, reads the member list, manages
roles, writes code — on an opencode backend, restricted to `crouton-alpha-free`, `beam-free`, and
`jev-1.13-free`.

Built on the [`discord-bot-template`](https://github.com/ras-rap/discord-bot-template/tree/rewrite) conventions:
discordx decorators discovered by `@discordx/importer`, reusable guards, pino logging, a command-registration
CLI, ESLint + Prettier, and Bun as the runtime.

Design and the measurements behind it: [`PLAN.md`](./PLAN.md).

**Status:** chat/streaming, the 14 Discord tools, tier policy + Jev shadow gate, approval cards, and memory v1
are implemented and exercised (`bun test`, `bun run smoke`, `bun run e2e` against the live gateway). The
evolution loop (self-editing skills with A/B evals) and cross-day recall verification remain; `PLAN.md` §8
tracks them.

## Requirements

| Need | Why |
| --- | --- |
| Bun ≥ 1.1 | runtime (`bun:sqlite`, `Bun.spawn`, `Bun.serve`) |
| Docker daemon | default shell sandbox; `shell.mode: "host"` opts out per guild |
| An OpenCode login on the machine | `bun run auth` stores the credential Jev accepts |
| Discord bot with `GuildMembers` + `MessageContent` intents | member listing and message text |

## Setup

```bash
bun install
cp .env.example .env                 # DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_DEVELOPMENT_GUILD_ID, OWNER_ID
bun run commands deploy              # publish slash commands (guild scope in development)
bun run doctor                       # preflight: binary, models, token, docker, clock skew, capabilities
bun run auth                         # probe OpenCode credentials, store the one Jev accepts
bun run smoke                        # offline end-to-end: server, prompt, stream, approval, jev
bun run start                        # run the bot
```

Then in your server: `/enable` (owner only), and `/ask <prompt>` or mention the bot.

## Scripts

| Command | Effect |
| --- | --- |
| `bun dev` | watch mode |
| `bun start` | run once |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` / `bun run format` | ESLint (with Prettier) / Prettier |
| `bun test` | unit tests |
| `bun run commands deploy\|clear\|list` | slash-command registration (`--global`, `--guild`, `--force`) |
| `bun run commands auth\|doctor\|smoke\|e2e` | agent tooling (`auth` probes Go first, then Jev, and stores the credential that works) |

## Project layout

```text
src/
  main.ts                  entry: env check, instance lock, importer, client.build(), deploy, login
  client.ts                discordx Client (intents/partials from utils/constants)
  commands/                slash commands and component interactables (agent, admin, ping, approvals)
  events/                  ready, mention prompts, interaction safety net
  guards/                  cooldown, guildOnly, ownerOnly, guildEnabled
  cli/                     `bun run commands …` dispatcher + deploy/clear/list, auth/doctor/smoke/e2e
  services/
    config.ts              guilds.json, paths, model allowlist, shell defaults
    agent/                 opencode binary, client, event adapter, supervisor, prompt runtime
    bridge/                14 Discord capabilities + loopback RPC server
    policy/                tier ceilings, Jev client (shadow/enforce)
    memory/                FTS5 store, retrieval injection, reflector
    workspace/             provisioning, generated tool file, docker/host shell
    discord/               approvals, stream renderer, service registry
    database/sqlite.ts     schema and stores
  utils/                   env, logger (pino), constants, instance lock
```

Path aliases (`@services/*`, `@utils/*`, `@guards/*`, `@cli/*`, `@/*`) come from `tsconfig.json`.

## Commands

| Command | Effect |
| --- | --- |
| `/ask <prompt>` | run a task in this channel (streamed) |
| `/new` | fresh opencode session for this channel |
| `/abort` | interrupt the running task |
| `/status` | servers, sessions, approvals, sandbox, policy, gateway, recent decisions |
| `/audit` | last 10 policy decisions in this server |
| `/remember <text>` | store a durable fact (rewrites the workspace `MEMORY.md`) |
| `/memory [query] [forget]` | search, show stats, or delete a memory by id |
| `/ping` | interaction latency, gateway ping, pid |
| *(cards)* | the agent's `question` tool and `permission.asked` both arrive as answerable cards — buttons, or a select menu when a question offers more than five options |
| `/enable` | owner only: allow this server |

Mentioning the bot or replying to one of its messages also starts a task.

## Tools the agent has

`guild_info`, `channels_list`, `channel_info`, `roles_list`, `member_list`, `member_info`, `messages_fetch`,
`message_send`, `channel_create`, `thread_create`, `message_delete`, `role_assign`, `member_timeout`, and
`bash` (shadowed builtin → sandboxed shell). Risk classes: read → reversible → destructive → admin.

## Memory

Three write paths feed one SQLite store (`memory` + `memory_fts`):

- **reflection** — after a turn that used tools or asked for something durable, `beam-free` re-reads the turn
  and emits typed JSON (`facts`, `preferences`, `lessons`); entries that look like credentials are dropped
  before they reach the store.
- **explicit** — `/remember <text>`.
- **digest** — `MEMORY.md` in the workspace is rewritten from the top rows, so opencode also loads the most
  important facts as project instructions.

Retrieval scores `0.6·BM25 + 0.25·recency + 0.15·importance` under a 1500-char budget and injects a
`<memory>` block into the user turn. Corrections supersede rather than contradict: `superseded_by` keeps the
old row for audit but removes it from recall.

## Policy

| Rank | read | reversible | destructive | admin |
| --- | --- | --- | --- | --- |
| owner / guild owner | allow | allow | allow | allow |
| admin (config role) | allow | allow | allow | ask |
| trusted (config role) | allow | allow | ask | deny |
| member | allow | ask | deny | deny |
| guest / DM | allow | deny | deny | deny |

Models run on the **OpenCode Go** subscription: provider `opencode-go`, base URL `https://opencode.ai/inference/go`,
authenticated with a Console API key (`oc_sk_...`) that the supervisor injects as `OPENCODE_GO_API_KEY`. Go is a
different endpoint from the free tier — a keyless/free call answers "Free usage exceeded, subscribe to Go", which is
what `bun run doctor` now checks explicitly (`go subscription`). Free-tier models only work inside OpenCode's own
free path, so the provider id and key are what select your subscription.

`JEV_MODE=shadow` (default) logs Jev's reading of every non-read call while the tier table still decides;
`enforce` lets Jev auto-allow high-confidence low-risk calls and deny anything it rates catastrophic or
unlikely to be approved. Without a credential the gate degrades to "ask a human", never to allow.

`config/guilds.json` (created by `/enable`, not committed):

```jsonc
{
  "123456789012345678": {
    "enabled": true,
    "shell": { "mode": "docker", "image": "debian:bookworm-slim", "fallback": "error" },
    "roles": { "admin": ["111..."], "trusted": ["222..."] }
  }
}
```

## Ops (Linux VM)

```bash
sudo cp deploy/oda.service /etc/systemd/system/oda.service
sudo systemctl enable --now oda
journalctl -u oda -f
```

- Data lives in `.data/` (SQLite `agent.db`, workspaces, console token, opencode runtime dirs). Back it up
  with `sqlite3 .data/agent.db "VACUUM INTO '/backup/agent-$(date +%F).db'"`.
- The bot never uses the globally installed `opencode`; the pinned 1.19.5 binary comes from `bun install` and
  the boot guard refuses to start on a version mismatch.
- Production logs: `logs/app.log` and `logs/error.log` (pino), console output is pretty-printed in development.

## Troubleshooting

The bot takes a lock at `.data/bot.lock` and refuses to start while another process holds it: a second login
invalidates the first gateway session, after which interactions arrive late and every reply fails with
`Unknown interaction` (10062).

| Symptom | Cause |
| --- | --- |
| `opencode binary not found` | postinstall skipped → `bun pm trust opencode-ai && bun install` |
| `server reported version X, expected 1.19.5` | a different binary is being picked up → `bun run doctor`, check `OPENCODE_BIN` |
| member list is empty | `GuildMembers` intent not enabled in the Discord dev portal |
| shell refuses with "docker is not available" | start Docker or set `shell.mode: "host"` for that guild |
| `Free usage exceeded, subscribe to Go` | the model call used the free tier: run `bun run auth` so a Go-entitled key is stored, then `bun run doctor` (expect `✅ go subscription 200`) |
| `Unknown interaction` (10062), or commands answer "The application did not respond" | the gateway delivered the interaction after Discord's 3s window — usually a second process on the same token (the lock file blocks that) or a paused host; `/ping` reports interaction latency, gateway ping and pid |
| the agent says "question · running" and nothing arrives | it used opencode's `question` tool; the card should be posted in the channel (answer buttons or a select). If it is missing, check the bot log for `could not post question card` |
| approvals never appear | check `/status` → `policy`; the event name is `permission.asked` (not `permission.updated`) |
| commands appear twice | deploy once per scope: `bun run commands deploy --guild` clears the global set, `--global` clears the guild copy |
| `/enable` says owner only | `OWNER_ID` in `.env` must be your Discord user id |
