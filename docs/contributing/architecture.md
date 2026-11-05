# Architecture

ask is one Go binary. Bubble Tea owns interactive terminal rendering and input; Lip Gloss and
Charm's ANSI helpers measure and clip terminal text. Execution uses the standard library only.
It turns a command line into tasks, runs each task by
starting an agent (a separate executable) under a small contract, and records the result. ask
itself knows no particular coding agent: the official harnesses are reached through
agents in [`packages/`](../../packages/), which use the same contract as anyone's.

## How a task runs

```text
main.go ──► cli          parse options, pick the command, print answers and status
             │
             ▼
            runs         name the run, write tasks.json, take the lock, run tasks in parallel
             │  ├──► hooks     task hooks before, result hooks after (they fail open)
             ▼  │
            task         worktree, prompt, run the agent, collect git changes, check JSON
             │
             ▼
            agent        find the agent, start it under the contract, read its report
             │
             ▼
          an agent executable  (~/.ask/agents/NAME, or a package's agents/NAME)
```

Beside the path: `find` resolves agents, hooks and commands (yours before packages'), `process`
starts children in process groups and stops them all on a signal, `git` reports changes and makes
worktrees, `status` draws the status lines and live rows, and `schema` checks `--schema` answers.

## Packages

Each folder in `src/` is one Go package with a `// Package` comment saying what it is for;
`go doc ./src/NAME` prints it.

| Package | Purpose |
| --- | --- |
| `cli` | The commands, one file each (`run.go`, `bench.go`, `runs.go`, `models.go`, `packages.go`, `settings.go` and its `menus.go`, `setup.go`, `title.go` and its `shell.go` tokenizer, `docs.go`, `update.go`, `help.go`), and `cli.go`: dispatch, options, exit codes |
| `runs` | Runs on disk: ids and names, `RUN/TASK` references, locks, results; preparing tasks and follow-ups; running them in parallel; stopping |
| `task` | One task, start to finish |
| `agent` | Finding agents, listing their models, running one under the contract, model display names |
| `hooks` | Task, result, title and name hooks |
| `packages` | Installing, updating and removing packages from git |
| `find` | Where agents, hooks and commands come from |
| `git` | What a write run changed, and worktrees |
| `process` | Process groups, timeouts, signals; Linux parent-death signals |
| `status` | Status lines, live rows and the `ask runs` table |
| `setup` | What `ask setup` offers: the official agents, the ask skill per app, the title hook |
| `schema` | The `--schema` check |
| `home` | `~/.ask` paths, the contract environment, `settings.json` and `models.json`, atomic JSON records |
| `tui` | Inline Bubble Tea prompts and the review diff; owns prompt input and terminal cleanup |
| `update` | Finding the latest release and replacing a directly installed ask |

## Rules the layout keeps

[`.github/checks/guard.sh`](../../.github/checks/guard.sh) checks each of these on every change:

- **Leaves.** `home`, `tui` and `update` import no other ask package. Everything may build on
  them.
- **No particular agent.** Only `setup`, which offers the official agents on a first run, names
  them as values. Anything specific to a coding agent belongs in its agent, in `packages/`.
- **Presentation-only dependencies.** External Go imports stay in `tui` and `status`. Bubble Tea
  renders prompts and live status inline, without taking over stdin for live status. Core
  execution uses the standard library; official agents import only Node.js built-ins.
- **Every package says what it is for.**

Two more are kept by tests and review, not grep:

- **Contracts change only as [compatibility.md](../compatibility.md) says.** Additions are free; a
  breaking change bumps `ASK_CONTRACT`. Released run records in `src/test/fixtures/` stay readable.
- **Grow by need.** A new hook event, contract field or setting arrives with the use that needs it.

## Other folders

| Folder | What's there |
| --- | --- |
| [`docs/`](../) | User docs, built into ask for `ask docs` (only the top level; this folder is not) |
| [`packages/`](../../packages/) | The official agents |
| [`src/test/`](../../src/test/) | Black-box tests of the binary, one file per feature |
| `.github/checks/` | Architectural checks |
| `.github/release/` | Release tooling, described in [releases.md](releases.md) |
| `assets/` | The logo, wordmark and README screens |
| `x` | The one entry point for checks: `./x check` is what CI runs |
