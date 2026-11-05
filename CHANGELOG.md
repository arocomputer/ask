# ask releases

## Unreleased

- Supply agents an optional private per-task `ASK_EVENTS` JSONL file, preserved across retries
  and hook follow-ups, independently of final answers and `ASK_REPORT` metadata.
- Show bounded recent task activity with `ask show`, stream it with `--follow`, or read
  byte-cursor JSON pages with `--after`. Viewer interruption leaves workers running;
  legacy agents retain coarse status and completed answer output.

- Fix detached launches with relative `ASK_HOME`, remove fresh unadmitted records on SIGTERM,
  preserve usage error exit status, and report name-hook notes and recovery decisions on stderr
  before admission. Concurrent launches choose unique matching run and worktree names atomically.

- Require `-` for follow-up prompts on stdin, so pipe timing cannot change recovery behavior.
- Add `ask runs --json` metadata and `ask wait --json` results with stable run IDs and batch
  positions. Report running and stopped selections in `ask show --json` with exit status 1;
  completed show results retain their format. Foreground start status includes the stable ID.
- Run tasks, follow-ups, recovery and batches detached by default, returning only a stable ID
  after locked admission. Use `--wait` for synchronous answers; `-w` remains write access and
  `-m` remains model selection. Remove `ask start`. Completed runs require an explicit
  follow-up prompt. Benchmarks remain synchronous.

- Allow per-agent environment variable names to be added or removed without replacing defaults.
- Extend environment allowlists and explicit integration policy to Claude, Codex and OpenCode.
  Claude probes supported MCP/skill/tool controls without resetting auth, instructions or hooks.
  Unavailable defaults produce visible run notes; explicit unenforceable restrictions fail.
  Codex and OpenCode retain normal integration loading with documented limitations. Preserve
  OpenCode inline provider/plugin settings when injecting agent permissions. No integration
  isolation claim is made for tool permissions; see `ask docs environment`.
- Keep the caller's foreground or background choice when titling Ask commands in Claude Code.
- Add `--stdin` to append piped or redirected context to an explicit prompt, as in
  `git diff | ask --stdin 'Review this diff'`. Argument prompts otherwise leave inherited stdin
  unread, avoiding hangs and leaving a shell loop's remaining input intact.
- Preserve the original agent stdout as optional `raw_answer` on JSON/schema validation
  failures in saved results, JSON output and result hooks, without printing it in status lines.
  Failed results still omit `answer` and exit 1.
- Teach useful, focused delegation in the generated Ask skill without requiring Ask for every
  handoff; cover explicit context, independent parallel work and structured failure recovery.
- Add optional user-defined model roles in `settings.json`: direct names such as `fast`, `deep`
  and `review` for exact models and efforts, with no automatic routing. Discover them with
  `ask models --roles` and edit them in `ask settings` or `ask settings set roles JSON`.
  Runs, batches and benches record resolved models; follow-ups and reruns keep their recorded
  models after role edits, with existing enabled-state and cost-limit rules.
- Add editable `environment.json` for per-agent inherited variables and declared integration
  controls. Pi now disables native MCP explicitly, checks CLI support, preserves auth paths
  and refuses to suppress possible extension policy hooks. Other adapters reject integration
  policies they cannot enforce; see `ask docs environment` for supported defaults and limits.
- Make promptless `ask continue` finish unfinished work in usable saved conversations, restart
  otherwise with diagnostics under `--wait`, guide active runs to `ask wait`, and require explicit
  prompts for completed-run follow-ups. Keep successful batch tasks and auth/refusal/cost
  blockers untouched.
  Persist private live session and worktree metadata for interrupted attempts, invalidate stale
  rerun results, and avoid waiting on empty nonterminal stdin. Existing aliases remain supported.
- Make tasks, prompted continuations and batches detach by default, returning a stable run ID
  after admission. Add `--wait` for synchronous answers/results; update answer-consuming scripts
  to use it. Keep `-w` for write and `-m` for a model or role. Remove the separate `ask start`
  command without a compatibility alias. Make `ask show` immediate inspection, add machine state
  with `ask runs --json` and result collection with `ask wait --json`, and align help, docs and
  the generated agent skill. Launch success means admitted; collection reports task failure.
  `ask wait A B` still selects the first completion from those references; `--id` returns only
  its identity. No-argument wait is scoped to active work in the current repository or directory.

- Show coarse Codex and Claude Code activity while runs work, including in `ask runs`. The
  optional `ASK_REPORT` activity field updates terminal rows and rate-limited plain status lines
  without exposing commands, paths, reasoning or output; malformed activity cannot hide usage
  or cost limits.
- Show reported cache reads and omit unknown or partial totals. Show elapsed time for active runs,
  preserve run handles in narrow terminals, and clarify follow-ups and stopped-run recovery.
- Keep the recorded worktree path and branch for read, write and hook follow-ups, including
  prefixed worktree templates. Refuse overlapping continuations of the same agent session or
  kept worktree, within a batch and across ask processes sharing `ASK_HOME`.
- Add `ask run`, `ask continue` for follow-ups and reruns, and `ask wait RUN` for a specific
  run or task. Piped input can start a task with the default model; the shorter help avoids
  model discovery. Existing continuation and batch resume flags remain available.
- Add `ask update packages` to update packages separately from ask itself.
- Prevent old release reruns from replacing the latest Homebrew formula; serialize formula
  updates and guard the release tag and main before pushing.
- Ignore local agent state and environment files; use Dependabot for Go dependency and Actions updates.
- The `name` hook event gets `worktree`: whether the run works in a worktree, whose directory and
  branch its name also names. [Hooks](docs/hooks.md#naming-runs) has a hook that gives worktree
  runs made-up names like `bright-running-fox`, the way Claude Code names an unnamed worktree.
- The run-naming hook example uses Haiku 5.5, and [Hosts](docs/hosts.md) notes that Pi and
  OpenCode 2, like Codex, have no shell description for host titles.

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
  first, and are installed for real on macOS and Linux. `scripts/release.sh` releases in two runs.
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
