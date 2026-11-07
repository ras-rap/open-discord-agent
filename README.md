# open-discord-agent

A Discord-native agent that answers in chat **and acts** — creates channels, reads the member list, manages
roles, writes code — on an opencode backend, using only `crouton-alpha-free`, `beam-free`, and
`jev-1.13-free`.

Design and the measurements behind it: [`PLAN.md`](./PLAN.md).

**Status:** chat/streaming, the 14 Discord tools, tier policy + Jev shadow gate, approval cards, and memory v1
are implemented and exercised (`bun test`, `bun run smoke`, `bun run e2e` against the live gateway). The
evolution loop (self-editing skills with A/B evals) and cross-day recall verification are the remaining
slices; `/status` and `PLAN.md` §8 track them.

## What it is

- **Chat + action.** `discord_*` tools (14 of them) go through a loopback bridge that re-authorises every call
  against the rank of the person who asked.
- **Real code work.** Each guild gets its own workspace with the full opencode toolset (edit, read, grep,
  LSP, shell) rooted in that directory.
- **Permissioned.** Five layers: Discord rank → risk ceiling → Jev safety gate → `permission.asked` approval
  cards → audit log. Fail-closed everywhere.
- **One opencode server per guild workspace.** Config, custom tools and permission rules are resolved from a
  server's own cwd (measured), so this is what makes per-guild policy real; idle servers unload after 30 min.

## Requirements

| Need | Why |
| --- | --- |
| Bun ≥ 1.1 | runtime (`bun:sqlite`, `Bun.spawn`, `Bun.serve`) |
| Docker daemon | default shell sandbox; `shell.mode: "host"` opts out per guild |
| OpenCode login on the machine | `bun run auth` copies the console token used for Jev |
| Discord bot | `GuildMembers` + `MessageContent` privileged intents enabled in the dev portal |

## Setup

```bash
bun install
cp .env.example .env          # DISCORD_TOKEN, BOT_CLIENT_ID, OWNER_ID
bun run doctor                # preflight: binary, allowlist, token, docker, capabilities
bun run auth                  # copies the opencode console token into .data/console-token.json (0600)
bun run smoke                 # offline: spawns a server, prompts, streams, exercises permission + jev
bun run e2e                   # live: real gateway, model calls a Discord tool through the bridge
bun run start                 # runs the bot
```

Then in your server: `/enable` (owner only), and `/ask <prompt>` or mention the bot.

## Commands

| Command | Effect |
| --- | --- |
| `/ask <prompt>` | run a task in this channel (streamed) |
| `/new` | fresh opencode session for this channel |
| `/abort` | interrupt the running task |
| `/status` | servers, sessions, approvals, sandbox, policy, recent decisions |
| `/audit` | last 10 policy decisions in this server |
| `/remember <text>` | store a durable fact (rewrites the workspace `MEMORY.md`) |
| `/memory [query] [forget]` | search, show stats, or delete a memory by id |
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

`JEV_MODE=shadow` (default) logs Jev's reading of every non-read call while the tier table still decides;
`enforce` lets Jev auto-allow high-confidence low-risk calls and deny anything it rates catastrophic or
unlikely to be approved. Without a console token the gate degrades to "ask a human", never to allow.

`config/guilds.json`:

```jsonc
{
  "123456789012345678": {
    "enabled": true,
    "shell": { "mode": "docker", "image": "debian:bookworm-slim", "fallback": "error" },
    "roles": { "admin": ["111..."], "trusted": ["222..."] }
  }
}
```

`shell.fallback: "host"` lets a guild fall back to the host shell when Docker is down; `"error"` (default)
refuses to execute.

## Ops (Linux VM)

```bash
sudo cp deploy/oda.service /etc/systemd/system/oda.service
sudo systemctl enable --now oda
journalctl -u oda -f
```

- Data lives in `.data/` (SQLite `agent.db`, workspaces, console token, opencode runtime dirs). Back it up
  with `sqlite3 .data/agent.db "VACUUM INTO '/backup/agent-$(date +%F).db'"`.
- The bot never uses the globally installed `opencode`; the pinned 1.19.5 binary comes from `bun install`
  and the boot guard refuses to start on a version mismatch.
- Restart safety: sessions and their opencode server ports are re-created on demand; a killed server's
  conversation continues from the same session id in the next prompt.

## Troubleshooting

The bot takes a lock at `.data/bot.lock` and refuses to start while another process holds it: a second login invalidates the first gateway session, after which interactions arrive late and every reply fails with `Unknown interaction` (10062).

| Symptom | Cause |
| --- | --- |
| `opencode binary not found` | postinstall skipped → `bun pm trust opencode-ai && bun install` |
| `server reported version X, expected 1.19.5` | a different binary is being picked up → `bun run doctor`, check `OPENCODE_BIN` |
| member list is empty | `GuildMembers` intent not enabled in the Discord dev portal |
| shell refuses with "docker is not available" | start Docker or set `shell.mode: "host"` for that guild |
| `Unknown interaction` (10062), or commands answer "The application did not respond" | the gateway delivered the interaction after Discord's 3s window — usually a second process on the same token (the lock file now blocks that) or a paused host; `/ping` reports interaction latency, gateway ping and pid |
| approvals never appear | check `/status` → `policy`; the event name is `permission.asked` (not `permission.updated`) |
| commands appear twice | exactly one scope may hold them: set `REGISTER_GUILD_ID` (guild-scoped, instant, globals cleared) or leave it unset (global, guild copies cleared) |
| a command says "The application did not respond" | the handler threw, was used in a DM, or the command definition has not reached that guild yet — set `REGISTER_GUILD_ID` in `.env` so commands are published guild-scoped, and check the `interaction received` log line |
