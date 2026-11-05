# Sessions

A session is one conversation with a subagent: one folder, one six-character id like `k3f9a2`,
and one turn per prompt. `start` creates a session and its first turn; `continue` adds a turn.
The subagent sees everything the session read, said and did in earlier turns.

A turn is `running`, then `succeeded`, `failed` or `stopped`; it is `retrying` while the provider
keeps failing and ask tries again. A session's state is its latest turn's.

## Read and write

A read-only task (the default) is given three tools: `read`, `list` and `grep`. It has no way to
change a file or run a command. That is how ask enforces read-only.

A write task (`"write": true`) also gets `write`, `edit` and `shell`. Every path is confined to
the task's folder, symlinks included, and commands run without provider keys (`*_API_KEY`) in
their environment. When the folder is in a git repository, the result lists every file the turn
added, modified or deleted, including those in commits it made, and how many commits.

## Worktrees

`"worktree": true` gives a write task a checkout of its own, so your files stay untouched. ask
creates a branch `ask/NAME` from your current commit, where NAME comes from the prompt's first
words, and checks it out in `~/.ask/worktrees/NAME`. Tasks started together get `NAME-2`,
`NAME-3` and so on. The task works in the same subfolder you were in. The result names the
worktree's path and branch, and later turns work there too. When you are done with it, merge the
branch as you like and remove it with `git worktree remove`.

## Resuming

Each turn runs in a background worker, which saves the conversation after every step. If the
worker is stopped partway (a crash, a reboot, or an environment that ends background processes
when the command that started them ends), the next `collect` restarts the turn from where it
stopped, up to ten times, and its result says `"resumed": N`. A tool call that was cut off reaches
the model as interrupted, with a note to check whether it took effect before running it again,
so a half-run command isn't silently repeated.

Some agent environments end every process a command started once the command returns. There,
subagents only make progress while a `collect` is waiting. Once ask sees that, `collect` waits
for every task listed instead of the first, and the response carries a hint to use the longest
wait the shell allows.

`{"continue": ID}` without a prompt resumes a stopped or failed turn by hand.

## What the subagent is told

Its instructions say it is a subagent whose final message is the answer, where it works, whether
it may write, and to cite files and line numbers. The project's own `AGENTS.md` (or `CLAUDE.md`),
the nearest one between the task's folder and the repository root, follows. A task with a
`schema` is told to answer with JSON matching it, and providers that support it are given the
schema as the answer's format.

## Looking at sessions

```sh
ask sessions          # newest first: status, task, id and age
ask show k3f9a2       # each prompt, its steps, the files it changed and the answer
```

Piped, `ask sessions` prints one tab-separated line per session: state, task, id and the time
the latest turn started.

## On disk

Each session is a folder in `~/.ask/sessions/ID`, private to your user: `session.json` (the turns
and their outcomes), `transcript.json` (the whole conversation, saved after every step), and
`log` (the worker's own errors, if any). They hold prompts, answers, commands and file contents,
unredacted. Delete a folder to forget a session.
