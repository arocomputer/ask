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
change meaning when a new model ships, so a session's record would no longer say which model answered.
An effort (`claude:opus-5.5#high`) is passed as `--effort`.

## Read and write

- **Read sessions** use Claude Code's ordinary permission mode (`manual` or `default`, from help),
  limiting built-in tools to Read, Grep and Glob when supported. Bash,
  Edit, Write and NotebookEdit are denied, so the model gets no shell tool, not even for `git log`: rules over
  a command's text cannot follow everything a shell expands. Git runs Claude Code starts itself
  take no optional locks and no fsmonitor (`GIT_OPTIONAL_LOCKS=0`, `core.fsmonitor=false`), so
  reading git status never rewrites the index. The prompt starts with an instruction to answer from
  the files in the working directory and never guess.
- **Write sessions** (`ask --write`) bypass permissions: the agent edits files and runs commands freely.

A `--schema` is passed to Claude Code's `--json-schema`, and the answer is its structured output.

## Follow-ups

Every run starts with its own session id, reported to ask at once, so `ask continue RUN "prompt"` resumes it with
`--resume`, even after a turn that was stopped. A later turn's prompt is passed as is.

## Usage

While running, the agent reports coarse activity from Claude Code stream events. Status never includes tool arguments, paths or message contents.


The agent streams Claude Code's events and rewrites ask's report as each model call starts and
finishes, so token counts show live; the cost arrives with the result. The report names the model
that did most of the work (`Opus 5.5`).

## Live activity

When ask supplies `ASK_EVENTS`, the agent appends native visible activity to its private JSONL
file, separately from the final answer on stdout.

Native visible text deltas and assistant snapshots produce `message` records without repeating
streamed text; tool uses and results produce `tool` and `tool_result`. Thinking/signature blocks
are omitted.

Every append is one UTF-8 JSON line, at most 16 KiB including its newline. Text and tool
names lose terminal escapes, controls (except LF/tab) and bidi/format controls; tool names are
limited to 128 UTF-16 code units without splitting surrogate pairs. Text is sanitized before
truncation by encoded JSON size, with an ellipsis for truncation; whitespace chunks survive.
Common credential forms and inherited credential environment values are suppressed best effort,
which is incomplete, especially across chunks. Treat activity as a sensitive transcript.

The sink must be absolute, pre-created, regular, private (no group/other permission bits) and
owned by the current user. Each record reopens and validates it without following a final
symlink. The writer never creates or truncates it, so retries append. A failed or short append
disables activity for that invocation without retrying or repairing any partial tail; subsequent
invocations append without repairing it too. Sink failures leave the answer, report and exit
status unchanged. See [Extensions](../../docs/extensions.md) for the bundled writer safeguards.

## Cost limits

Claude Code reports cost only when it ends, so ask can't stop it on cost itself. The agent passes
ask's limit (`ASK_MAX_COST`, from `--max-cost`, models.json or the `max_cost` setting) to Claude
Code as `--max-budget-usd`, which stops after the model call that passes it. The turn fails as
`stopped at the $2.00 cost limit`, keeps its session, and `ask continue RUN "prompt"` continues it.

## Launch controls

Every run keeps Claude Code minimal where the installed version supports it (checked in its
`--help`): MCP servers are off with a strict empty config, slash commands and skills are off,
and read sessions get only the Read, Grep and Glob tools. Hooks and plugins stay as you configured
them: Claude Code has no switch that drops optional ones without also dropping policy hooks.
Settings and `CLAUDE.md` are read as usual. These are launch flags, not a sandbox.

| Variable | |
| --- | --- |
| `ASK_CLAUDE_BIN` | The `claude` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_NODE` | The Node.js executable to run the agent with. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`, `ASK_TITLE`,
`ASK_SCHEMA`, `ASK_SESSION`, `ASK_REPORT`, `ASK_EVENTS` and `ASK_MAX_COST` (see [Extensions](../../docs/extensions.md)).

## Testing

```sh
./x baymax claude
```

The tests drive a fake `claude` in `test/bin`; they need no network or account. To try the real
thing by hand:

```sh
echo "say hi" | ASK_MODEL=haiku-4.5 ASK_ACCESS=read ASK_REPORT=/tmp/r.json \
  ~/.ask/agent/extensions/claude/claude
cat /tmp/r.json
```
