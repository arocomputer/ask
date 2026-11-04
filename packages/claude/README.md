# claude

The official ask agent for [Claude Code](https://claude.com/claude-code).
It runs `claude -p` for ask, so `ask --model claude:sonnet-5.5 "..."` hands a task to Claude Code.

## Install

```sh
ask install claude
ask models
```

Requires Claude Code, logged in, and Node.js 18 or newer. The agent finds both even when they are
not on ask's `PATH`: Claude Code in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`,
`/usr/local/bin`, `~/.npm-global/bin` or `~/.local/share/pnpm`; Node.js in Homebrew, `/usr/local/bin`,
Volta, nvm (the newest), fnm or `~/.local/bin`. Without one, `ask models` shows what to install.

Installing the ask package does not install its CLI, Node.js or credentials. `ask models`
checks model listing, not whether a task can authenticate and run.

## Models

`ask models` includes the Claude agent's built-in model list: `fable-5.1`, `opus-5.5`, `sonnet-5.5`, `haiku-4.5`.
Name any other the same way, family then version (`sonnet-5` becomes Claude Code's
`claude-sonnet-5`), or by Claude Code's full id (`claude-haiku-4-5-20251001`), and add the ones you
use to `~/.ask/models.json`. Names match without regard to case.

Claude Code's aliases (`opus`, `sonnet`, `best`, ...) are refused with the exact name to use: they
change meaning when a new model ships, so a run's record would no longer say which model answered.
An effort (`claude:opus-5.5#high`) is passed as `--effort`.

## Read and write

- **Read runs** use Claude Code's default permission mode with only Read, Grep and Glob. Bash,
  Edit, Write and NotebookEdit are denied, so no shell command runs, not even `git log`: rules over
  a command's text cannot follow everything a shell expands. Git runs Claude Code starts itself
  take no optional locks and no fsmonitor (`GIT_OPTIONAL_LOCKS=0`, `core.fsmonitor=false`), so
  reading git status never rewrites the index. The prompt starts with an instruction to answer from
  the files in the working directory and never guess.
- **Write runs** (`ask --write`) bypass permissions: the agent edits files and runs commands freely.

A `--schema` is passed to Claude Code's `--json-schema`, and the answer is its structured output.

## Follow-ups

Every run starts with its own session id, reported to ask at once, so `ask continue RUN "prompt"` resumes it with
`--resume`, even after a run that was stopped. A follow-up's prompt is passed as is.

## Usage

While running, the agent reports coarse activity from Claude Code stream events. Status never includes tool arguments, paths or message contents.


The agent streams Claude Code's events and rewrites ask's report as each model call starts and
finishes, so token counts show live; the cost arrives with the result. The report names the model
that did most of the work (`Opus 5.5`).

## Cost limits

Claude Code reports cost only when it ends, so ask can't stop it on cost itself. The agent passes
ask's limit (`ASK_MAX_COST`, from `--max-cost`, models.json or the `max_cost` setting) to Claude
Code as `--max-budget-usd`, which stops after the model call that passes it. The run fails as
`stopped at the $2.00 cost limit`, keeps its session, and `ask continue RUN "prompt"` continues it.

## Environment

| Variable | |
| --- | --- |
| `ASK_CLAUDE_BIN` | The `claude` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_NODE` | The Node.js executable to run the agent with. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`, `ASK_TITLE`,
`ASK_SCHEMA`, `ASK_SESSION`, `ASK_REPORT` and `ASK_MAX_COST` (see [Agents](../../docs/agents.md)).

## Testing

```sh
cd packages/claude && node --test
```

The tests drive a fake `claude` in `test/bin`; they need no network or account. To try the real
thing by hand:

```sh
echo "say hi" | ASK_MODEL=haiku-4.5 ASK_ACCESS=read ASK_REPORT=/tmp/r.json \
  ~/.ask/packages/ask/packages/claude/agents/claude
cat /tmp/r.json
```
