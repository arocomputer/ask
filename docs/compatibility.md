# Compatibility

What you build on ask keeps working when ask updates. These are the contracts ask keeps, and how
they may change.

## The contracts

| Contract | Where it is described |
| --- | --- |
| The command line: commands, options, exit codes (0 ok, 1 a run failed, 2 a usage error), stdout carrying only answers | `ask help`, [Usage](usage.md) |
| Plain status lines start with `ask RUN · outcome ·`, where RUN is the run's name, or its id when it has none; terminals may redraw live state | [Runs](runs.md) |
| Result fields (`run`, `id`, `model`, `write`, `name`, `ok`, `answer`/`error`, `seconds`, `usage`, `session`, `dir`, `changes`, `commits`, `worktree`, `followups`) | [Batches](batches.md) |
| Run records: `tasks.json` (optional task `title`) and `results.json` in `~/.ask/runs/STAMP-ID[-NAME]/` | [Runs](runs.md) |
| `settings.json` keys and their meaning | [Settings](settings.md) |
| `models.json`: per agent, a list of ids or ids mapped to `true`, `false` or `{"enabled", "max_cost"}` | [Models](models.md#modelsjson) |
| Agent environment `ASK_TITLE`: the task's user-facing session title | [Agents](agents.md#the-contract) |
| `ask setup` flags, `--check` exit status and `--check --json` fields | [Setup](setup.md) |
| `ask title --hook` output: Claude Code's `PreToolUse` `hookSpecificOutput` | [Hosts](hosts.md) |
| The agent contract | [Agents](agents.md) |
| The hook contract | [Hooks](hooks.md) |
| The command contract | [Commands](commands.md) |
| The package layout | [Packages](packages.md) |

## How they change

- **Additions don't break anything.** New result fields, report fields, environment variables,
  events and options can appear in any release. Ignore what you don't know.
- **A breaking change bumps the contract version.** Every agent, hook and command gets
  `ASK_CONTRACT`, now `1`. A change that could break one changes that number and is called out in
  the changelog with what to do.
- **Run records stay readable.** Records written by a release are pinned in ask's tests
  (`test/fixtures/`) and never rewritten; newer versions must keep showing and continuing them.

JSON uses Go's `encoding/json`. Records keep the documented field order; JSON answers retain
agent key order. Parser diagnostics, insignificant whitespace, number spelling in ask's own
records and malformed Unicode handling are not byte-level contracts.

The public names remain `run` for a recorded invocation, `task` for one unit in a batch,
`model` for an `agent:id`, and `follow-up` for a continuation. Existing command, option,
result and record field names remain stable. Status lines now put `started`, `ok` or
`failed` directly after the run id, followed by the model display name; hook lines use
`note` or `follow-up`; optional coarse progress uses `activity · CATEGORY`. The start-line `continues` label is now `follow-up`; the `-c`
option and JSON `continue` field remain. Times are compact clocks above a minute and costs show cents at
or above $0.01. `ask help` is the overview, also available with `ask --help` or `ask -h`.
`ask help COMMAND` and `ask COMMAND --help` are equivalent for built-in commands; `-h` works
on built-in commands, and `-V` aliases `--version`. User commands handle their own help
arguments.
