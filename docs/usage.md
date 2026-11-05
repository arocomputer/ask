# Usage

```sh
ask [options] "prompt"
ask run [options] "prompt"
```

By default, both forms detach and return the stable run ID on stdout after admission.
Use `ask wait ID` to block for the answer, or add `--wait` to run synchronously.
Exit 0 from a detached launch means accepted, not that the task succeeded.

```sh
id=$(ask -m claude:sonnet-5.5 "Where is the retry logic?")
ask show "$id"                    # inspect now; never waits
ask wait "$id"                    # wait and return the answer
ask -m claude:sonnet-5.5 --wait "Explain the retry limits."
```

`-m` / `--model` selects a model or configured role; `-w` / `--write` allows edits and
commands. The default is read-only. A configured default model is optional when you give `-m`.

`ask help` is a compact command reference. `ask help batch`,
`ask help hooks` and `ask help agents` describe their contracts.

Choose `MODEL` from `ask models`, or a user-defined [model role](models.md#model-roles) from
`ask models --roles`. Every run uses an explicit model: from `-m` / `--model`, a follow-up, or
your default [setting](settings.md). The examples below use particular agents and models;
replace them with ids available in your installation. `RUN` is a name or id printed by ask
(see [Runs](runs.md)).

```sh
ask --model claude:sonnet-5.5 "Where is the retry logic, and what are its limits?"
ask --model codex:gpt-6.1-sol#high "Review the last commit for bugs."
```

With `--wait`, agents that report activity (including Codex and Claude Code) show coarse labels such as `running commands` or
`editing files` on stderr while working. Terminals refresh the live row; pipes and dumb terminals
get deduplicated activity lines at most once every five seconds per task. These labels contain no
commands, paths, reasoning or output. Brief events can be missed; a label describes the most recent
observed work, not a guarantee that the agent is still making progress.

## The prompt

Give it as arguments, or on stdin with `-` or no prompt at all. Words after `--` are always the
prompt, even ones that look like options:

```sh
ask --model claude:sonnet-5.5 "Summarize src/"
git diff | ask --model codex:gpt-6.1-sol -
ask --model claude:sonnet-5.5 < task.md
git diff | ask --wait                             # answer using your default model
git diff | ask --wait --stdin "Review this diff for bugs; give file, line and impact."
ask --wait --stdin "Summarize this incident report" < incident.md
```

With an argument prompt, `--stdin` appends stdin after a blank line and reads until EOF.
The input is kept as supplied; an empty stream leaves the argument prompt unchanged.
Without an argument prompt (or with `-`), stdin supplies the whole prompt as before.
Use a schema file instead of `--schema -` when stdin supplies prompt context.

`git diff | ask 'Review this diff'` leaves stdin unread: an inherited open pipe is
indistinguishable from deliberate input, and reading it could hang or consume a shell loop's
remaining input. Add `--stdin` to opt in to reading both. It needs a pipe or redirected input;
with an open stream, it waits for the writer to close it. The task timeout starts after input
has been read, so it does not bound this wait.

With a default model configured in [Settings](settings.md), `ask "prompt"`, `ask run "prompt"`
and bare piped stdin all use it.

`--title TEXT` replaces the prompt text in the agent's session title, without changing the task:

```sh
ask --model codex:gpt-6.1-sol --title "Review login" "Inspect the login flow for races."
```

`-m` selects a model or role; `-w` enables write access. `-c RUN` aliases a prompted
follow-up, `-C` selects the directory and `-t` sets the timeout. `--title` is long-only;
`--wait` has no short form; `-w` always means write.

## Read or write

| Option | Access |
| --- | --- |
| `--read`, `-r` | Read only. The default. |
| `--write`, `-w` | Read and write: the agent may edit files and run commands, as you. |

```sh
ask --model claude:sonnet-5.5 "Which functions have no tests?"                 # read
ask --model claude:sonnet-5.5 --write "Add tests for parseFlags, then run them" # write
```

ask passes your prompt to the agent as you wrote it, with the access in `ASK_ACCESS`. The agent
enforces read-only in its CLI's own way, and may add its own guidance for read runs, like
"search and read the files before answering"; see [Agents](agents.md#read-only). With the official
agents, a read run on Claude Code or Opencode can only read and search files, and runs no shell
commands at all, not even `git log`; one on Codex may run commands in Codex's read-only sandbox.

Running tests or builds writes files, so it needs `--write`. In a batch or bench, an explicit `--read` is a
ceiling: a task with `"write": true` is refused, not run with write access.

## What a write run changed

When a write run's directory is in a git repository, ask compares the repository before and after
and reports what the run changed: in the status line, and in full with `ask show RUN --json`.

```text
ask fix-parser-bugs · succeeded · Sonnet 5.5 · 41.2s · 3 files changed, 1 commit · 52.1k in · 2.0k out · $0.31
```

```json
"changes": [
  { "path": "src/parser.js", "change": "modified" },
  { "path": "test/parser.test.js", "change": "added" }
],
"commits": 1
```

File mode changes and symbolic links are included. Files that were already modified before the run are reported only if the run changed them again,
so your own uncommitted work never shows up as the agent's.

## Working in a worktree

`--worktree` (with `--write`) gives the run its own git worktree and branch, so several write runs
can work in separate checkouts in parallel:

```sh
ask --wait --model claude:sonnet-5.5 --write --worktree --directory ~/code/app "Add rate limiting to the login route."
```

```text
ask add-rate-limiting-login · running · Sonnet 5.5 · write · worktree ~/.ask/worktrees/add-rate-limiting-login
ask add-rate-limiting-login · succeeded · Sonnet 5.5 · 3:05 · 4 files changed · branch ask/add-rate-limiting-login · worktree ~/.ask/worktrees/add-rate-limiting-login · 120.4k in · 6.2k out
```

The worktree starts from the repository's `HEAD`, at `~/.ask/worktrees/RUN`, on branch `ask/RUN`
(`RUN-2` and so on if another run's worktree has that name, so parallel runs never share one).
The `worktrees` and `branches` [settings](settings.md) put them elsewhere, like
`~/code/worktrees/ask-RUN`, or inside each repository with `.ask/worktrees/{name}`.
If the run changed something, both are kept for you to review and merge:

```sh
git -C ~/.ask/worktrees/add-rate-limiting-login status --short
git -C ~/.ask/worktrees/add-rate-limiting-login diff HEAD
# After reviewing, commit any uncommitted edits in the worktree.
git -C ~/code/app diff HEAD...ask/add-rate-limiting-login
git -C ~/code/app merge ask/add-rate-limiting-login
git -C ~/code/app worktree remove ~/.ask/worktrees/add-rate-limiting-login
git -C ~/code/app branch -d ask/add-rate-limiting-login
```

Use the actual path and branch from the run's output. ask does not automatically commit the
agent's edits: merging a branch includes only committed changes. `diff HEAD` shows tracked
uncommitted edits; inspect untracked files listed by `status` too.

After all hook follow-ups, ask removes a worktree only when git reports it clean and its HEAD
still points to the starting commit. An idle follow-up keeps earlier work. A read-only follow-up
can use a kept worktree; recreating one requires write access. Uncommitted changes in your
checkout are not in the worktree; ask says so when it starts.

## Where the agent works

`--directory DIR` sets where the agent works (default: where you run ask). `--dir` and `-C` are aliases:

```sh
ask --model claude:sonnet-5.5 --directory ~/code/app "How does login work?"
```

## Time limit

`--timeout SECONDS` stops a run that takes too long (default 900, at most 2000000). `-t` is its short form. The run fails with `timed out`, and
everything the agent started is stopped.

```sh
ask --model codex:gpt-6.1-sol --write --timeout 3600 "Upgrade the project to Node 24 and fix what breaks."
```

## Cost limits

A cost limit stops a task that spends more than you meant to. It is off unless you set one:

```sh
ask settings set max_cost 2                       # every task: a $2 cost limit (the max_cost setting)
ask models claude:opus-5.5 --max-cost 10          # this model: its own limit, instead
ask --model claude:opus-5.5 --max-cost 25 --write "Port the parser to Rust."   # this run only
```

The run's own `--max-cost` wins, then the model's limit in models.json, then the setting; `0`
means no limit. A follow-up keeps a positive recorded limit unless you give it one. A prior
unlimited run has no limit to inherit, so the model's limit or your setting applies unless
you explicitly pass `--max-cost 0` again.
When a task passes its limit, the agent is stopped. If it has reported a session, you can
continue the conversation and decide whether it's worth more.

```text
ask port-parser-rust · failed · Opus 5.5 · 6:12 · 412.0k in · 9.1k out · $25.31 · stopped at the $25.00 cost limit
```

Use `ask continue port-parser-rust "Finish the port."` to follow up in the saved conversation.

How closely a limit holds depends on what the agent's CLI reports. Opencode reports cost after
every step, so ask stops it within a step of the limit. Claude Code reports cost only when it
ends, so its agent hands the limit to Claude Code's own budget, which stops after the model call
that passes it. Codex reports no cost, so limits don't apply to it; use `--timeout` to bound its time.

## JSON answers

`--json` requires the answer to be JSON. `--schema FILE` requires JSON that matches a JSON Schema.
These control the agent's answer format, not launch output: a detached launch still prints an ID.
Use `--wait` to consume the JSON answer directly. `ask wait ID --json` instead returns Ask's
result data; `ask runs --json` provides machine-readable run state.
ask tells the agent the format, strips a code fence if the agent adds one, and checks the answer
itself, whatever the agent. An agent whose CLI supports schemas natively can also enforce it
there, from `ASK_SCHEMA`.

```sh
cat > findings.json <<'EOF'
{
  "type": "object",
  "properties": {
    "bugs": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "file": { "type": "string" },
          "line": { "type": "integer" },
          "problem": { "type": "string" }
        },
        "required": ["file", "problem"]
      }
    }
  },
  "required": ["bugs"]
}
EOF
ask --wait --model claude:sonnet-5.5 --schema findings.json "Find bugs in src/parser.js" | jq '.bugs[].file'
```

ask honors boolean schemas (`false` rejects every answer) and checks `type`, `enum`, `const`, `properties`, `required`, `additionalProperties: false` and `items` (including `items: false`).
Other schema keywords are ignored by ask; an agent may enforce more. An
answer that is not JSON, or does not match, fails the run with the reason:

```text
ask find-bugs-src-parser · failed · Sonnet 5.5 · 12.3s · answer does not match the schema: $.bugs[0]: missing "file"
```

On JSON/schema validation failure, the result keeps `ok: false` and `error`, omits `answer`,
and adds `raw_answer`: the agent's original stdout as a string, including fences and whitespace.
Inspect it with `ask show RUN --json` to recover useful work or prepare a focused repair prompt.
That command still exits 1. Synchronous single-task answer output stays empty on failure; status lines do
not print the raw answer. Saved results, batch JSON and result hooks carry it, so handle them
as private task content. This field covers answers rejected by Ask's validation after the agent
exits successfully; agent errors and timeouts do not acquire it.

## Follow-ups

Every run gets a name from its prompt. `ask continue RUN "prompt"` follows up in the same agent
conversation. A follow-up keeps the previous model and access unless you change them. Use `--write`
to implement a read-only investigation, and `--read` to switch back; see [Runs](runs.md).

```sh
id=$(ask -m claude:sonnet-5.5 "Why does the login test fail?")
ask wait "$id"
ask continue "$id" --wait -w "Fix it."
```

Without a prompt, `ask continue RUN` finishes stopped or failed work in a usable saved session,
otherwise restarts. Add `--wait` for synchronous results and recovery diagnostics. Successful
batch tasks stay untouched. Active runs get wait guidance; completed runs require an explicit
follow-up prompt.
Auth, refusal and cost blockers need resolution and an explicit prompt; see [Runs](runs.md).
`--continue RUN` and `-c RUN` remain supported script aliases for conversation follow-ups.

A prompted follow-up detaches by default and returns its own stable ID; use `--wait` for the
answer. Use `ask stop ID` to cancel. See [Runs](runs.md#detached-execution) for lifecycle details.

## Output

| Command | stdout | Meaning of exit 0 |
| --- | --- | --- |
| `ask "task"`, `ask continue RUN "prompt"`, `ask batch FILE` | Stable run ID, one line | Admitted; task outcome is still unknown |
| `ask --wait "task"`, `ask continue RUN --wait "prompt"` | Answer only | Succeeded |
| `ask batch --wait FILE` | Result array in task order, including failures | All tasks succeeded |
| `ask wait RUN` | Answer, or a multi-task batch result array | Selected work succeeded |
| `ask wait RUN --json` | Machine-readable result data, including failures | Selected work succeeded |
| `ask show RUN` | Available answer/result; inspect current state without waiting | See [Runs](runs.md#inspecting-a-run) |
| `ask runs --json` | Machine-readable run state | Listing succeeded |

Status and errors go to **stderr**. A detached launch emits no ID when validation or admission
fails. Exit **1** means launch/execution failure or failed/stopped work when collecting a result;
exit **2** means a usage error. A failed single task emits no plain answer; JSON result output
retains failure details. Check the command's exit status when consuming results; a shell pipeline
ordinarily reports only its last command's status.

Use stable IDs for orchestration. Names move to the latest conversation turn. `ask wait A B`
collects the first selected completion; `--id` prints only its identity. Waiting does not consume
results. `ask show` never waits. See [Runs](runs.md#waiting-for-runs) for selection semantics.

Usage shows only metrics an agent reports. Cache reads are shown separately; whether they are
included in input depends on the agent. A batch labels summed values as reported usage and omits
cost when any task did not report it. Saved results are not a complete spending history: interrupted
or retried attempts may be absent, and agents differ in what they report.

With `--wait`, Ctrl-C stops the agents. Detached workers survive the launcher exiting;
use `ask stop ID` to cancel them. Interrupting `ask wait` only stops waiting.

With `--wait` on a terminal, stderr shows a spinner with the model name, read/write access, directory,
elapsed time and the tokens and cost so far, as the agent reports them (see
[Agents](agents.md#running-name)), then a final marked row. Hook notes and follow-ups appear beneath their task.
Batches show a header and task rows with queued, running, ok or failed state and reasons.
Rows fit the terminal width; when a batch is too large for the screen, active rows and the footer
stay visible where space permits, with a count of hidden lines.
The frame finishes before answers print, so stdout may share the terminal. Ctrl-C stops agents,
leaves the stopped state visible and restores the cursor. `TERM=dumb` uses plain lines;
`NO_COLOR` disables colors while retaining live updates. Piped stderr has no ANSI or spinner.
