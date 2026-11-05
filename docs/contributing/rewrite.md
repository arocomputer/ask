# Rewriting ask in TypeScript

A working plan, not a description of shipped behavior. Delete it once the rewrite lands.

## Thesis

The engine is known: ask's own loop, a handful of tools, sessions on disk. It ports from the Go
version, which stays in the tree as the reference until parity, minus the redundancy listed
below.

The interface an agent uses is not known. Research and two experiments say the doorway (flags,
JSON, MCP) is a wash; what moves time, tokens and correctness is how an agent waits for work
and how it refers to work it started. Those get decided by running real driving agents against
variants, not by argument.

## Decided

- npm package `@arocomputer/ask`, ESM, no runtime dependencies.
- Bun builds, runs and later compiles the release binary. The code uses only `node:` built-ins
  and web standards, so it also runs on Node 24+ and embeds in either. Tests use `node:test`
  and run under both. Node won't strip types inside `node_modules`, so the published package
  ships compiled JavaScript and declarations.
- **models.dev is the provider registry.** A model's `npm` field picks its protocol and its
  `provider.api` overrides the endpoint: `@ai-sdk/openai` speaks Responses,
  `@ai-sdk/anthropic` speaks Anthropic Messages, anything else with an endpoint speaks chat
  completions. Credentials come from the provider's `env` variables or keys pasted into
  `~/.ask/auth.json`; ask never imports another program's credentials.
  The catalog is cached in `~/.ask/cache/` and refreshed daily, stale copy as fallback.
- **Three protocols:** Responses, chat completions, Anthropic Messages. Google's native API and
  cloud-specific ones (Bedrock, Azure) wait for a need.
- One transcript format across protocols, so any model can continue any session. Each
  assistant message keeps its provider-native items, replayed only to the same protocol (for
  encrypted reasoning and thinking signatures).
- **The JSON request is the agent interface.** `ask` reads one request on stdin and writes one
  response on stdout: `start` (many tasks at once, optionally waiting), `collect`, `continue`,
  `stop`, `show`. Every response is `{"tasks": [...]}` or `{"error": {"message", "hint"}}`.
  The library's `handle` takes the same object, and MCP will wrap it later. `ask help requests`
  documents it; `protocol.ts` defines it.
- **The command line is only for people, and small:** `ask settings` (the one interactive
  command: its first run adds a provider, its key, models and default; later runs ask what to
  change, do it and exit), `ask doctor` (checks runtime, home,
  catalog, model, key, worker and git, with a fix for each failure), `ask models`,
  `ask sessions`, `ask show`. Settings live in `config.json` and `auth.json`, editable by hand,
  or a provider's environment variable.
- **Prompts:** one `? Question` line with
  typed filter text after it and key help in brackets, a page of seven options with `> ` on
  the focused one, `[x]` toggles with Enter to finish, and each answered prompt collapses to
  `? Question Answer`, leaving a readable record. No titles, menus that loop, or footers.
- **Looks:** text in the terminal's own color, bold for headers and the subject of a
  line, gray for details, green ✓ / red X / yellow * only on state symbols, cyan only for what a
  prompt has selected. Color and prompts only on a terminal, honoring `NO_COLOR`; piped tables
  are tab-separated.
- A TUI waits until after phase 3; the case for it is a live view of running subagents.

## Stripped from the Go version

- `events.jsonl` and its cursor paging: activity is read from the transcript, which is saved
  after every tool call.
- Prices, `max_cost` and `models.json`. Usage is tokens; limits are a timeout and a step count.
- Two model syntaxes and `#effort`: models are `provider/model`, effort is its own field.
- Streaming text callbacks nobody read.
- The worker's pipe handshake, fcntl locks and the container special case: one lock file holding
  the worker's pid.
- The executable-extension contract, the `x` script, `guard.sh` (its rules become a test),
  `install`/`remove`, and importing OpenCode's key during setup.
- The flag commands `ask PROMPT`, `wait`, `continue`, `stop`, `config`, `auth` and `setup`, and
  `--json` on each: agents use requests, people use the commands above and the files.

## Fixed in the harness

- `read` numbers its lines, since answers must cite them.
- `grep` is one implementation (git's file list or a walk, JavaScript regular expressions)
  instead of three backends with different rules.
- `list` takes a recursive pattern like `src/**/*.ts`.
- Read-only tool calls in one model turn run in parallel.
- Retries have a total budget, give up on slow 5xx failures and report `retrying`.
- When the conversation outgrows the context, old tool outputs are elided and the turn retried
  once before failing.

## Phases

1. **Engine.** Catalog, the three protocols, tools, loop, system prompt, as plain functions.
   Tests against fake provider servers, one behavior each.
2. **Sessions, requests and the human CLI.** Session folders, a detached worker per turn; the
   request protocol as a baseline; settings, doctor and the viewing commands. Still to port: worktrees (a `worktree`
   task field), and running turns in the host's process for the library.
3. **Interface experiments.** Two or three variants of the request protocol, driven by Claude Code
   (Sonnet) and Codex on this server, with `experiments/fake2.py` as the subagent model.
   - Waiting: block per call, return the first finished, or start and collect in one call.
   - Referring: random ids, names the caller picks, or no reference needed.
   - Measured: correct answer, seconds over the critical path, driver tokens, calls, failed
     calls. Three reps per cell.
4. **Lock.** Write the winner's protocol, docs and changelog. Port the Go black-box tests' intent.
5. **Real providers and sign-ins**, alongside 3.
   - First real call per protocol, with an OpenCode Go API key in `~/.ask/auth.json`. (Solved:
     the old key in OpenCode's v1 `auth.json` was a leftover, inactive in OpenCode's credential
     store; OpenCode itself authenticates with an account sign-in.)
   - **OpenCode sign-in:** `ask settings` signs in to the OpenCode account the way OpenCode does,
     with access and refresh tokens, and ask refreshes its own login. Never reuse OpenCode's
     stored tokens: two programs refreshing one login sign each other out. Find the flow from
     OpenCode's source and docs before building it; ship it labeled as relying on OpenCode's
     sign-in, which isn't a published API for other clients.
   - **ChatGPT sign-in**, the same way, labeled unofficial.

## Not now

MCP, remote hosts, the Homebrew binary, Claude and Codex as harnesses, parent scoping beyond
what phase 3 needs.

## Risks

- A rewrite throws away a tested core; the Go tree stays until parity.
- Three protocols triple the surface that can drift from what providers actually accept; only
  real calls prove them, and none has succeeded yet.
- Driver runs spend the owner's Claude and Codex quota: about 50 to 60 runs for phase 3.
- Bun's Node compatibility is thinnest around detached processes and signals, which phase 2
  relies on; tests run under both runtimes to catch it.
