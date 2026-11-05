# Usage

```sh
ask [options] "prompt"
ask run [options] "prompt"
```

Both start a session in the background and print its ID. `ask wait ID` prints the answer; `--wait`
does both at once. Exit 0 from a launch means admitted, not finished.

```sh
id=$(ask "Where is the retry logic, and what are its limits?")
ask show "$id"                        # what it is doing now; never waits
ask wait "$id"                        # the answer
ask --wait -m opencode-go/glm-5.3#high "Review the last commit for bugs."
```

`RUN` or `ID` in these pages is the six-character ID a launch prints, like `k3f9a2`.

## The prompt

The words after the options are the prompt. Without any, or with `-`, stdin is the prompt.
`--stdin` appends stdin to an argument prompt, after a blank line. Words after `--` are always
the prompt, even ones that look like options.

```sh
ask "Summarize src/"
git diff | ask -
ask < task.md
git diff | ask --wait --stdin "Review this diff for bugs; give file, line and impact."
ask -- -v means verbose here
```

An argument prompt without `--stdin` leaves stdin alone, so a command in a shell loop or with
an inherited pipe never hangs waiting for input.

## Read or write

| Option | Access |
| --- | --- |
| none | Read only: the subagent can read, list and search files, and nothing else. The default. |
| `-w`, `--write` | Read and write: it can also create and edit files and run shell commands, as you. |

Read-only is enforced by what the subagent is given: a read session has no write, edit or shell
tool, so there is nothing to persuade. Running tests or builds writes files, so it needs `-w`.
Tool paths are confined to the session's directory; a path outside it is refused.

## Where it works

The session works in the current directory, or `-C DIR`. `--worktree` (which implies `-w`) gives it
a fresh git worktree and branch from `HEAD`, named after the prompt's first words:

```sh
ask --worktree -C ~/code/app "Add rate limiting to the login route."
```

```text
ask k3f9a2 · succeeded · GPT-5.5 · write · worktree ~/.ask/worktrees/add-rate-limiting-to · 3:05 · 4 files changed · 120.4k in · 6.2k out · $0.31
```

Several write sessions can then work in parallel without touching each other or your checkout. The
worktree starts from the committed `HEAD`, so put uncommitted context in the prompt. Set
`worktree` to `true` in [config](config.md) to give every write session one. Review and merge the
branch with git as usual; `ask clean` removes worktrees whose branch changed nothing or landed.

## What a write turn changed

When a write session's directory is in a git repository, ask compares each turn's before and
after and records what it changed: in the status line, and in full in `ask show ID --json`:

```json
"changes": [
  { "path": "src/parser.js", "change": "modified" },
  { "path": "test/parser.test.js", "change": "added" }
],
"commits": 1
```

Files you had already modified before the turn count only if the turn changed them again.

## Limits

| Option | Limit |
| --- | --- |
| `-t`, `--timeout SECONDS` | Stop the turn after this long (default 900, or `timeout` in config). It fails as `timed out`. |
| `--max-cost USD` | Stop once the turn's cost passes this (default: `max_cost` in config). Native sessions are priced from the model list; an external harness must report cost. |

A turn also stops after 100 model calls, or when the conversation no longer fits the model's
context. Each is a clear failure, never a silent retry.

## JSON answers

`--schema FILE` (or `--schema -`) makes the answer JSON matching that JSON Schema. Native sessions
pass the schema to the provider as the required output format; external harnesses pass it to
their CLI.

```sh
ask --wait --schema shape.json "List the public functions in src/api.go." | jq '.functions[]'
```

## Output

stdout is the one thing the command is for: the ID at launch, the answer from `wait`. Status
goes to stderr. On a terminal it is colored, with the symbols gh uses, and a launch also says
how to collect the session:

```text
! k3f9a2 started · GLM 5.3 · ask wait k3f9a2
✓ k3f9a2 · GLM 5.3 · 14.2s · 31.0k in · 812 out · 20.1k cached · $0.09
✗ k3f9a2 · GLM 5.3 · 2.1s · the provider rejected the credential: ...
```

Piped, the same lines are plain and stable for scripts, and the launch prints only the ID:

```text
ask k3f9a2 · succeeded · GLM 5.3 · 14.2s · 31.0k in · 812 out · 20.1k cached · $0.09
```

`NO_COLOR` or `TERM=dumb` keeps a terminal plain too. `--json` prints JSON instead:
`{"session_id":"k3f9a2","turn":1,"state":"running"}` at launch, or the result record with
`--wait` (see [Sessions](sessions.md#the-result-record)). Exit 0 means admitted (launch) or succeeded (wait), 1 failed
or stopped, 2 a usage error.
