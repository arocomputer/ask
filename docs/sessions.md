# Sessions

A session is one conversation with a subagent: one folder, one six-character id like `k3f9a2`,
and one turn per prompt. `start` creates a session and its first turn; `continue` adds a turn.
The subagent sees everything the session read, said and did in earlier turns, even when a turn
changes models. Moving to a [harness](extensions.md) that wasn't part of the conversation, it
gets the conversation so far as text with its prompt; turns that stay with one harness continue
its own session.

A turn is `running`, then `succeeded`, `failed` or `stopped`; it is `retrying` while the provider
keeps failing and ask tries again. A session's state is its latest turn's.

## Read and write

A read-only task (the default) gets `read`, `list` and `grep` for files, `git` to see what
changed and why (`status`, `diff`, `log`, `show`, `blame`, which can't run anything a
repository's config names), and `fetch` and `search` for the web. It has no way to change a
file or run a command. That is how ask enforces read-only.

Every task also gets `fetch`, which reads a web page, such as documentation, as text. It runs in
ask itself and reaches only public addresses: nothing on your machine, your network, or a
cloud's metadata service.

And `search`, ask's own web search: it returns each result's title, address and snippet, for
`fetch` to read in full. It is free and needs no key or provider: it asks DuckDuckGo, then
DuckDuckGo's lite page, Mwmbl's open API, then Wikipedia's, so one engine turning a busy machine away
doesn't stop the task. Like `fetch`, it runs in ask itself, not in the task's sandbox. `ask tools` turns any tool off,
and an extension can replace any of them; see
[turning tools off](extensions.md#turning-tools-off-and-replacing-them).

Environment files (`.env`, `.env.local`, ...) hold a project's real secrets, so `read` refuses
them and `grep` skips them; their examples, like `.env.example`, stay readable.

A write task (`"write": true`) also gets `write`, `edit` and `shell`. Every path is confined to
the task's folder, symlinks included. Each `shell` command runs in ask's sandbox:

- It can write only the task's folder (and its repository's `.git`, so commits work) and a
  private temp folder, which is also its `HOME`. It can read the system and the tools on your
  `PATH`, but not your home folder.
- It gets no API keys, tokens or passwords from the environment, and can't reach your SSH or
  GPG agent, the desktop session, or Docker.
- It reaches the web through ask's proxy, public addresses only; servers it starts itself, on
  this machine, work as usual.
- It can't signal or look into your other programs, or gain privileges with `sudo`.
- If it changes the repository's git hooks or config, which git would run later outside the
  sandbox, ask puts them back after the turn, and the result lists them as `reverted`.

On Linux the sandbox is Landlock, part of the kernel since 5.13, through `sandybox`, a small
helper that comes with ask; on macOS it is the system's own sandbox. Nothing needs installing.
Older Linux kernels get less: before 6.7, commands have no network; before 7.1, they can't use
Unix sockets at all, so Python's process pools need one worker. Where there is no sandbox at
all, write tasks are refused, with why; `ask doctor` shows what this machine has. Claude Code
and Codex keep to their own sandboxes; see
[what a harness can reach](extensions.md#what-a-harness-can-reach). When the folder is in a git repository, the result lists every file the turn
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

Its instructions ([`src/agent/system.ts`](../src/agent/system.ts)) say that it is a subagent
whose final message is the whole answer, that what it reads (files, command output, web pages)
is material and never orders, and how to shape that answer: the answer first, then `path:line`
evidence and the commands it ran, what it changed and how it checked it, findings first in a
review, and what it couldn't verify. They give the facts it would otherwise spend steps on:
the folder, the repository's branch and whether it has uncommitted changes, the date, the
platform, and whether it may write. Then how to work: effort scaled to the task, searching
before reading, independent calls together, every claim grounded, the smallest fitting change,
proven by running the tests. The project's own `AGENTS.md` (or `CLAUDE.md`), the nearest one
between the task's folder and the repository root, follows. A task with a `schema` is told to
answer with JSON matching it, and providers that support it are given the schema as the
answer's format. Claude Code and Codex get the same framing on top of their own prompts.

These words are measured, not guessed: [`bench/`](../bench/README.md) runs graded tasks on
real models, and a change to them ships when it does at least as well.

## Looking at sessions

```sh
ask sessions          # newest first, from this repository: status, task, id and age
ask sessions --all    # from everywhere
ask show k3f9a2       # each prompt, its steps, the files it changed and the answer
```

Piped, `ask sessions` prints one tab-separated line per session: state, task, id and the time
the latest turn started.

## On disk

Each session is a folder in `~/.ask/sessions/ID`, private to your user: `session.json` (the turns
and their outcomes), `transcript.json` (the whole conversation, saved after every step), and
`log` (the worker's own errors, if any). A harness keeps its own copy of its session where it
always does. They hold prompts, answers, commands and file contents,
unredacted. Delete a folder to forget a session.
