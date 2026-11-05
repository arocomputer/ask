# Architecture

ask is TypeScript with no runtime dependencies, on Node 24 or Bun. It turns a JSON request into
sessions, runs each turn in a detached worker, and records what happened. The worker runs ask's
own agent loop against a model provider.

`src/` holds the engine, one module per purpose, one word per file; `src/cmd/` holds the commands
for people. `test/` holds the tests, one file per area.

## How a turn goes

```text
ask < request.json                         cli.ts reads it; protocol.ts checks every task
  │  protocol    start, collect, continue, stop, show; results and hints
  │  sessions    the folder, session.json, transcript.json, the lock
  │  worker      launch: a detached `ask __worker FOLDER`, its pid in the lock
  ▼
ask __worker FOLDER                         worker.ts, in its own session of the system
  ├─ loop        provider ⇄ tools, until an answer or a limit; saves after every step
  │    catalog       models.dev: which protocol and endpoint each model uses
  │    responses, chat, anthropic   one client per protocol, over provider.ts
  │    tools         read, list, grep; write, edit, shell in a write turn
  │    system        the system prompt and the project's AGENTS.md
  └─ git         what a write turn changed; worktrees
  ▼
session.json: the turn succeeded, failed or stopped     collect, show and ask sessions read it
```

The launcher records a "starting" lock before it spawns the worker and the worker's pid right
after, so a turn always has a live owner or is visibly lost. Everything else reads the folder:
collect polls `session.json`, show reads `transcript.json`, stop signals the lock's pid. A turn
whose worker is gone is restarted from its transcript by the next collect, after claiming that
restart with an atomic folder create.

## Modules

| Module | Purpose |
| --- | --- |
| `cli` | Dispatch, help pages, errors, exit status, the worker's entry |
| `protocol` | The agent interface: requests, results, hints, `ask help requests` |
| `sessions` | Session folders, turns, the lock, whether a turn is alive, restart claims |
| `worker` | Launching a detached worker, and running a turn in it |
| `loop` | The agent loop, interrupted tool calls, eliding old outputs |
| `provider` | The transcript format, server-sent events, provider errors, retries |
| `responses`, `chat`, `anthropic` | One protocol client each |
| `catalog` | The models.dev catalog: loading, finding a model, connecting to it |
| `tools` | The six tools and path confinement |
| `system` | The system prompt |
| `steps` | A turn's steps in a few words each |
| `git` | Changes a write turn made, worktrees |
| `home` | `~/.ask`, config.json, auth.json, credentials, the catalog with ChatGPT's models |
| `claude` | Running a `claude/` turn with the user's Claude Code: finding it, its controls, reading its stream into steps |
| `chatgpt` | Signing in with a ChatGPT plan: the sign-in, checking the ID token, renewing under a shared lock, signing out, the account's models |
| `term`, `input` | Terminal output and interactive prompts |
| `version` | The version, from package.json |
| `cmd/*` | `settings`, `doctor`, `models`, `sessions`, `show` |

## Rules the layout keeps

[`test/rules.test.ts`](../../test/rules.test.ts) checks these on every change:

- **No runtime dependencies.** `package.json` lists only development tools.
- **Only Node's built-ins.** The engine imports `node:` modules and its own files, and nothing
  that is particular to Bun, so it runs on both.
- **One coding agent, in one place.** The only coding agent ask runs is Claude Code, for
  `claude/` models, and how it runs it lives in `claude.ts` alone; no other is named.
- **Every module says what it is for.**

Two more are kept by tests and review:

- **Grow by need.** A new tool, request field or setting arrives with the use that needs it.
- **The request protocol changes carefully.** New fields are free; changing or removing one breaks
  every agent that uses it.

## Trying a development build

```sh
bun install
bun src/cli.ts doctor      # or node src/cli.ts
npm run check && npm test  # the typecheck, then the tests under Node and Bun
```

Set `ASK_HOME` to a scratch folder to keep a development build away from your sessions.
