# Requests

Agents use ask by sending one JSON request on stdin and reading one JSON response on stdout. A
heredoc keeps any prompt intact, quotes and all:

```sh
ask <<'EOF'
{"start": [{"prompt": "Where is the retry logic?"}], "wait": 100}
EOF
```

A request holds exactly one operation. Subagents work in the background, so a request returns as
soon as they have started, or once one has finished if it says how long to wait.

## start

```json
{"start": [{"prompt": "Review src/auth for races"}, {"prompt": "Summarize the public API"}], "wait": 100}
```

Starts every task at once. Without `wait`, it returns right away with each task `running`. With
`wait`, it returns when the first task finishes, or when `wait` seconds pass, reporting every
task. Every task is checked before any starts, so a mistake in one starts none of them.

A task takes:

| Field | Meaning |
| --- | --- |
| `prompt` | What to do (required) |
| `model` | `provider/model`; default: `model` in config.json |
| `write` | `true` to let it edit files and run commands; default: read-only |
| `worktree` | `true` to work on a new branch, `ask/NAME`, in its own checkout; implies `write` |
| `dir` | Where it works; default: the current directory |
| `effort` | Reasoning effort, like `low`, `medium` or `high` |
| `schema` | A JSON Schema its answer must match |
| `timeout` | Seconds before it is stopped; default: `timeout` in config.json, else 900 |

## collect

```json
{"collect": ["k3f9a2", "p0q8zz"], "wait": 100}
```

Blocks until at least one of the sessions has finished, or `wait` passes (default 600), then
reports them all. Finished sessions stay finished, so collect the rest again. It also restarts
any task whose worker was stopped (see [Sessions](sessions.md#resuming)).

## continue

```json
{"continue": "k3f9a2", "prompt": "Now add a test for the expired-token case", "write": true, "wait": 100}
```

Gives a finished session its next prompt. The subagent keeps the whole conversation, the folder
and the worktree. It takes a task's fields except `dir` and `worktree`, and keeps the last turn's
model unless it names another.

Without a prompt, `{"continue": "k3f9a2"}` resumes a stopped or failed turn where it left off. A
running session can't be continued; collect it first.

## stop

```json
{"stop": ["k3f9a2"]}
```

Stops sessions. A stopped session can be continued or resumed.

## show

```json
{"show": "k3f9a2"}
```

The session's latest turn, with `steps`: every tool call it made, like `read src/auth.ts:40` or
`shell npm test`, and any that failed.

## Responses

Every response is a list of tasks:

```json
{"tasks": [{"id": "k3f9a2", "state": "succeeded", "answer": "..."}]}
```

| Field | When |
| --- | --- |
| `id` | Always: the session's id, for collect, continue, stop and show |
| `state` | Always: `running`, `retrying`, `succeeded`, `failed` or `stopped` |
| `answer` | It succeeded |
| `error` | It failed: `{"message", "hint"}`, where the hint says what to do next |
| `changes` | A write task changed files: `[{"path", "change"}]`, `change` being added, modified or deleted |
| `commits` | A write task made commits |
| `worktree` | A worktree task: `{"path", "branch"}` |
| `activity` | It is running: its latest step |
| `retrying` | The provider is failing and being retried: why |
| `resumed` | ask restarted it after its worker was stopped: how many times |
| `steps` | With show: every step of the latest turn |

A response may also carry a `hint`, when the caller should wait differently (see
[Sessions](sessions.md#resuming)).

A request ask can't carry out gets an error instead, and exit status 2:

```json
{"error": {"message": "start[0] has unknown key modle", "hint": "it takes prompt, model, write, worktree, dir, effort, schema, timeout"}}
```

## Waiting well

Keep each call within your shell tool's time limit: a `wait` of about 100 seconds suits most, and
`collect` again for whatever is still running. Starting tasks with `wait` returns the first answer
in the same call, which is the fastest way when later work depends on it.

## From code

The library takes the same requests and returns the same responses:

```ts
import { handle, home } from "@arocomputer/ask"

const r = await handle(home(), { start: [{ prompt: "Where is the retry logic?" }], wait: 100 })
```

Tasks run in the same background workers as from the command line, so they outlive the calling
process.
