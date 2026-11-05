# Compatibility

What you build on ask keeps working when ask updates. These are the contracts ask keeps, and how
they may change.

## The contracts

| Contract | Where it is described |
| --- | --- |
| The command line: detached launches return stable IDs; `--wait` and `ask wait` return answers/results. Exit 0 means admitted at launch or success at collection; 1 failed/stopped, 2 usage error | `ask help`, [Usage](usage.md) |
| Plain status lines start with `ask RUN · outcome ·`, where RUN is the run's name, or its id when it has none; terminals may redraw live state | [Runs](runs.md) |
| Result fields (`run`, `id`, `model`, `write`, `name`, `ok`, `answer`/`error`, optional `raw_answer` on JSON/schema validation failure, `seconds`, `usage`, `session`, `dir`, `changes`, `commits`, `worktree`, `followups`) | [Batches](batches.md) |
| Run records: `tasks.json` (optional task `title`) and `results.json` in `~/.ask/runs/STAMP-ID[-NAME]/` | [Runs](runs.md) |
| `settings.json` keys and their meaning | [Settings](settings.md) |
| `environment.json` and agent environment sidecars | [Agent environments](environment.md) |
| `models.json`: per agent, a list of ids or ids mapped to `true`, `false` or `{"enabled", "max_cost"}` | [Models](models.md#modelsjson) |
| Agent environment `ASK_TITLE`: the task's user-facing session title | [Agents](agents.md#the-contract) |
| `ask setup` flags, `--check` exit status and `--check --json` fields | [Setup](setup.md) |
| `ask title --hook` output: Claude Code's `PreToolUse` `hookSpecificOutput` | [Hosts](hosts.md) |
| The agent contract | [Agents](agents.md) |
| The hook contract | [Hooks](hooks.md) |
| The command contract | [Commands](commands.md) |
| The package layout | [Packages](packages.md) |

## How they change

- **Additions are allowed.** New result fields, report fields, environment variables,
  events and options can appear in any release. Ignore what you don't know.
- **A breaking change bumps the contract version.** Every agent, hook and command gets
  `ASK_CONTRACT`, now `3`. A change that could break one changes that number and is called out in
  the changelog with what to do.
- **Run records stay readable.** Records written by a release are pinned in ask's tests
  (`src/test/fixtures/`) and never rewritten; newer versions must keep showing and continuing them.

JSON uses Go's `encoding/json`. Records keep the documented field order; JSON answers retain
agent key order. Parser diagnostics, insignificant whitespace, number spelling in ask's own records
and malformed Unicode handling are not byte-level contracts.

The public names remain `run` for a recorded invocation, `task` for one unit in a batch, `model`
for an `agent:id`, and `follow-up` for a continuation. Existing command, option, result and record
field names remain stable except for the detached-first CLI transition described below.

Contract 3 uses `running`, `succeeded`, `failed` and `stopped` for lifecycle status; the live
scheduler also uses `queued` while it knows a task is waiting. Machine `state` values use
`succeeded` instead of `success`; plain starts use `running` instead of `started`, and completions
use `succeeded` instead of `ok`. Update status parsers accordingly. Persisted result `ok` booleans
and historical run records retain their format.

Batch summaries include explicit succeeded and failed counts, including zeros; stopped work is
counted separately. Task status is followed by the model display name; hook lines use `note` or
`follow-up`; optional coarse progress uses `activity · CATEGORY`.

The `-c` and `--continue` options remain supported script aliases for conversation follow-ups;
batch `--resume` remains an alias for recovering unfinished or failed tasks. Use
`ask continue RUN "prompt"` for follow-ups and `ask continue RUN` for state-based recovery: usable
sessions continue the original task; if unavailable, ask may restart standalone reads without
hooks but refuses unsafe retries. Blockers require an explicit prompt after resolution. The JSON
`continue` field remains.

Tasks, prompted continuations and batches now detach by default and print a stable run ID instead
of an answer. Update answer-consuming scripts to use `--wait`, or capture the ID and collect it
with `ask wait ID`. `-w` still means write; `-m` selects a model or configured role.

The separate `ask start` command is removed, with no hidden compatibility alias. `run` and
`continue` are built-in command names; an existing prompt or custom command beginning with one is
shadowed. Use `ask -- run ...` or `ask -- continue ...` for a literal prompt.

Times are compact clocks above a minute and costs show cents at or above $0.01. `ask help` is the
overview, also available with `ask --help` or `ask -h`. `ask help COMMAND` and `ask COMMAND --help`
are equivalent for built-in commands; `-h` works on built-in commands, and `-V` aliases
`--version`. User commands handle their own help arguments.
