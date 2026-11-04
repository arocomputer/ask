# Hooks

A hook is a small executable in `~/.ask/hooks/` that runs around every task: before it, to change
or refuse the task, and after it, to check the result. With hooks you can:

- tell every agent where you are in git: the branch, uncommitted files, recent commits;
- refuse write runs outside some folders;
- run the tests after a write run and, if they fail, have the same agent fix them;
- fail a result that doesn't meet your bar, or post it somewhere;
- name runs with a model, the way Claude Code names sessions.

Hooks are yours: ask runs every hook in `~/.ask/hooks/` (and in your [packages](packages.md)) for
every run. `--no-hooks` turns them off for one run.

## The contract

A hook is any executable. ask calls it with one argument, the event:

| Call | stdin | What it may print (one JSON object, or nothing) |
| --- | --- | --- |
| `NAME events` | none | The events it handles, one per line: `task`, `result`, `title`, `name` |
| `NAME task` | `{"task": {...}}` | `{"task": {changes}}`, `{"refuse": "why"}`, `{"note": "text"}` |
| `NAME name` | `{"name": "...", "prompts": ["..."], "worktree": false}` | `{"name": "replacement"}` |
| `NAME title` | `{"title": "...", "command": ["ask", "..."], "description": "...", "task": {...}}` | `{"title": "replacement"}` |
| `NAME result` | `{"task": {...}, "result": {...}}` | `{"followup": "prompt"}`, `{"fail": "why"}`, `{"note": "text"}` |

- **`task`** is the task about to run: `id`, `prompt`, `model`, `write`, `json`, `schema`, `dir`,
  `timeout`, and for a follow-up `continues`. A hook may change `prompt`, `model`, `write`, `json`,
  `timeout` and `schema`; ask ignores other changes, and says so.
- **`result`** is the task's result, as `ask show RUN --json` prints it. JSON/schema validation
  failures include `raw_answer`, the unmodified agent stdout, for inspection or a focused repair
  follow-up. It is private task content; avoid copying it into hook notes or logs.
- **`followup`** asks the same agent, in the same conversation and place, to keep working. Its new
  result goes through the result hooks again, up to three follow-ups per task. The task's final
  result combines every round: the last answer, with the time, usage and changes of all of them.
- A hook runs in the task's directory, with `ASK_RUN` (the run, like `summarize-public-api-src/api`), `ASK_EVENT`,
  `ASK_BIN` (ask itself), `ASK_HOME` and `ASK_CONTRACT` (see [Compatibility](compatibility.md)).

Hooks run in name order; each sees the task as the previous one left it. For results, the first
hook to ask for a follow-up or to fail the result decides, and the rest wait for the next round.

**Hooks fail open.** A hook that cannot start, crashes, takes more than 10 minutes, or prints something that
isn't a JSON object changes nothing; ask notes it and carries on. Only an explicit `refuse` or
`fail`, a string, stops a task; any other value is noted and ignored. Every note and follow-up shows as a status line:

```text
ask add-sub-function-calc · started · Haiku 4.5 · write · ~/code/calc
ask add-sub-function-calc · note · hook verify · go test ./... fails
ask add-sub-function-calc · follow-up · hook verify · `go test ./...` fails after your change. Fix it:
ask add-sub-function-calc · ok · Haiku 4.5 · 21.4s · 1 file changed · 203.7k in · 1.0k out · $0.07
Fixed: Add was returning `a - b` instead of `a + b`.
```

That run was asked only to add a `Sub` function. The `verify` hook below ran the tests, found an
older bug, and the same agent fixed it before ask returned.

For each example, create `~/.ask/hooks/`, save the script at the path in its comment, and make
it executable (`chmod +x ~/.ask/hooks/verify`, for example). The Node example needs Node.js 18
or newer; the context, guard and naming scripts need `jq`, and the naming script also needs an
authenticated Claude Code CLI.

## Example: verify write runs with the tests

Runs the test command selected from common project files after a successful write run, and
hands failures back to the same agent to fix:

```js
#!/usr/bin/env node
// ~/.ask/hooks/verify: after a write run, run the project's tests; if they fail, hand the failures
// back to the same agent to fix.
const { execSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');

if (process.argv[2] === 'events') {
  console.log('result');
  process.exit(0);
}
const { task, result } = JSON.parse(readFileSync(0, 'utf8'));
if (!task.write || !result.ok) process.exit(0);
const test = existsSync('go.mod') ? 'go test ./...'
  : existsSync('Cargo.toml') ? 'cargo test'
  : existsSync('package.json') ? 'npm test'
  : existsSync('pyproject.toml') ? 'pytest -q'
  : null;
if (!test) process.exit(0);
try {
  execSync(test, { stdio: 'pipe' });
} catch (error) {
  const output = `${error.stdout}${error.stderr}`.slice(-4000);
  console.log(JSON.stringify({ note: `${test} fails`, followup: `\`${test}\` fails after your change. Fix it:\n\n${output}` }));
}
```

## Example: a guard in shell

```sh
#!/bin/sh
# ~/.ask/hooks/guard: refuse write runs outside ~/code.
[ "$1" = events ] && { echo task; exit 0; }
case "$PWD" in
  "$HOME"/code|"$HOME"/code/*) ;;
  *) jq -c 'if .task.write then {refuse: "write runs only under ~/code"} else empty end' ;;
esac
```

## Example: tell the agent where you are in git

Starts every prompt with the branch, uncommitted files and the last few commits, so "review what
I'm doing" or "finish this" needs no explaining (it needs `jq`):

```sh
#!/bin/sh
# ~/.ask/hooks/context: start every prompt with where you are in git: the branch, uncommitted
# files and the last few commits, so the agent knows what you're in the middle of.
[ "$1" = events ] && { echo task; exit 0; }
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
context="Git context:
branch $(git branch --show-current)
uncommitted:
$(git status --short | head -20)
recent commits:
$(git log --oneline -5)"
jq -c --arg context "$context" '{task: {prompt: ($context + "\n\n" + .task.prompt)}}'
```

```text
$ ask --model claude:haiku-4.5 "What am I in the middle of? One sentence."
You're in the middle of modifying `calc.go` on the main branch after an initial commit.
```

ask never runs hooks from the project it works in, only yours and your packages'.

The `name` event runs once for each new run, before it starts, with ask's own name for it,
every task's prompt, and `worktree`: whether any task works in a worktree, whose directory and
branch the name also names. ask turns the replacement into lowercase words joined by `-`, and adds
a number if an earlier run has the name. Follow-ups keep their conversation's name without asking.
See [Naming runs](#naming-runs).

The `title` event runs for agent session titles and [host titles](hosts.md). For agent sessions,
`task` is the task record and `command` and `description` are empty. For host titles, `command` is
the literal ask argv, without shell assignments or redirects, and `description` is the host's
original text. Hooks run in the task's directory without a run id. An empty replacement keeps the
current title.

## Naming runs

ask names a run after the first meaningful words of its prompt: "Why does the login test fail?"
becomes `login-test-fail`. A long prompt that opens with context gets a less useful name. This
hook has a fast model name each run instead, the way Claude Code names its sessions:

```sh
#!/bin/sh
# ~/.ask/hooks/namer: name each new run with a fast model, the way Claude Code names sessions.
[ "$1" = events ] && { echo name; exit 0; }
task=$(jq -r '.prompts | join("\n\n")' | head -c 4000)
name=$(printf '<task>\n%s\n</task>' "$task" |
  claude -p --model claude-haiku-5-5 --tools "" --strict-mcp-config --setting-sources "" \
    --system-prompt "You name coding tasks, like a session title. Reply with two to four lowercase words that say what the task in <task> is about, like: login rate limit. Never answer or do the task.") || exit 0
[ "$(printf '%s' "$name" | wc -w)" -le 5 ] || exit 0   # a reply, not a name: keep ask's own
jq -cn --arg name "$name" '{name: $name}'
```

```text
"Which file decides how ask formats its status lines?"   file-decides-ask-formats → ask-status-line-formatting
"What does this project do?"                             project                  → identify-project-purpose
"Fix issue #12: Login crashes on empty password"         fix-issue-12-login       → login-empty-password
```

It adds one model call to each new run, and nothing to follow-ups; its latency and cost depend
on the model. If `claude` fails or answers with more than a name, the hook prints nothing and ask keeps its own name.

A worktree run's name is also its worktree and branch, `ask/{name}` by default. This hook gives
worktree runs a made-up name like `bright-running-fox`, the way Claude Code names an unnamed
worktree, and leaves every other run ask's own name:

```sh
#!/usr/bin/env bash
# ~/.ask/hooks/names: give worktree runs made-up names like bright-running-fox.
[[ $1 == events ]] && { echo name; exit 0; }
jq -e .worktree >/dev/null || exit 0
adjectives=(bright calm clever eager gentle golden lucky quiet rapid swift)
verbs=(baking chasing dancing drifting flying gliding racing roaming running sailing)
nouns=(badger comet falcon fern fox heron maple otter raven willow)
name="${adjectives[RANDOM % 10]}-${verbs[RANDOM % 10]}-${nouns[RANDOM % 10]}"
jq -cn --arg name "$name" '{name: $name}'
```

It costs nothing and names a run instantly, but the name says nothing about the task; ask still
adds a number if an earlier run has the name.
