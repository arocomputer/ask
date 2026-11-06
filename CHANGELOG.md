# ask releases

## Unreleased

- Redesign human-facing output in monochrome: compact help, word-based status, responsive tables,
  result-first session details and quiet progress. Interactive focus uses one text-height vertical
  bar and a bold label; settings stays open until Done, with Esc to return from an action.
  Add offline wide/phone visual fixtures. Keep TSV and JSON interfaces stable. New ChatGPT
  registrations request the application display name "Ask".
- Keep the active ChatGPT login when a pasted callback needs correcting, distinguish missing
  state from mismatched state, and exclude URL fragments when checking it. Reject unrelated
  browser callbacks. Redraw pasted input once per chunk to reduce SSH terminal flicker.
- Show callback URL input on its own line with a character count and Enter hint, so ChatGPT
  login pastes remain visible on narrow SSH terminals.
- Bundle static, non-setuid bubblewrap 0.13.1 on Linux, with libcap 2.78, source archives,
  licenses and an offline rebuild script. Prefer the bundle and probe system alternatives when
  host policy blocks it; retain default-on confinement and fail closed when none work.
- Expand sandbox regressions for racing path replacement, runtime Git hard links, fresh metadata
  discovery and failed-setup cleanup; add policy/tool and extraction measurement runners.
- Add read-only `ask legacy` access to Go-era session records and native transcripts. Retain
  old worktrees/extensions and reject retired safety-related settings until explicitly migrated.
  Automatic cleanup remains removed: main's #82 live/unlanded-work protection is preserved by
  never deleting sessions or worktrees. See `docs/migration.md` for upgrade and rollback steps.
- Close private execution state and finish the session even when turn preparation fails.
- Serialize continuation, stop and restart transitions, validate worker argument tails, retain
  pre-crash write baselines and flush JSON before atomic replacement. Report partial batch starts
  and change-reporting failures without hiding running work or invalidating successful answers.
- Reject hard-linked file aliases in file-reading tools. Remove obsolete native network modes;
  use the exact bubblewrap executable that passed the namespace probe.

- Rename the bundled Linux helper to `ask.sandbox`. Add config-only `"sandbox": false` to
  disable OS confinement for new turns, including shipped harnesses. Default remains enabled;
  interrupted turns retain their recorded choice.

- Confine built-in filesystem tools in credential-free child processes. Use bubblewrap plus
  Landlock/seccomp on Linux and an explicit read allowlist on macOS. Git metadata is read-only
  during execution; staging and commits are refused, and cleanup no longer restores Git files.
  Linux now requires bubblewrap and working unprivileged user namespaces.
- Protect workspace-local Git configuration includes; refuse missing or symlinked included
  paths. Refuse worktree creation with external checkout filters or conditional Git includes.
- Load project instructions inside the read-only sandbox and stop running Git status while
  building prompts. The TypeScript `instructions()` helper now returns a promise.
- Disable sandboxed command networking until a proxy-only boundary can be enforced; ask's
  fetch and search tools still reach public addresses.
- Keep recorded token usage when a worker resumes a turn, and report incomplete helper
  extractions instead of presenting them as answers.
- Compare working files without running Git clean filters during change bookkeeping.
- Confine `grep` symlink targets, restore Git hook symlinks after write tasks, and restrict
  sandboxed commands to basic inherited environment settings.
- Preserve interrupted tool calls when providers reuse IDs, and continue with the original
  request if optional proactive compaction fails.
- On context overflow, summarize older conversation into a checkpoint while preserving the
  original transcript and the latest tool exchange.
- Let `fetch` answer a question about a page with the turn's model, or an explicitly configured
  `ASK_MODEL_SMALL=provider/model`, resolving the helper's own credentials and endpoint.

ask is rewritten in TypeScript around its own agent loop. Agents use it through JSON requests,
and the command line is for setting it up and looking at sessions. It does not read the runs of
earlier versions.

- Hand work to ask as one JSON request on stdin, with one JSON response on stdout: `start` many
  tasks at once, optionally waiting for the first to finish; `collect`, `continue`, `stop` and
  `show`. Results are small, and a request ask can't carry out says what to send instead. `ask
  help requests` and `docs/requests.md` describe it; the library's `handle` takes the same
  requests.
- Run every task with ask's own agent loop, talking to the model directly over OpenAI's
  Responses API, chat completions or Anthropic's Messages API, as the models.dev catalog says for
  each model. Name models `provider/model`. Read-only tasks get only `read`, `list` and `grep`;
  write tasks also get `write`, `edit` and `shell`, confined to their folder and without
  provider keys in their environment.
- Number the lines `read` returns, search with one `grep` everywhere, and let `list` find files
  by pattern, like `src/**/*.ts`. Read-only tool calls run in parallel.
- Make a session one conversation: `continue` adds a turn with everything before it, or without
  a prompt resumes a stopped or failed one.
- Resume a turn whose worker was stopped partway, from where it left off, the next time it is
  collected, and tell the model which tool calls were cut off. In environments that end
  background processes with each command, `collect` waits for every task and says to wait
  longer.
- Give a task its own git worktree and branch with `"worktree": true`, and list every file a
  write task changed, including in commits it made.
- Retry a failing provider within a time budget, without retrying a failure that was itself
  slow, and report `retrying` meanwhile. Shorten old tool outputs when a conversation outgrows
  the model's context.
- Add `ask settings`, which adds providers with a pasted, checked key, chooses your models and
  the default, and sets the timeout; `ask doctor`, which checks everything a task needs; and
  `ask models`, `ask sessions` and `ask show`.
- Sign in with ChatGPT in `ask settings` to use a Plus or Pro plan instead of an API key, as
  OpenAI documents for open-source tools. It works from another device too: open the link
  anywhere and paste back the address the browser lands on. The models are the account's own,
  `chatgpt/MODEL`; the sign-in renews itself and signing out ends the session with OpenAI.
- Run tasks with your own installed Claude Code (`claude/MODEL`) or Codex (`codex/MODEL`),
  signed in its own way, after `ask install claude` or `ask install codex`; installing and
  signing in to them stays theirs. Each run is kept to the task: no hooks, MCP servers,
  settings files or API keys; Claude Code's file tools stay in the task's folder and its
  write tasks run only in its sandbox; Codex's commands can't read your home folder or reach
  the network. Change how each runs under `"harnesses"` in config.json.
- Run every command of a write task in ask's own sandbox: it writes only the task's folder,
  can't read your home folder, gets no secrets from the environment, can't reach your agents,
  Docker or other programs, and reaches the web through a proxy that refuses private
  addresses. On Linux it's Landlock, through `ask.sandbox`, a small helper that comes with ask; on
  macOS, the system's sandbox. Nothing needs installing, and a write task is refused where
  there is no sandbox. Git hooks and config a task changes are put back and reported as
  `reverted`.
- Give every task `git` (`status`, `diff`, `log`, `show`, `blame`), so read-only reviews can
  see what changed; nothing a repository's config names can run through it.
- Tell subagents how to work and how to shape the answer (lead with it, then `path:line`
  evidence, what changed and how it was checked), with the date, platform and repository
  state, and that what they read is material, not orders; Claude Code and Codex get the same
  framing on top of their own prompts.
- Give every task `fetch`, which reads a web page as text, 16k characters at a time with an
  offset to read on, public addresses only, and
  `search`, ask's own web search, free and with no key: titles, addresses and snippets from
  DuckDuckGo, falling back to its lite page, Mwmbl and Wikipedia when one turns searches away. Claude
  Code and Codex keep their own.
- Turn any of a subagent's tools off, or back on, with `ask tools off NAME` (or `"tools"` in
  config.json), and replace any of them with an extension's tool of the same name; `ask tools`
  lists them all and where each comes from.
- Keep environment files (`.env`, `.env.local`, ...) out of `read` and `grep`, and out of
  Codex's reach; their examples stay readable.
- Move a session between ask's own loop and any harness from one turn to the next: the new one
  gets the conversation so far.
- Install extensions that add a harness or tools with `ask install PATH|URL`, and undo any
  install with `ask remove`.
- Teach Claude Code and Codex to use ask with `ask install skill`: when to hand work off,
  what a task's prompt needs, choosing read-only, write or worktree, and checking results.
- List the calling conversation's own sessions with `{"sessions": {}}`, or everyone's with
  `"all": true`; `ask sessions` lists this repository's, or everyone's with `--all`.
- Say where to make a key, and how it starts, for the common providers in `ask settings`, and
  reach xAI, Mistral, Groq, Together AI, Cerebras, DeepInfra and Perplexity models, which had
  no endpoint before.
- Don't offer OpenCode's free models, which answer 403 outside OpenCode, and say where to make an
  OpenCode key.
- Install with the installer, Homebrew, or `npm install -g @arocomputer/ask` on Node 24 or newer.
- Remove the flag commands (`ask PROMPT`, `wait`, `continue`, `stop`, `setup`, `config`), the
  old extensions and their contract, prices and cost limits, `models.json`, `ask clean`, and the
  import of other programs' keys.

## v0.3.1 · 2026-11-02

- The `worktrees` setting takes a path inside the repository, like `.ask/worktrees/{name}`, so each
  repository keeps its runs' worktrees; `ask settings` offers it as "In each repository".
- The install one-liner and the homepage point to GitHub; the fschrhunt.com page they named
  was retired.

## v0.3.0 · 2026-10-24

- Clarify docs, setup instructions and CLI help, with consistent `ask help COMMAND` guidance,
  accurate benchmark and setup behavior, and clearer examples and prerequisites. Help flags
  remain supported.
- Keep review diffs off the command line to support large changes, qualify benchmark position
  selectors for nonnumeric task ids, and document batch follow-ups' access, directory and cost
  inheritance.
- Installer help now works when the script is piped to `sh`, and lists version and directory
  options without installing anything.

- Clarify `./x` help and argument handling and simplify PR verification guidance;
  keep offline Baymax in the shared check and use `./x build` for release builds.
- Made long run options primary in help and docs (`--model`, `--write`, `--continue`,
  `--directory`, `--timeout`); kept short forms and added `--directory` while retaining `--dir`.
  `--title` remains long-only; `-t` still means timeout.
- Added Baymax (`./x baymax [AGENT...]`), the offline packaged-harness integration doctor.
  `./x check` includes it; `./x node` is a compatibility alias. Shared test plumbing replaces
  duplicated adapter runners while harness-specific assertions stay beside their packages.
  Baymax also checks package refresh/removal, actual writes and worktree isolation, and process
  shutdown on cancellation and timeout.

- Added packaged harnesses for Copilot, Gemini CLI, Pi, e, Cursor, Aider, Amp, Goose, Cline,
  Kilo, Continue, OpenHands, Qwen Code, Kimi Code and Mistral Vibe. `ask setup` discovers them;
  `ask docs packages` and each agent's page cover model setup and feature limits. Harnesses
  without enforceable read access refuse read runs rather than silently granting writes.
- The single OpenCode package detects the installed CLI and supports v1.1.65+ and v2 with their
  respective flags, permission formats and usage exports.

- Official Claude, Codex and OpenCode sessions share the same editable `Model · Task` title.
- `--title TEXT` overrides the prompt text used in that session title for runs, batches and benches.
- `ask wait` takes no arguments or options; it returns whichever running run finishes first.
- `ask wait` with no active runs now exits successfully with a brief status message; `ask setup NAME`
  points to `ask settings NAME`, and model help uses that same selector command.
- The ask skill now requires agents to use ask instead of a built-in subagent for handoffs; setup
  updates older ask-written skills when accepted.

## v0.2.0 · 2026-10-03

- Read runs are tighter. On Claude Code and Opencode they get only file reading and search tools,
  no shell commands (the inspection-command list could be widened by shell expansion), and git
  runs those CLIs start take no optional locks and no fsmonitor. An explicit `-r` on `ask batch`
  or `ask bench` refuses a task with `"write": true` instead of running it with write access.
- Model ids ignore case everywhere: ask lowercases them before checking `models.json`, recording a
  run and passing `ASK_MODEL`, so `claude:Opus-5.5` can no longer slip past an entry that turns
  `opus-5.5` off. A `models.json` naming one id twice in different case is refused. An agent whose
  ids depend on case now receives them lowercase.
- Migrate terminal prompts and live status to Bubble Tea, with monochrome prompt styling,
  resize-aware choices, cursor editing and bracketed paste. Updates show transient progress;
  review diffs measure wide text correctly. Machine output stays unchanged.

- `ask bench` compares models on the same tasks: every task on every `-m` model, `-n` times, each
  passing when the agent finishes and the task's own `check` command exits 0. Write attempts get
  fresh worktrees from the same commit. It prints passes, median time, tokens and cost per model,
  and `ask show` prints a bench again. A command of yours named `bench` is now hidden by it.
- Install with `curl -fsSL https://fschrhunt.com/ask/install.sh | sh` (checksum-verified, into
  `~/.local/bin`) or Homebrew, from ask's own repository: `brew tap arocomputer/ask
  https://github.com/arocomputer/ask && brew install ask`.
- `ask update` replaces an installer or archive install with the latest release, after checking
  its checksum; `--check` only reports. Homebrew and go install are pointed to their own update.
  In a terminal, ask mentions a newer release at most once a day (`ASK_NO_UPDATE_CHECK=1` stops it).
- Releases carry build provenance (`gh attestation verify`), run CI's checks and `govulncheck`
  first, and are installed for real on macOS and Linux. `./x release` releases in two runs.
- A new README.

## v0.1.0 · 2026-10-02

The first release. ask hands tasks to the coding agents you already use, Claude Code, Codex,
Opencode or your own, as subagents: one task or many in parallel, read-only or with write access,
recorded, with live usage.

**Running work**
- `ask -m MODEL PROMPT` runs a task read-only, `-w` lets it change files, `--worktree` gives it its
  own git worktree and branch. The answer goes to stdout; status lines name the run, model, time,
  what changed, tokens and cost, live in a terminal.
- Runs are named after their prompt (`login-test-fail`) and keep a fixed id. `ask -c RUN` follows
  up in the same conversation; `ask show`, `ask wait`, `ask stop` and `ask runs` (this repository's
  runs, or `--all`) work on them; `ask clean` removes worktrees whose work has landed and old runs.
- `ask batch` runs many tasks in parallel, on one model or several, and resumes a stopped batch.
- `--json` and `--schema` require JSON answers; `-t` bounds time; `--max-cost` bounds spend.

**Agents and models**
- Official agents for Claude Code, Codex and Opencode are built in: `ask install claude`. They find
  their CLI even off `PATH` and say what's missing. Your own agent is any executable under a small
  contract (`ask docs agents`).
- Models are `agent:id`, named plainly (`claude:sonnet-5.5`, `codex:gpt-6.1-sol`). Turn models on
  and off with `ask models` or `ask settings NAME`; `models.json` keeps only your choices.
- Cost limits, off unless set: a default, a model's own, or one run's. ask stops an agent that
  passes its limit and keeps its session, so `ask -c` continues it.

**Setting up and changing things**
- `ask setup` walks through the first run; `ask setup --check` reports.
- `ask settings` holds every control: agents, defaults, worktrees, and the apps that use ask. Edits
  wait in a draft and are saved only after a review that shows each file's diff. `get`, `set` and
  `unset` do the same for scripts.
- `ask docs` has every page built in; `ask help` and `ask help COMMAND` give the short form.

**Extending**
- Hooks change tasks and check results (a `verify` hook can run the tests and hand failures back),
  commands add `ask NAME` workflows, and packages share them: `ask install OWNER/REPO`.
- `ask title --hook` names ask runs in Claude Code's task list; the ask skill teaches Claude Code,
  Codex, Opencode, Cursor and pi to hand work to ask.

ask is one Go binary for macOS and Linux with no dependencies. The contracts it keeps across
releases are in `ask docs compatibility`.
