# ask releases

## Unreleased

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
