# Architecture

ask is one Go binary with no dependencies beyond the standard library. It turns a command line
into a session, executes each turn in a detached worker, and records what happened. The worker
runs the turn with ask's own harness against a model provider, or hands it to an external
harness, an extension, through a small executable contract.

`main.go` builds the binary, `internal/`
holds the packages, one per command under `internal/cmd/`, and `internal/cmdutil` is what the
commands share. Files and folders are one word.

## How a turn goes

```text
ask "task"   or   ask continue ID "next"    the launcher
  │  cmd/run, cmd/continue   resolve the model, read the prompt, create the session or add a turn
  │  cmd/worker              start the worker, print the ID once it holds the lock
  ▼
ask __worker FOLDER                         detached, in its own session
  │  sessions     the lock, session.json, transcript.json, events.jsonl
  ├─ harness      the loop: provider ⇄ tools, until an answer or a limit
  │    provider       one streaming request per model call (the OpenAI Responses protocol)
  │    tools          read, list, grep; write, edit, shell in a write turn; extension tools
  └─ extension    or: start an extension's harness under the contract, read its report
  │  git          what a write turn changed; worktrees
  ▼
session.json: the turn succeeded, failed or stopped    cmd/wait, cmd/show, cmd/sessions read it
```

The launcher prints the ID only after the worker holds the session's lock, so an ID always
names work that is under way. Everything else reads the folder: `wait` polls `session.json`,
`show` reads `events.jsonl` by byte cursor, `stop` signals the lock's owner.

## Packages

| Package | Purpose |
| --- | --- |
| `cmd/root` | Dispatch, exit status and help rendering |
| `cmd/run`, `cmd/wait`, `cmd/show`, `cmd/continue`, `cmd/stop`, `cmd/sessions`, `cmd/models`, `cmd/config`, `cmd/setup`, `cmd/clean` | One command each: its `Help` page and its `Run` |
| `cmd/install` | `ask install`, `ask remove` and `ask extensions` |
| `cmd/worker` | The detached side of a turn, and `Launch`, which `run` and `continue` share |
| `cmdutil` | Option parsing, model resolution, the model catalog, prompt and limits, the result record, session scoping, waiting and printing |
| `harness` | The agent loop (`harness.go`), the tools (`tools.go`) and the system prompt (`prompt.go`) |
| `provider` | The provider interface, the known endpoints, the OpenAI client, the models.dev snapshot, declared models and pricing |
| `sessions` | Sessions and their turns, folders, the lock, events |
| `extension` | Manifests, finding harnesses, tools and commands, running a harness under the contract, installing |
| `git` | Changes a write session made, worktrees, whether a branch landed |
| `process` | Process groups, timeouts, signals; Linux parent-death signals |
| `term` | Terminal styles, status lines, tables |
| `config` | The home layout, config.json, credentials, atomic JSON |
| `test` | Black-box tests of the binary against a fake provider and a fake harness |

`extensions/` holds the two extensions ask ships, embedded in the binary and written to
`~/.ask/agent/extensions/NAME/` by `ask install`.

## Rules the layout keeps

[`.github/checks/guard.sh`](../../.github/checks/guard.sh) checks these on every change:

- **No dependencies.** The standard library and ask's own packages only; `go.mod` lists none.
- **No particular coding agent in `internal/`.** Only `cmd/setup`, which offers the built-in
  extensions for the CLIs it finds, names them as values. Anything specific to a coding agent
  lives in its extension under `extensions/`.
- **Leaves.** `config` and `provider` import nothing of ask's; everything may build on them.
- **Commands share through `cmdutil`**, never each other; `worker` is the one exception.
- **Every package says what it is for.**
- **The built-in extensions use Node.js built-ins only**, like any extension someone could
  write, and keep identical copies of `writer.mjs`.

Two more are kept by tests and review:

- **Contracts change only as [compatibility.md](../compatibility.md) says.** Additions are free;
  a breaking change bumps `ASK_CONTRACT`.
- **Grow by need.** A new tool, config key or contract field arrives with the use that needs it.
  Extensions add executables, never code inside ask: a harness, tools, commands and notes, each
  declared in `extension.json`. The system prompt is ask's own, followed by the project's
  `AGENTS.md`; there is no global instructions file.

## Trying a development build

`./x dev` builds this checkout and runs it with your normal `ASK_HOME`; `./x install` puts the
build in `~/.local/bin`. To keep development runs apart from your own, set `ASK_HOME` to a
scratch folder for that shell.
