# Architecture

ask is TypeScript with no runtime dependencies, on Node 24 or Bun. It turns a JSON request into
sessions, runs each turn in a detached worker, and records what happened. The worker runs ask's
own agent loop against a model provider.

`src/` is in layers, lowest first; a file imports only from its own layer and those below it,
which `test/rules.test.ts` checks. `test/` mirrors `src/`, one file per area.

| Layer | Holds |
| --- | --- |
| `base/` | Nothing particular to ask: `home` (the folder, its files and their shapes), `term`, `input`, `git`, `version` |
| `providers/` | Reaching models: `catalog` (models.dev), `stream` (the transcript format, server-sent events, errors, retries), `responses`, `chat`, `anthropic` (one client per protocol), `chatgpt` (the ChatGPT sign-in) |
| `sandbox/` | Confining tools: `policy` (what they may touch), `linux` (ask.sandbox and bubblewrap), `macos` (Seatbelt), `address` (public-address checks), `confine` (per-turn execution) |
| `agent/` | ask's own loop: `loop`, `tools`, `fetch`, `search` (ask's own web search: DuckDuckGo, its lite page, Mwmbl, Wikipedia), `system` (the prompt), `steps` (a turn's steps in a few words) |
| `harnesses/` | Other agents: `harness` (the contract, running a CLI, history handoff, loading extensions), `claude`, `codex`, `extensions` (what is on, the calling conversation), `skill` |
| `sessions/` | A request's life: `protocol` (the agent interface), `store` (session folders, turns, the lock), `worker` (running a turn, detached), `models` (which model and key a task uses) |
| `commands/` | What people run: `settings`, `doctor`, `models`, `sessions`, `show`, `legacy`, `tools`, `install`, `remove`, and `command`, their shared shape |
| `cli.ts`, `index.ts` | The entry points: the command, and the library |

`native/sandbox.c` is the one file that isn't TypeScript: the Linux sandbox helper, built into
`native/build/` (from source in a checkout, by `zig cc` for releases). The sandbox's design is
[sandbox.md](sandbox.md).

## How a turn goes

```text
ask < request.json                         cli.ts reads it; sessions/protocol.ts checks every task
  │  protocol    start, collect, continue, stop, show; results and hints
  │  sessions    the folder, session.json, transcript.json, the lock
  │  worker      launch: a detached `ask __worker FOLDER`, its pid in the lock
  ▼
ask __worker FOLDER                         sessions/worker.ts, in its own session of the system
  ├─ loop        provider ⇄ tools, until an answer or a limit; saves after every step
  │    catalog       models.dev: which protocol and endpoint each model uses
  │    responses, chat, anthropic   one client per protocol, over provider.ts
  │    tools         read, list, grep, fetch, search; write, edit, shell in a write turn
  │    sandbox       tools and commands: ask.sandbox/bubblewrap or Seatbelt
  │    system        the system prompt and the project's AGENTS.md
  └─ git         what a write turn changed; worktrees
  ▼
session.json: the turn succeeded, failed or stopped     collect, show and ask sessions read it
```

The launcher records a "starting" lock before it spawns the worker and the worker's pid right
after, so a turn always has a live owner or is visibly lost. Everything else reads the folder:
collect polls `session.json`, show reads `transcript.json`, stop signals the lock's pid. A turn
whose worker is gone is restarted from its transcript by the next collect, after claiming that
restart with an atomic folder create. Continue and stop use the same generation-scoped claims;
records are re-read under a claim. A live transition owner prevents another caller from taking
over, and abandoned claims use immutable retry slots. Per-turn raw-file baselines survive worker
death, so a restarted write turn reports changes made before the crash too.

## Rules the layout keeps

[`test/rules.test.ts`](../../test/rules.test.ts) checks these on every change:

- **No runtime dependencies.** `package.json` lists only development tools.
- **Only Node's built-ins.** The engine imports `node:` modules and its own files, and nothing
  that is particular to Bun, so it runs on both.
- **Each harness in one place.** ask ships two harnesses, Claude Code and Codex, and how each
  is run (its command-line flags) lives in its own file, `claude.ts` or `codex.ts`. No other
  coding agent is named; more come as extensions.
- **Layers only look down.** A file imports from its own layer and the ones below it, never
  above, so each layer can be understood, and tested, without the ones on top.
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
