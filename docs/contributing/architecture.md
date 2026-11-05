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

Each implementation folder in `src/` is one Go package with a `// Package` comment saying what
it is for; `go doc ./src/NAME` prints it. `src/test/` holds the binary tests, their fake and fixtures,
and the adapter integration runner. The repository has one root `go.mod`.

| Package | Purpose |
| --- | --- |
| `cli` | Commands in `run.go`, `batch.go`, `continue.go`, `bench.go`, `runs.go`, `wait.go`, `show.go`, `stop.go`, `clean.go`, `models.go`, `packages.go`, `settings.go`, `setup.go`, `title.go`, `docs.go` and `update.go`; `worker.go` handles detached admission, `menus.go` settings prompts, `shell.go` tokenization, `help.go` help, and `cli.go` dispatch, options and exit codes |
| `runs` | `run.go`: identity and references; `store.go`: saved tasks and results; `prepare.go`: validation and follow-ups; `execute.go`: locks, parallel execution, admission and stopping; `hooks.go`: task/result decisions and combined results. Names, continuation locks, recovery, progress and event paths stay in their feature files |
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
| `home` | `~/.ask` paths, the contract environment, `settings.json`, `models.json` and generic `environment.json` policy, atomic JSON records |
| `tui` | Inline Bubble Tea prompts and the review diff; owns prompt input and terminal cleanup |
| `update` | Finding the latest release and replacing a directly installed ask |

`home` keeps its name because it covers the home directory, persisted records, shared JSON
types and the contract environment. `config` would describe only its settings and policy files;
broader names such as `state` would still miss its contract and JSON utilities.

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
| [`src/test/`](../../src/test/) | Black-box tests of the binary, one file per feature; fake, fixtures and integration runner |
| `.github/checks/` | Architectural guards |
| `.github/release/` | Release preparation, packaging and formula generation in [releases.md](releases.md) |
| `assets/` | The logo, wordmark and README screens |
| `x` | The one entry point for checks: `./x check` is what CI runs |

## Trying a development build

`./x dev` uses the normal `ASK_HOME` unless you set it. Like a released build, it refreshes
installed official agents to match the binary, so alternating development and installed builds
rewrites those package copies. To try changes without affecting your installed agents, use a
separate `ASK_HOME`, run `./x dev install codex` (or another agent) there, and keep that same
`ASK_HOME` for the test run.
