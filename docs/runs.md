# Runs

Every time ask starts agents, that is a run. ask names it after the first meaningful words of its
prompt, and status lines start with the name:

```text
ask login-test-fail · started · Sonnet 5.5 · read · ~/code/app
ask login-test-fail · ok · Sonnet 5.5 · 14.2s · 31.0k in · 812 out · $0.09
```

`RUN` in commands is a placeholder for that name or the run's id. Use the name printed by your
run rather than assuming an example's name matches. A name stays apart from earlier runs with
a number (`login-test-fail-2`), and a [name hook](hooks.md#naming-runs) can choose better ones. Every run
also has a fixed six-character id, like `k3f9a2`, that works wherever a name does.

A task in a batch is `RUN/TASK`, using the task's id (or its position, from 1):
`summarize-public-api-src/api`.

## Follow-ups

`ask continue RUN "prompt"` continues that run's agent conversation: the agent remembers what it
read, said and did. `--continue RUN` and `-c RUN` remain supported script aliases.

```sh
ask --model claude:sonnet-5.5 "Why does the login test fail?"
# ask login-test-fail · ok · Sonnet 5.5 · 48.0s · ...
ask continue login-test-fail --write "Fix it, then run the test."
ask continue login-test-fail "Now add a test for the expired-token case."
```

A follow-up is a new run that takes over the conversation's name, so the name always reaches the
latest turn. An earlier turn is still reachable by its id. A follow-up to a batch task starts its
own line of turns, named `RUN-TASK` (or `RUN-TASK-2` and so on when another run has that name).

A follow-up:

- runs where the first run ran: the same directory, or the kept worktree's recorded path and branch.
  If ask discarded an unchanged worktree, a write follow-up creates one again, under a new name
  if another run has taken that one. A read follow-up needs the kept worktree to exist.
  A kept worktree replaced by another repository or branch is refused.
  `--worktree` can't move a follow-up of a run in your checkout into a worktree; ask refuses it;
- keeps the model and access (`--read`/`--write`) unless you give new ones. The model may change within
  the same agent (`ask continue login-test-fail --model claude:haiku-4.5 "Explain the fix."`), but not to another agent;
- can continue a run that failed or timed out, so the agent can finish what it started;

A batch task can be a follow-up too, with `"continue": "RUN"` (see [Batches](batches.md)).

A conversation follow-up needs an agent that reports sessions (see [Agents](agents.md#sessions))
and a run that is no longer active. Interrupted runs can be followed up when ask saved usable live session metadata; ask explains when it is missing.

## Continuing unfinished work

`ask continue RUN` without a prompt chooses from the saved state:

- **Running:** ask tells you to use `ask wait RUN`.
- **Failed or stopped:** ask finishes the original task in the saved conversation when its
  session and directory are usable. It checks an interrupted worktree's recorded repository,
  path and branch. If the session or safe location is missing, ask restarts the original task
  from the beginning. It announces the choice on stderr; stdout carries answers.
- **Completed:** in a terminal, ask lets you enter a follow-up (and choose a task for a completed
  batch). Outside a terminal, ask explains that a prompt is needed and exits without waiting
  for input.

Batches recover only unfinished or failed tasks; successful results stay untouched. Use
`RUN/TASK` to recover just one task. Recovery keeps recorded options, including access, JSON/schema,
model, timeout and cost limit. Only `--jobs` and `--no-hooks` apply without a prompt.

Auth, refusal, billing/quota and cost-limit failures are not automatically retried. ask explains
the blocker and leaves that task untouched while recovering other eligible batch tasks. Resolve
the blocker, then give an explicit follow-up prompt (and, if needed, change the cost limit).
Sessionless tasks need a new `ask run` after their blocker is resolved. Blockers are recognized
from failure text because the agent contract has no standard failure codes; opaque errors may
not be recognized.

```sh
ask continue login-test-fail # after it stops or fails
ask continue summarize-public-api-src
ask continue login-test-fail --max-cost 5 "I resolved the blocker; finish the task."
printf '%s' 'Now add tests.' | ask continue login-test-fail -
```

Explicit prompts follow up as usual. Use `-` to read streamed or delayed stdin until EOF.
Without `-`, stdin is read only when input is already available, then through EOF as usual;
an open empty pipe cannot hang state-based recovery. For reliable scripting, supply a prompt argument or `-`.

`ask batch --resume RUN` remains a supported script alias for this recovery of unfinished or
failed batch tasks; see [Batches](batches.md#resuming).

Only one pending task may use an agent session or kept worktree at a time. ask refuses a conflicting
follow-up with exit code 2; retry after the other run finishes. This applies across ask processes
sharing `ASK_HOME`, including references to older turns. A batch reserves all its pending follow-ups
before starting tasks and holds them until the batch finishes, so duplicate continuations are
refused even with `--jobs 1`. Stopping or exiting releases the reservations automatically.

## Listing

```sh
ask runs          # the last 20 in this repository
ask runs -n 50
ask runs --all    # every run, wherever it worked
```

In a git repository, `ask runs` lists the runs that worked in it: in its main checkout or any of
its worktrees. Elsewhere it lists every run.

```text
RUN                       ID      STARTED  STATUS   MODEL       TIME   TASK
login-test-fail           b7x01q  2m ago   ok       Sonnet 5.5  2:31   ↪ login-test-fail Fix it, then run the test.
login-test-fail           k3f9a2  5m ago   ok       Sonnet 5.5  48.0s  Why does the login test fail?
summarize-public-api-src  p81c0d  24m ago  2/3 ok   3 tasks            Summarize the public API in src/.
find-bugs-internal-runs   x7d2e1  Sep 30   stopped  5 tasks            continue: ask continue find-bugs-internal-runs
```

`running` means ask holds the run's operating system lock; its time is elapsed time since the run
started. When an agent reports an activity, the task column shows its latest coarse activity; for
a batch it lists the tasks that reported one. Some agents report no activity. `stopped` means the run
was interrupted before every task finished. Interrupted attempts keep empty result slots. ask saves live reported sessions and the actual
working directory/worktree in private recovery files, including before a final result exists.
A rerun clears the previous attempt’s result and recovery metadata before starting, so recovery
never falls back to an older session in the original task record. Live activity is ignored when
the owner exits. An agent must report its session before interruption for recovery to use it;
sudden termination before the next metadata poll (every 500ms) may require a restart.

## Showing a run again

```sh
ask show login-test-fail           # the latest turn's answer on stdout, its status line on stderr
ask show k3f9a2                    # an earlier turn, by id
ask show login-test-fail --json    # the whole result, with session, changes and worktree
ask show summarize-public-api-src  # a batch: all its results, as a JSON array
ask show summarize-public-api-src/api  # one task of a batch
```

Showing a whole batch prints its outcome count on stderr and exits 1 if any task failed; saved wall time is not recorded.

## Waiting for runs

`ask wait RUN` waits for a specific run, then prints its answer the way `ask show` does.
Without `RUN`, `ask wait` collects the first active run to finish and watches only runs active
when waiting begins. Answers go to stdout and status to stderr.
Start runs in the background, keep working, and collect their answers. Wait
until their started lines appear before calling `ask wait`; shell background jobs may not have
created their run records yet:

```sh
ask --model claude:sonnet-5.5 "Why does the login test fail?" >login.answer 2>login.status &
ask --model codex:gpt-6.1-sol "Review the session code for races." >session.answer 2>session.status &
# Wait for both started lines in the status files before collecting an answer.
ask wait # prints the first active run to finish
ask wait login-test-fail # a specific run
```

The background commands also write their answers to their own files; redirecting them keeps answers
and terminal status displays from interleaving. `ask wait` watches runs active when it starts, not
a completion queue: use `ask show RUN` for a run that already finished. If none is active, it
prints `ask: no runs are running` and exits 0. A stopped run exits 1 with a command to continue it.

## Stopping a run

`ask stop RUN` stops a run going in another terminal or in the background, and every agent it
started. It waits up to 10 seconds for them to exit, and fails if ask is still running then.

```sh
ask stop login-test-fail
```

Use `ask continue RUN` without a prompt to finish a stopped or failed run, or only unfinished
or failed batch tasks. ask announces whether it uses the saved conversation or restarts.

## Cleaning up

Write runs keep their worktree and branch when they changed something, so you can review and
merge it; finished run records stay too. `ask clean` removes what is no longer needed:

```sh
ask clean               # shows the plan, then asks
ask clean --dry-run     # only shows it
ask clean --yes         # for scripts
ask clean --days 7      # runs older than a week (default 30)
```

```text
Worktrees
  remove  ~/.ask/worktrees/add-rate-limiting-login  ask/add-rate-limiting-login · merged into origin/main
  keep    ~/.ask/worktrees/fix-session-race         ask/fix-session-race · not merged into origin/main
Runs
  remove  14 runs older than 30 days
```

A worktree goes once it has no uncommitted changes and every file its branch changed matches the
main branch (origin's default, `main` or `master`), as after a merge or a squash merge, or when it
changed nothing; its branch goes with it. Anything else stays. Run records go when they are older
than `--days`, not running, and hold no worktree that stays.

## Where runs live

Each run is a folder in `~/.ask/runs/` (or `$ASK_HOME/runs/`), named by its start time, id and
name (runs from before names have none):

```text
~/.ask/runs/20261001T140912345-k3f9a2-login-test-fail/
├── tasks.json     prepared tasks, including optional kept_worktree {path, branch} for follow-ups
├── results.json   the results so far, rewritten whole after each task
├── recovery-N.json  live session, effective task and location for an unfinished attempt (when reported)
└── lock           held with an operating system lock while ask runs the run; the kernel names its pid
```

ask creates new run directories with mode 0700 and records with mode 0600. Deleting a finished
run's folder removes its saved answers and ability to continue it. Use
`ask clean` to account for kept worktrees before removing records.

Hosts can name a background run with `ask title --command STRING --description TEXT`; see
[Hosts](hosts.md) for title forms and agent-session naming.
