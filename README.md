# open-discord-agent

A Discord-native agent that answers in chat **and acts** — creates channels, reads the member list, manages
roles, writes code — on an opencode backend. Any model from any provider it is given a credential for: the
OpenCode Go subscription by default, or OpenAI, Anthropic, Gemini, OpenRouter, a local Ollama/vLLM endpoint, or
anything else that speaks the OpenAI API.

Built on the [`discord-bot-template`](https://github.com/ras-rap/discord-bot-template/tree/rewrite) conventions:
discordx decorators discovered by `@discordx/importer`, reusable guards, pino logging, a command-registration
CLI, ESLint + Prettier, and Bun as the runtime.

Design and the measurements behind it: [`PLAN.md`](./PLAN.md).

**Status:** chat/streaming, the 26 Discord tools, tier policy + Jev shadow gate, approval cards, memory v1,
per-guild model selection and the learning loop with its A/B eval gate are implemented and exercised
(`bun test`, `bun run smoke`, `bun run e2e` against the live gateway). Cross-day recall verification remains;
`PLAN.md` §8 tracks it.

## Requirements

| Need | Why |
| --- | --- |
| Bun ≥ 1.1 | runtime (`bun:sqlite`, `Bun.spawn`, `Bun.serve`) |
| A Discord bot token | Dev Portal → your app → Bot → Reset Token |
| `GuildMembers` + `MessageContent` intents | member listing, and reading what a mention actually says |
| One model provider | default is the OpenCode Go subscription (`bun run auth`); a plain API key works too |
| Docker daemon | default shell sandbox; `shell.mode: "host"` opts out per guild |

## Quick start

```bash
bun install
bun run setup          # validates the token, picks a provider, writes .env, publishes the commands
bun run auth           # only for the default OpenCode Go models: stores the credential Go accepts
bun run doctor         # preflight: binary, token, providers, role models, docker, clock skew
bun run start          # run the bot
```

Then in your server: `/enable` (owner only), and `/ask <prompt>` or mention the bot. `/help` describes itself.

`bun run setup` is a conversation, not a config file: it checks the token against Discord, warns when the
privileged intents are still off, fills in the application id and your owner id automatically, writes `.env`
(mode `0600`) without touching anything else already in it, and offers to publish the slash commands.

### Manual setup

If you would rather edit files:

```bash
cp .env.example .env    # DISCORD_TOKEN, DISCORD_CLIENT_ID, OWNER_ID, DISCORD_DEVELOPMENT_GUILD_ID
bun run commands deploy # guild scope in development, global in production
bun run doctor
bun run smoke           # offline end-to-end: server, prompt, stream, approval, question, jev
bun run start
```

## Models and providers

The bot asks for **roles**, never for a model name:

| Role | Env | Default | Used for |
| --- | --- | --- | --- |
| primary | `MODEL_PRIMARY` | `opencode-go/crouton-alpha-free` | chat, code, tool use |
| fast | `MODEL_FAST` | `opencode-go/beam-free` | reflection, memory extraction, consolidation |
| jev | `MODEL_JEV` | `jev-1.13-free` | typed safety decisions (called directly, so no `provider/` prefix) |

`/model current` shows what a server is running, `/model list` shows everything the guild's agent server can
actually run, and `/model set` switches one guild (admins). The guild's server restarts on the next prompt so
the new default is loaded; the session and its memory survive. The override lands in `config/guilds.json`:

```jsonc
{ "123456789012345678": { "enabled": true, "model": { "primary": "opencode-go/gpt-5.6-luna" } } }
```

### Catalogue providers

These are known to the pinned server; a credential in `.env` is all it takes. The variable names are the ones
the server itself reads, so a key stored under another name is ignored.

| Provider id | Credential | Example model |
| --- | --- | --- |
| `opencode-go` | `bun run auth` (or `OPENCODE_GO_API_KEY`) | `opencode-go/gpt-5.6-luna` |
| `opencode` | keyless free tier | `opencode/beam-free` |
| `openai` | `OPENAI_API_KEY` | `openai/gpt-5.3-codex` |
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4-5` |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | `google/gemini-2.5-pro` |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter/anthropic/claude-sonnet-4.5` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek/deepseek-chat` |
| `groq` | `GROQ_API_KEY` | — |
| `mistral` | `MISTRAL_API_KEY` | — |
| `xai` | `XAI_API_KEY` | — |
| `cerebras` | `CEREBRAS_API_KEY` | — |
| `togetherai` | `TOGETHER_API_KEY` | — |

Provider ids never contain a slash, model ids may (`openrouter/anthropic/claude-sonnet-4.5`), and the resolver
matches the longest known provider id — a typo like `opengai/gpt-5` fails at `/model set` and in `doctor`
instead of at answer time. `MODEL_ALLOWLIST` pins the whole deployment to an exact comma-separated list when
you want the old hard allowlist back.

### Local runtimes and private gateways

Anything that speaks the OpenAI API but is not in the catalogue is declared in `config/providers.json`
(copy [`config/providers.example.json`](./config/providers.example.json) — it ships Ollama, vLLM and LM Studio
entries). Keys are *named*, never inlined:

```jsonc
{
  "ollama": {
    "label": "Ollama (local)",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "models": {
      "qwen3-coder:30b": { "name": "Qwen3 Coder 30B", "toolCall": true, "contextLimit": 262144 }
    }
  }
}
```

`apiKeyEnv` names the variable holding the key (omit it for a keyless local runtime), `npm` defaults to
`@ai-sdk/openai-compatible`, and `toolCall`/`reasoning`/`attachment`/`contextLimit`/`outputLimit` describe the
model so `/model list` and the tool loop behave. Workspace configs reference credentials as `{env:NAME}`, so no
secret is ever written into a workspace repository. `bun run setup` asks the endpoint for `/v1/models` and
writes the entry for you.

## Scripts

| Command | Effect |
| --- | --- |
| `bun dev` | watch mode |
| `bun start` | run once |
| `bun run setup` | interactive first-run: token check, provider + model choice, `.env`, command deploy |
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
  commands/                slash commands and component interactables (agent, model, help, admin, approvals)
  events/                  ready, mention prompts, interaction safety net
  guards/                  cooldown, guildOnly, ownerOnly, guildEnabled, managerOnly
  cli/                     `bun run commands …` dispatcher + setup/deploy/clear/list, auth/doctor/smoke/e2e
  services/
    config.ts              guilds.json, paths, role models, shell defaults
    agent/                 binary, client, provider registry, model resolver, error diagnosis, supervisor, runtime
    bridge/                26 Discord capabilities + loopback RPC server
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
| `/ask <prompt>` | run a task in this channel — one progress message is edited live, then the answer arrives as a new message that pings you |
| `/help` | what the agent can do, grouped by tool risk |
| `/model current` | roles, their source, and which providers are ready |
| `/model list [filter]` | every model this server can run |
| `/model set model:<id> [role]` · `/model reset [role]` | switch or drop a guild's model (admin) |
| `/vibe on\|off` | run tool calls without approval cards, Jev screening the dangerous ones (admin) |
| `/config show` · `/config set <key> <value>` · `/config reset <key>` | permissions, sandbox, models and policy — scope-checked (admin, or bot owner for the dangerous keys) |
| `/new` | fresh opencode session for this channel |
| `/abort` | interrupt the running task |
| `/status` | servers, sessions, approvals, sandbox, policy, models, gateway, recent decisions |
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

### What a turn looks like in the channel

1. one message says `🧠 thinking…` and is edited in place — the partial answer, the current tool call, and the
   model's reasoning as it is published — so the channel never fills with tool chatter;
2. when the turn ends that message stays as the turn's **log** (`🧠 log · 42s · 3 steps`, the tool calls in
   order, then the chain of thought as a quote) and the answer is posted as its **own message that pings
   whoever asked** (long answers continue in follow-up chunks, mention on the first only). Reasoning only
   appears for models that publish reasoning parts; a model that answers straight from context logs its steps
   alone;
3. approval cards are removed the moment they are decided, expired, or the turn ends — the record stays in
   `/audit` instead of in the channel;
4. a **round that ends on a failed tool call is continued, not accepted**: the same session is prompted again
   with the error in hand (`🔁 … asking it to finish`), twice at most. That is what turns "Plan confirmed —
   building…" plus a denied `write` into an actual result, or into an answer that says it could not do it;
5. if it still ends on failures, the answer carries a `⚠️ N tool call(s) failed` quote listing the tool and the
   error, so a turn can never read as a clean success when something broke. A policy refusal is recorded in
   `/audit` (`layer: vibe`) whether it was made by a human or by Jev;
6. a turn is abandoned only after `IDLE_TIMEOUT_MS` (10 min) of **silence** — continuous streaming or tool
   calls reset that clock, so slow work is never killed. On a timeout the session is aborted, the channel is
   rebound to a fresh session so the next message works normally, and the partial output is posted with a
   `⏱️ interrupted` note.

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

- **reflection** — after a turn that used tools or asked for something durable, the `fast` role re-reads the turn
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
3. **lessons** — the `fast` role turns turns into `facts`/`preferences`/`lessons`.

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

Default ceilings — every cell is overridable per guild with `/config set policy.matrix.<rank>.<risk>`:

| Rank | read | reversible | destructive | admin |
| --- | --- | --- | --- | --- |
| owner / guild owner | allow | allow | allow | allow |
| admin (config role) | allow | allow | allow | ask |
| trusted (config role) | allow | allow | ask | deny |
| member | allow | ask | deny | deny |
| guest / DM | allow | deny | deny | deny |

### Modes

| `policy.mode` | What a call the ceiling does not allow outright does |
| --- | --- |
| `ask` (default) | posts an approval card and waits for a human |
| `vibe` | runs it — Jev reads the call first and vetoes what looks dangerous |
| `locked` | refuses everything above `read`, whatever the rank says |

`/vibe on|off` is the one-word switch for `vibe`; `/config set policy.mode …` does the same and reaches the rest.

**Vibe is "run it unless it looks dangerous", not "run anything".** A rank ceiling that says `deny` still
denies — vibe removes the *approval step* for people already entitled, it never promotes anyone. Then, per
call, Jev is asked how destructive it is and whether an admin would approve:

| Jev reading | Vibe does |
| --- | --- |
| `catastrophic` | refuses, whatever the rank or score |
| `destructive` with approval below `policy.vibe.minApproval` (0.4) | refuses — the sandbox does not make `rm -rf` fine |
| destructive-class call Jev rates reversible/destructive | needs `minApproval + 0.2`, because Jev reads coarse classes loosely (a `permission_set Administrator` came back "reversible" at 0.45) |
| destructive-class call Jev calls `read_only` with low confidence | asks a human — an unconfident "it's safe" is not a green light for a delete |
| anything above `policy.vibe.maxRisk` | asks a human |
| Jev unreachable | asks, unless `policy.vibe.askOnUncertain` is false |
| otherwise | runs it |

The agent server's own permission asks (`bash`, `edit` outside `repo/`, `webfetch`) go through the same screen,
and a shell call is classed reversible inside the docker sandbox but destructive in `host` mode. Every
auto-decision lands in `/audit` with `layer: vibe`, so a refused write is explainable afterwards instead of
appearing as a bare `✗ write` in the log. Real readings
from a vibe-mode test: `message_send` allow (Jev: reversible, 0.67), `channel_delete` deny (destructive, 0.24),
`permission_set Administrator` deny (0.45), `bash bun test` allow, `bash rm -rf /` deny (catastrophic),
`edit /etc/passwd` ask (an unconfident "safe" reading).

### `/config` — everything that is configurable

`/config show` prints the mode, the effective rank table (with `*` on cells this guild overrides), the sandbox,
the models, and how many keys *you* may change. `/config set <key> <value>` and `/config reset <key>` are
scope-checked before anything is written:

| Scope | Keys |
| --- | --- |
| guild admin | `policy.mode`, `policy.vibe.maxRisk|screen|minApproval|askOnUncertain`, `policy.tools.deny`, `model.primary`, `model.fast` |
| **bot owner only** | `shell.mode` (`host` runs shell calls as the bot user), `shell.image`, `shell.fallback`, `policy.tools.allow` (bypasses the card for everyone), `policy.matrix.*` (20 cells), `roles.admin`, `roles.trusted`, `enabled` |

So a guild admin can make the bot chattier or stricter, but cannot turn the sandbox off, grant themselves a
capability, rewrite the rank table, or widen what bypasses approval — those need `OWNER_ID` in `.env`.
`/config reset` restores the schema default exactly (empty containers included), and every value is validated
before the write, so a typo leaves the file untouched.

Models run wherever `.env` points them. The default is the **OpenCode Go** subscription: provider
`opencode-go`, base URL `https://opencode.ai/inference/go`, authenticated with a Console API key (`oc_sk_...`)
that the supervisor injects as `OPENCODE_GO_API_KEY`. Go is a different endpoint from the free tier — a
keyless/free call answers "Free usage exceeded, subscribe to Go", which is what `bun run doctor` checks
explicitly (`go subscription`). When a role names another provider, `doctor` skips that check instead of
reporting a failure.

`JEV_MODE=shadow` (default) logs Jev's reading of every non-read call while the tier table still decides;
`enforce` lets Jev auto-allow high-confidence low-risk calls and deny anything it rates catastrophic or
unlikely to be approved. Without a credential the gate degrades to "ask a human", never to allow.

`config/guilds.json` (created by `/enable`, not committed):

```jsonc
{
  "123456789012345678": {
    "enabled": true,
    "shell": { "mode": "docker", "image": "debian:bookworm-slim", "fallback": "error" },
    "roles": { "admin": ["111..."], "trusted": ["222..."] },
    "model": { "primary": "opencode-go/gpt-5.6-luna" }
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

Failures are classified before they reach the channel: a provider error is replaced by a one-line diagnosis and
the command that fixes it (`src/services/agent/errors.ts`), and the cause is logged as a stable code
(`go-subscription`, `auth`, `model-unavailable`, `rate-limit`, `context`, `network`, `tool-support`,
`interaction-expired`).

| Symptom | Cause |
| --- | --- |
| `opencode binary not found` | postinstall skipped → `bun pm trust opencode-ai && bun install` |
| `server reported version X, expected 1.19.5` | a different binary is being picked up → `bun run doctor`, check `OPENCODE_BIN` |
| member list is empty | `GuildMembers` intent not enabled in the Discord portal (`setup` warns about this) |
| a tool sits at "write · pending" | a `write`/`edit` outside `repo/` is waiting for an approval card — answer it, or move the work under `repo/` where edits are click-free; the streaming message says `🔒 waiting for approval` |
| shell refuses with "docker is not available" | start Docker or set `shell.mode: "host"` for that guild |
| "The model call fell through to the free tier" | the model call used the free tier: run `bun run auth` so a Go-entitled key is stored, then `bun run doctor` (expect `✅ go subscription 200`) |
| "The provider rejected the credential" | the key for the provider in `/model current` is wrong, revoked, or stored under another name — check `.env`, then `bun run doctor` |
| "That model is not available from this provider" | `/model list` for what the server offers, then `/model set` |
| `unknown provider "x"` | the provider has no credential and is not declared — add the key to `.env` or an entry to `config/providers.json` |
| a local model answers but never calls a tool | the runtime/model does not do function calling — mark it `"toolCall": true` only once it does, or pick another model |
| `Unknown interaction` (10062), or commands answer "The application did not respond" | the gateway delivered the interaction after Discord's 3s window — usually a second process on the same token (the lock file blocks that) or a paused host; `/ping` reports interaction latency, gateway ping and pid |
| the agent says "question · running" and nothing arrives | it used opencode's `question` tool; the card should be posted in the channel (answer buttons or a select). If it is missing, check the bot log for `could not post question card` |
| approvals never appear | check `/status` → `policy`; the event name is `permission.asked` (not `permission.updated`) |
| the log shows `0 steps` and no thinking | that turn used no tools and the model published no reasoning part — not an error |
| a turn says `⏱️ interrupted after 10 min without output` | the provider stopped emitting events; the session was aborted and a fresh one bound to the channel, so the next message runs normally. Raise `IDLE_TIMEOUT_MS` if your runtime is just slow |
| an answer arrives but pings nobody | the requester must still be in the channel — the mention is `<@id>` on the first chunk of the answer |
| commands appear twice | deploy once per scope: `bun run commands deploy --guild` clears the global set, `--global` clears the guild copy |
| slash commands lost their arguments | every `deploy`/`list` run now calls `MetadataStorage.build()` first; a payload published by an older build has to be redeployed (options and slash groups are attached there) |
| `/enable` says owner only | `OWNER_ID` in `.env` must be your Discord user id |
