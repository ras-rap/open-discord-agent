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
| `bun run commands auth\|doctor\|smoke\|e2e\|backup` | agent tooling (`auth` probes Go first then Jev; `backup` writes a consistent SQLite snapshot, keeping 14) |

Fixtures live in `config/fixtures/*.json` and are loaded by `/eval` and the promotion gate.

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
| `/learn` | compile stored lessons into a `SKILL.md` proposal and review the diff (admin) |
| `/skills [revert] [name]` | list artifacts, feedback counts, current skill file; restore a version |
| `/eval` | replay `config/fixtures` against the current agent and print pass rate + failing checks |
| `/undo` | revert the last turn's file changes in this server's workspace (admin) |
| `/skill-file [name]` | print the learned skill file |
| `/ping` | interaction latency, gateway ping, pid |
| *(cards)* | the agent's `question` tool and `permission.asked` both arrive as answerable cards — buttons, or a select menu when a question offers more than five options |
| `/enable` | owner only: allow this server |

Mentioning the bot or replying to one of its messages also starts a task.

## Tools the agent has

26 capabilities, all authorised against the requester's rank before they run:

| Risk | Tools |
| --- | --- |
| read | `guild_info`, `channels_list`, `channel_info`, `roles_list`, `member_list`, `member_info`, `messages_fetch` |
| reversible | `channel_create`, `channel_update` (name/topic/slowmode/nsfw), `channel_move` (category/position), `thread_create`, `thread_update` (archive/lock/rename), `message_send`, `message_pin`, `role_create`, `role_update`, `role_assign`, `invite_create` |
| destructive | `channel_delete`, `permission_set` (allow/deny/clear overwrites), `role_delete`, `message_delete`, `member_timeout`, `member_kick`, `member_ban`, `bash` |

Permission names are validated (`allow: ["ViewChannel"], deny: ["SendMessages"]`), colours must be `#rrggbb`, and
`bash` is the shadowed builtin that runs through the sandbox.

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

## Learning loop

Three signals feed one loop, and every change is gated:

1. **outcomes** — tool success/failure, permission denials, corrections (all already recorded).
2. **reactions** — 👍/👎/✅/❌ on the bot's own messages are stored (`feedback`), de-duplicated per user/message,
   and folded into the next reflection pass so a thumbs-down actually teaches something.
3. **lessons** — the `beam-free` reflector turns turns into `facts`/`preferences`/`lessons`.

`/learn` ranks those lessons and renders a diff. On approval the change goes through an **A/B gate** before it is
allowed to stay:

1. replay every fixture in `config/fixtures/*.json` against the incumbent skill state → baseline rate
2. write the candidate, restart that guild's opencode server (skills load at start-up), replay again
3. keep it only if the candidate is not worse; otherwise restore the previous bytes and say so

When it survives, the bot writes `.data/workspaces/<guild>/.opencode/skills/learned-playbook/SKILL.md`, records the
version (content + sha256) in `artifacts`, and **commits the workspace repo** — so `/skills revert:1` restores the
exact earlier bytes and the history of what it taught itself stays inspectable. Fixtures assert tool usage, output
patterns, and forbidden leaks, and can add a Jev yes/no judgement on the answer.

A scheduler runs deterministic upkeep: memory consolidation (dedupe, decay, prune, rewrite `MEMORY.md`) every 6 h
and a database snapshot every 24 h.

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

### File-edit policy

Every workspace is a git repo with an initial commit. Inside `repo/` the agent may write and edit **without an
approval card** — that is the code sandbox, each turn is committed (`agent: turn …`), and `/undo` reverts the last
turn. Control files stay denied to the agent (`opencode.json`, `AGENTS.md`, `.opencode/**`, `MEMORY.md`), and any
edit outside `repo/` still asks a human.

## Ops (Linux VM)

```bash
sudo cp deploy/oda.service /etc/systemd/system/oda.service
sudo systemctl enable --now oda
journalctl -u oda -f
```

- Data lives in `.data/` (SQLite `agent.db`, workspaces, console token, opencode runtime dirs). Snapshot it with
  `bun run commands backup` (`VACUUM INTO .data/backups/…`, keeps the last 14) — safer than copying a live DB.
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
| a tool sits at "write · pending" | a `write`/`edit` outside `repo/` is waiting for an approval card — answer it, or move the work under `repo/` where edits are click-free; the streaming message now says `🔒 waiting for approval` when this happens |
| shell refuses with "docker is not available" | start Docker or set `shell.mode: "host"` for that guild |
| `Free usage exceeded, subscribe to Go` | the model call used the free tier: run `bun run auth` so a Go-entitled key is stored, then `bun run doctor` (expect `✅ go subscription 200`) |
| `Unknown interaction` (10062), or commands answer "The application did not respond" | the gateway delivered the interaction after Discord's 3s window — usually a second process on the same token (the lock file blocks that) or a paused host; `/ping` reports interaction latency, gateway ping and pid |
| the agent says "question · running" and nothing arrives | it used opencode's `question` tool; the card should be posted in the channel (answer buttons or a select). If it is missing, check the bot log for `could not post question card` |
| approvals never appear | check `/status` → `policy`; the event name is `permission.asked` (not `permission.updated`) |
| commands appear twice | deploy once per scope: `bun run commands deploy --guild` clears the global set, `--global` clears the guild copy |
| `/enable` says owner only | `OWNER_ID` in `.env` must be your Discord user id |
