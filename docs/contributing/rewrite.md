# Rewriting ask in TypeScript

A working plan, not a description of shipped behavior. Delete it once the rewrite lands; what
remains open is phase 5.

## Thesis

The engine is known: ask's own loop, a handful of tools, sessions on disk. It is ported from the
Go version, now removed (it is in git history), minus the redundancy listed below.

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
2. **Sessions, requests and the human CLI.** Done: session folders, a detached worker per turn,
   the request protocol, `ask settings`, `ask doctor`, `ask models`, `ask sessions`, `ask show`.
   The library's `handle` uses the same detached workers: a second way to run turns in the
   host's process would have to match stopping, resuming and crash handling, and no host needs
   it yet.
3. **Interface experiments.** Done (`.handoff/experiments/phase3/results.md`). Ids stay; names
   showed no benefit. `start` keeps its optional `wait`. Codex ends every background process
   when a command ends, so turns resume from their transcript, collect waits for every task
   once that is seen, and the response says to wait longer.
4. **Lock.** Done: worktree tasks, change tracking that counts commits, the Go tests' intent
   ported, the project's rules as a test, the Go tree removed, CI and release on Node and Bun,
   an npm package, and the docs, AGENTS.md and changelog rewritten.
5. **Sign-ins and Claude Code.** Built as designed below, tested against a fake OpenAI and a
   fake `claude`. Still to confirm with one real ChatGPT sign-in: how namespaced tool calls come
   back, and whether encrypted reasoning is accepted on the plan route.
6. **Harnesses and extensions.** Built, not yet tested beyond the typecheck (see below):
   Claude Code and Codex as harnesses behind one contract, `ask install` and `ask remove`,
   extensions, handoff between harnesses, parent scoping, the agent skill, and key guidance.

## Phase 5: sign-ins

### OpenCode: no sign-in, a better key

OpenCode's docs give other tools one way in: a Console API key (`oc_sk_...`, from Account ›
Personal API keys, or a service account's for shared machines), sent as a bearer token
(opencode.ai/v2/docs/console/harnesses, /console/api). Even tools OpenCode lists as built in,
like Pi, store such a key. The account sign-in OpenCode itself uses isn't offered to other
clients; the only OAuth it documents for them is the Console MCP server, which manages a
workspace rather than calling models. So ask doesn't sign in to OpenCode. Instead:

- `ask settings` says where to make a key (Account › Personal API keys) and what one looks like.
- Free-tier models (zero price in the catalog) answer 403 to any tool but OpenCode, so ask hides
  them for the `opencode` and `opencode-go` providers.

### ChatGPT: the documented open-source flow

OpenAI documents "ChatGPT plan usage" for open-source, locally run tools
(developers.openai.com/siwc/token-sharing-open-source): OAuth with PKCE, dynamic client
registration, no client secret or partner key, then Responses API requests billed to the user's
Plus or Pro plan. This replaces copying Codex's login, which we never do.

- **Provider.** `chatgpt`, added to the catalog by ask: the Responses protocol at
  `https://api.openai.com/v1`, models from the account's own `GET /v1/models` list (`slug`,
  `display_name`, `visibility: "list"`), cached and refreshed at sign-in and daily. Models are
  named `chatgpt/SLUG`.
- **Sign-in** in `ask settings`, labeled **Continue with ChatGPT**: first time
  `client_id=dynamic_agent_client` with `agent_name_hint=ask` and the host's
  `ext_agent_host_id`; scopes `openid profile email offline_access resource.invoke
  chatgpt.tokens.use.direct`; `resource=https://api.openai.com/v1`; fresh `state`, `nonce` and
  S256 PKCE per attempt; a loopback callback `http://127.0.0.1:PORT/auth/callback`. Later
  sign-ins reuse the issued `client_id` (`oaiapp_...`) with `id_token_hint`.
- **Away from the browser** (SSH, a phone): a `127.0.0.1` callback reaches the machine running
  the browser, not ask's. ask prints the URL and also accepts the address the browser lands on,
  pasted back: the same code, state and redirect URI, exchanged by ask. OpenAI's own advice for
  VMs is to sign in locally and copy the credential file; pasting avoids needing a second machine.
- **Checking.** Verify the ID token's RS256 signature against
  `https://auth.openai.com/.well-known/jwks.json` with `node:crypto`, and its issuer, audience
  (the issued client ID), expiry and nonce. Require `chatgpt.tokens.use.direct` among the
  granted scopes; without it, keep the sign-in but say plan usage is off.
- **Storage.** The credential record in `auth.json` under `chatgpt` (client ID, subject, email,
  ID, access and refresh tokens, expiry, scopes), mode 0600, written atomically. The host ID
  (`urn:uuid:...`, made once) lives apart, in `~/.ask/host.json`, so copied credentials never
  overwrite it.
- **Refresh.** Access tokens last an hour; refresh tokens 30 days and rotate. Refresh shortly
  before expiry, and once on a 401, under a lock shared by every ask process (several workers
  run at once, and reusing a rotated token fails with `refresh_token_reused`); re-read the
  record after taking the lock.
- **Requests.** `store: false`, `stream: true` and `instructions` already hold. This route wants
  function tools grouped in a namespace (`{"type": "namespace", "name": "ask", "tools": [...]}`)
  and rejects `max_output_tokens`, `temperature`, `metadata` and others ask doesn't send.
- **Errors.** Map `subscription_sharing_usage_limit_exceeded` (429: link
  chatgpt.com/settings/usage, don't retry), `_user_not_eligible` (403: explain, don't retry),
  `_unsupported_capability` (400: name `error.param`), `_usage_unavailable` and
  `_user_unavailable` (503: back off) to failures with hints. A disconnect shows only as a
  failed refresh: then ask asks to sign in again.
- **Signing out** revokes the refresh token at the revocation endpoint, clears the tokens, and
  keeps the client ID and host ID for the next sign-in.
- **Telling the user.** After the first sign-in: "You're using your ChatGPT plan", with where to
  manage usage. `ask doctor` checks that the sign-in still refreshes.
- **To confirm live**, since the docs don't say: how calls come back from namespaced tools, and
  whether `include: ["reasoning.encrypted_content"]` is accepted on this route.
- **Left out for now:** several ChatGPT accounts at once (sign out to switch), and importing a
  credential file from another machine.

### Claude Code: run the user's own, as `claude/MODEL`

Anthropic's terms (code.claude.com/docs/en/legal-and-compliance) allow running the unmodified
Claude Code binary with the user's own sign-in, and forbid collecting, storing or relaying
Claude credentials, or offering Claude.ai login in another product; developers building on the
Agent SDK are asked to use API keys. So `claude/` runs the `claude` the user installed, signed in
its own way, and ask never touches its credentials; `anthropic/` stays ask's own loop with an API
key. OpenCode does the same through Anthropic's Agent SDK, which drives the same binary; ask
starts the CLI directly, to keep zero dependencies.

- **Controls,** all documented: `--settings '{"disableAllHooks":true}'`, `--strict-mcp-config`
  with an empty config, `--disable-slash-commands`, `--setting-sources user`,
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. Never `--bare`,
  which would refuse the subscription sign-in.
- **Read-only:** `--tools Read,Grep,Glob`, the same as allowed tools, Bash and the edit tools
  disallowed, and the manual permission mode, so anything else is refused; git without optional
  locks or fsmonitor. Checked live: a request to write a file was refused. **Write:** the full
  tool set with `bypassPermissions`.
- **Sessions:** one Claude session per run of claude/ turns, `--session-id` then `--resume`; a
  turn whose Claude session was never saved starts it afresh. Phase 6 lets a session move
  between Claude Code and ask's loop.
- **Steps:** the stream's tool calls become ask's steps (Read → read, Bash → shell), saved after
  each, with paths relative to the task's folder.

## Phase 6: harnesses and extensions

- **Two official harnesses, any number more.** `claude` and `codex` ship with ask and implement
  the same `Harness` contract (`harness.ts`) an extension can. Each is off until `ask install
  NAME`, which lists it in config.json's `extensions` and writes a `harnesses.NAME` entry
  (`command`, `args` after ask's own, `env`). Installing the CLIs and signing in to them is
  left to their docs. CLIs, not SDKs: the Agent SDK's terms rule out claude.ai sign-in for
  products built on it, and both SDKs would add dependencies.
- **Codex** runs `codex exec --json` with `--ignore-user-config`, `--ignore-rules`,
  `approval_policy="never"` and a permission profile ask defines through `-c` (beta in Codex):
  `:minimal`, the toolchains on PATH and the repository's shared .git readable, the workspace
  readable or writable, temp folders writable for a write task, no network. Checked live on
  0.166: reads outside are hidden, writes outside never land, a hook can't be planted, `.git`
  stays read-only even when a rule allows it. The legacy `-s` sandbox reads the whole disk,
  home included. Its sandbox can leave empty `.agents`, `.aws`, `.codex` mount points in
  the workspace. Later turns `exec resume THREAD`.
- **Claude Code hardening,** checked live on 2.1.318: `--restricted` confines the file tools to
  the folder (reads and writes outside refused); `--permission-prompts none` refuses whatever
  would prompt. Its Bash sandbox needs bubblewrap and socat on Linux and otherwise falls back
  to running unsandboxed without a word, so ask asks for it, strictly
  (`failIfUnavailable`, no unsandboxed retry, home unreadable), only where it can run, and says
  so when it can't. Not `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`: on Linux it forces the sandbox on
  every command, so without socat every command fails, and the sandbox leaves twenty empty
  decoys (`.env*`, `package.json`, `node_modules`, …) in the folder. Both harnesses' sandboxes
  can leave such decoys; ask removes the ones a run created that are still empty. Its `CODEX_*` markers, like Claude Code's,
  are removed from the environment so a nested run doesn't think it is its caller.
- **Handoff.** A harness continues its own session only while consecutive turns stay with it
  (`harness: {name, session, turn}` in session.json). Otherwise the earlier conversation goes
  along as text before the prompt, as OpenCode does, and the transcript stays in ask's form.
- **Extensions** live in `~/.ask/extensions/NAME`, made by the first install: an ES module whose
  default export adds a harness, tools for ask's loop, or both. Loaded once per process; one
  that fails to load is reported by `ask doctor` and skipped.
- **Parent scoping.** A session records `parent` (ASK_PARENT, else Claude Code's session, Codex's
  thread, OpenCode's session) and `origin` (the repository or folder it came from).
  `{"sessions": {}}` lists the caller's own; people's `ask sessions` lists this repository's.
- **The skill** is written to `~/.claude/skills/ask` and `~/.codex/skills/ask` when those homes
  exist, keeping a differing file as `.bak`.

## Not now

MCP, remote hosts.

## Risks

- A rewrite throws away a tested core; the Go version is in git history, before 0e9249c.
- Three protocols triple the surface that can drift from what providers actually accept; only
  real calls prove them, and none has succeeded yet.
- Driver runs spend the owner's Claude and Codex quota: about 50 to 60 runs for phase 3.
- Bun's Node compatibility is thinnest around detached processes and signals, which phase 2
  relies on; tests run under both runtimes to catch it.
