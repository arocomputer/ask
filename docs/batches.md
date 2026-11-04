# Batches

`ask batch` runs many tasks in parallel, on one model or several, and prints all the answers as one
JSON array.

```sh
ask batch [-j N] [--model MODEL] [--write] [--worktree] FILE
ask batch [-j N] [--model MODEL] [--write] [--worktree] -        # tasks on stdin
```

Choose model ids from `ask models`; the ids and run names below illustrate one installation.
Use the names or ids printed by your own runs for `ask show`, `ask continue` and `ask wait`.

## Tasks

A batch is a JSON array, or one JSON object per line. Save this example as `tasks.json`:

```json
[
  { "id": "api", "prompt": "Summarize the public API in src/." },
  { "id": "tests", "prompt": "Which tests look prone to flakiness from their code, and why?", "model": "codex:gpt-6.1-sol" },
  { "id": "fix", "prompt": "Fix the typo in README.md.", "write": true }
]
```

| Field | Meaning |
| --- | --- |
| `prompt` | The task. Required. |
| `id` | A name for the result. Default: the task's position, from 1. |
| `model` | `agent:id[#effort]` or a configured [model role](models.md#model-roles). Required unless the batch's `--model`, a follow-up or the `model` [setting](settings.md) gives one. |
| `write` | `true` for read and write. Default: the batch's `--read`/`--write`, then the followed-up task's access, else read only. With the batch's `--read`, `true` is refused. |
| `worktree` | `true` to work in its own git worktree and branch (creating one needs write). Default: the batch's `--worktree`. |
| `continue` | A run to follow up, like `"login-test-fail"` or `"summarize-public-api-src/api"` (see [Runs](runs.md#follow-ups)). |
| `dir` | Directory the agent works in. For new tasks: this field, then the batch's `--directory`, else the current directory. A follow-up always uses its previous directory or worktree, ignoring `dir` and `--directory`. |
| `json`, `schema` | Like `--json` and `--schema`; `schema` is the schema itself, not a file. |
| `timeout` | Seconds for this task. Default: the batch's `--timeout`, then your `timeout` setting, else 900. |
| `title` | Text used in the agent session title. Default: the prompt. |
| `max_cost` | Dollars this task may spend; 0 for no limit. Default: the batch's `--max-cost`, then a positive recorded limit from the followed-up task, then its model's limit or your setting (see [Usage](usage.md#cost-limits)). |

Options given to `ask batch` are defaults, including `--title`; a task's own fields win, except
that a task cannot widen an explicit `--read` to write, and a follow-up's directory stays fixed.
Omitting `write` on a follow-up can retain write access; use `--read` or `"write": false` to request read-only
access. A prior unlimited run has no positive recorded cost limit to inherit, so model or
settings limits apply unless you explicitly give `max_cost` again.

## Running

```sh
ask batch -j 4 --model claude:haiku-4.5 tasks.json
```

`-j` is how many tasks run at once (default 4, or the `jobs` [setting](settings.md)). In a terminal, stderr shows live task rows (queued, running with elapsed time and usage so far,
ok or failed) above a running total of usage and cost, then a summary. The total labels reported usage and leaves out cost when any task did not report it. In pipes, status lines go to stderr as tasks start and end:

```text
ask summarize-public-api-src · started · batch of 3 · 3 at a time
ask summarize-public-api-src/api · started · Haiku 4.5 · read · ~/code/app
ask summarize-public-api-src/tests · started · GPT-6.1 Sol · read · ~/code/app
ask summarize-public-api-src/fix · started · Haiku 4.5 · write · ~/code/app
ask summarize-public-api-src/api · ok · Haiku 4.5 · 18.1s · 22.4k in · 640 out · 18.0k cache read · $0.07
ask summarize-public-api-src/fix · ok · Haiku 4.5 · 25.3s · 1 file changed · 30.2k in · 410 out · $0.03
ask summarize-public-api-src/tests · failed · GPT-6.1 Sol · 15:00 · 12.0k in · 240 out · timed out
ask summarize-public-api-src · 2/3 ok · 15:00 · reported: 64.6k in · 1.3k out
```

## Results

stdout gets one JSON array, in task order, whatever order the tasks finished in:

```json
[
  {
    "run": "summarize-public-api-src/api",
    "id": "api",
    "model": "claude:haiku-4.5",
    "write": false,
    "name": "Haiku 4.5",
    "ok": true,
    "answer": "The public API is...",
    "seconds": 18.1,
    "usage": { "input": 22400, "output": 640, "cached": 18000, "cost": 0.071 },
    "session": "5f0c...",
    "dir": "/home/me/code/app"
  },
  {
    "run": "summarize-public-api-src/tests",
    "id": "tests",
    "model": "codex:gpt-6.1-sol",
    "write": false,
    "name": "GPT-6.1 Sol",
    "ok": false,
    "error": "timed out",
    "seconds": 900,
    "usage": { "input": 12000, "output": 240 },
    "session": "a21e...",
    "dir": "/home/me/code/app"
  },
  {
    "run": "summarize-public-api-src/fix",
    "id": "fix",
    "model": "claude:haiku-4.5",
    "write": true,
    "name": "Haiku 4.5",
    "ok": true,
    "answer": "Fixed the typo in README.md.",
    "seconds": 25.3,
    "usage": { "input": 30200, "output": 410, "cost": 0.03 },
    "session": "e19b...",
    "dir": "/home/me/code/app",
    "changes": [{ "path": "README.md", "change": "modified" }],
    "commits": 0
  }
]
```

Write tasks in a git repository also have `changes` and `commits`, and worktree tasks that changed
something have `worktree: {path, branch}`. The batch exits 1 if any task failed. Result records include the effective `model` and `write` access after task hooks, so follow-ups inherit what actually ran. With `jq`:

```sh
ask batch --model claude:haiku-4.5 tasks.json | jq -r '.[] | select(.ok) | "\(.id): \(.answer)"'
```

An answer rejected by JSON/schema validation has `ok: false`, `error` and `raw_answer` (the
original agent stdout as a string), with no `answer`. The field is also saved and available to
result hooks for recovery; it does not appear in status lines. Batch JSON can therefore include
unvalidated private content. Successful results and other failures omit `raw_answer`.

## Patterns

**The same question to several models:**

```sh
for m in claude:sonnet-5.5 codex:gpt-6.1-sol opencode:deepseek-4.1-flash; do
  echo "{\"id\": \"$m\", \"model\": \"$m\", \"prompt\": \"Is there a race in src/queue.js?\"}"
done | ask batch -
```

**Parallel fixes that can't collide:** give each task its own worktree, then review each branch.

```sh
gh issue list --label bug --limit 5 --json number,title,body |
  jq -c '.[] | {id: "issue-\(.number)", prompt: "Fix issue #\(.number): \(.title)\n\n\(.body)"}' |
  ask batch --write --worktree --model claude:sonnet-5.5 -
```

Each issue becomes a task with its own branch (`ask/RUN-1-issue-12`, where RUN is the batch's
name, and characters git refuses in branch names, dots included, become `_`), so you review and
merge them one by one.

**Follow up on every task of a batch:**

```sh
ask show summarize-public-api-src | jq -c '.[] | select(.ok) | {continue: .run, prompt: "Now write a test for that."}' | ask batch --write -
```

## Resuming

A batch that was stopped, or had failures, can be continued without a prompt. Only unfinished
or failed tasks run again from the beginning, exactly as recorded; successful results stay.
ask announces the rerun on stderr and prints the result array on stdout:

```sh
ask continue summarize-public-api-src
```

`ask batch --resume RUN` remains a supported script alias; batch reruns take only `-j` and
`--no-hooks`. To follow up in one task's saved conversation, use
`ask continue RUN/TASK "prompt"`; it inherits that task's model and access.
Only one ask can run a batch at a time; a second is refused while the first is going.
Use `ask wait RUN` to wait for that batch. See [Runs](runs.md) for listing, showing and stopping runs.
