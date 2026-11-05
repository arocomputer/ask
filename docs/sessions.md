# Sessions

A session is one conversation with a subagent: one folder, one six-character ID like `k3f9a2`,
and one turn per prompt. A launch creates a session and prints its ID once a worker holds it;
`ask continue ID "..."` adds a turn. The worker lives in its own session of the operating
system, so closing the terminal or the calling agent's tool does not end it. `ask stop ID` does.

```sh
a=$(ask "Why does the login test fail?") || exit $?
b=$(ask -m opencode-go/glm-5.3 "Review the session code for races.")
ask show "$a"            # state and recent activity now
ask wait "$a"            # the latest turn's answer; exit 1 if it failed
ask wait "$a" "$b"       # the first to finish; stderr says which
```

A turn is `running`, then `succeeded`, `failed` or `stopped`; a session's state is its latest
turn's. A turn whose worker died (a crash, a reboot) shows as stopped once nothing holds the
session's lock.

## Turns

`ask continue ID "prompt"` adds a turn: the model sees everything the session read, said and
did. The ID stays the same, so `ask wait ID` returns the new turn's answer. `--wait` waits right
away. A turn keeps the session's directory and worktree, keeps the model unless `-m` chooses
another from the same provider, and `-w` adds write access for this turn and the ones after it.

```sh
ask --wait "Why does the login test fail?"
ask continue k3f9a2 --wait -w "Fix it, then run the test."
ask continue k3f9a2 "Now add a test for the expired-token case."
```

`ask continue ID` without a prompt resumes an interrupted turn: the model is asked to carry on
where it left off and finish. A session whose latest turn succeeded needs a prompt; one that is
running needs `ask wait` first.

Native sessions keep their transcript in the session's folder. A session on an external harness
continues that harness's own session, which the harness must have reported.

## Whose sessions

`ask sessions` and `ask wait` with no IDs show the sessions started by the calling conversation:
ask reads `ASK_PARENT`, or the session variable Claude Code (`CLAUDE_CODE_SESSION_ID`) and Codex
(`CODEX_THREAD_ID`) set for the commands they run, and records it with each session. Two agents
delegating in the same repository never see each other's sessions. Where no such variable
exists, the default is the sessions started in, or working in, the current repository (or
directory). `--all` lists every session.

```sh
ask sessions            # yours, most recently active first, 20 by default
ask sessions -n 50 --all
ask sessions --json     # result records
```

```text
ID      UPDATED  STATE        TURNS  ACCESS  MODEL    TIME   TASK
k3f9a2  2m ago   ✓ succeeded  2      write   GLM 5.3  1:12   Why does the login test fail?
p81c0d  9m ago   ! running    1      read    GLM 5.3         Review src/auth for races.
```

TASK is the session's first prompt; the other columns describe its latest turn. Piped, the list
is tab-separated with no header, the full timestamp and no color, so `cut` and `grep` work on
it; `--json` gives the records.

## Inspecting a session

`ask show ID` returns at once with the status line and recent activity on stderr, and the
latest answer on stdout once finished. Activity is what the subagent did, across every turn:
its messages, each tool call with a one-line summary of its input, and each result, clipped.

```text
status: turn 2 running
tool grep: expiry in auth
tool_result grep: auth/token.go:42:    if exp < now {
message: The expiry check compares seconds with milliseconds.
```

- `--follow` keeps printing until the turn ends. Interrupting it leaves the session going.
- `--after CURSOR` prints one JSON page of events from a byte cursor: `{"session_id", "state",
  "events": [{"type", "text", "tool"}], "next_cursor", "has_more"}`. Start at 0 and pass
  `next_cursor` back for only what is new. Pages are bounded, so a caller with a tool timeout
  can poll instead of streaming.
- `--json` prints the result record.

Event text is what the model and the tools produced: commands, paths, file contents. ask stores
it privately with the session and does not redact it. Treat it as a transcript.

## Stopping

`ask stop ID` signals the worker, which ends the model call and every process the turn started,
records the turn as stopped and exits. It waits up to ten seconds. Exit 1 when nothing was running.

## Cleaning up

```sh
ask clean               # shows the plan, then asks
ask clean --dry-run
ask clean --yes --days 7
```

Sessions inactive for longer than `--days` (default 30) are removed. A worktree goes when its
branch has no uncommitted changes and either changed nothing or every file it changed already
matches the main branch (as after a merge or a squash merge); its branch goes with it. A session
whose worktree stays also stays.

## The result record

`--json` on `wait`, `show`, `sessions` and `--wait` launches prints this record for the latest turn:

```json
{
  "session_id": "k3f9a2",
  "turn": 2,
  "state": "succeeded",
  "model": "opencode-go/glm-5.3",
  "write": true,
  "dir": "/Users/me/code/app",
  "parent": "claude-code:5f710ff9-...",
  "created": "2026-11-05T02:12:11.345Z",
  "updated": "2026-11-05T02:14:40.102Z",
  "seconds": 72.4,
  "usage": { "input": 44200, "output": 1300, "cached": 30100, "cost": 0.14 },
  "answer": "Fixed: the expiry is now in milliseconds. go test ./auth passes.",
  "changes": [{ "path": "auth/token.go", "change": "modified" }],
  "task": "Why does the login test fail?"
}
```

`error` replaces `answer` when the turn failed or was stopped. `commits` and `worktree` appear
on write sessions; `activity` is the latest event while running; `harness_session` is an
external harness's own session. The prompts are not included; `task` is the first one's first
line.

## Where sessions live

Each session is a folder in `~/.ask/agent/sessions/`, named by its start time and ID:

```text
~/.ask/agent/sessions/20261105T021211345-k3f9a2/
├── session.json      the session and every turn: prompt, model, limits and outcome
├── transcript.json   the conversation so far (native sessions)
├── events.jsonl      activity across turns, one JSON object per line
├── worker.log        what workers wrote to stderr
└── lock              held by the worker while a turn runs
```

Folders are created with mode 0700 and records 0600. Deleting a folder removes the answers and
the ability to continue the session.
