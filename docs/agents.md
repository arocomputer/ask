# Agents

An agent is a small executable that runs one coding agent's CLI for ask: Claude Code, Codex,
Opencode, or anything else. ask itself knows nothing about any of them. Everything specific to one,
from its flags to how it reports usage, lives in its agent, which is how ask supports any of them.

ask bundles 18 official agents, including Copilot, Gemini CLI, Pi, e, Cursor, Aider, Goose,
Cline, Kilo and more (`ask install NAME`, see [Packages](packages.md#official-agents)); their
source is in [`packages/`](../packages). Your own
go in `~/.ask/agents/`, one executable per coding agent, named for it, and win over an official
one of the same name. An agent named `claude` gives you models `claude:...`.

## The contract

An agent is any executable: a shell script, Node, Python, a binary.

### Listing models: `NAME models`

Print one model per line, as `id` or `id<TAB>name`. The name is what status lines show.

```text
sonnet-5.5	Sonnet 5.5
haiku-4.5	Haiku 4.5
```

Print nothing if the CLI has too many models to list; users add the ones they use to
`~/.ask/models.json` (see [Models](models.md)).

### Naming models

Name each model by what it is, the same way in every agent, so `ask models` reads as one list:

- **Lowercase family, version, then variant, joined by hyphens:** `gpt-6.1-sol`, `sonnet-5.5`,
  `deepseek-4.1-flash`, `qwen-3.8-flash`.
- **No CLI aliases** like `opus` or `latest`. They change meaning when a new model ships, so a
  run's record would no longer say which model answered. Refuse them with the exact name to use.
- **No provider prefixes or vendor quirks** the user doesn't need. Translate in the agent: a
  clean `sonnet-5.5` can become the CLI's `claude-sonnet-5-5`, and `qwen-3.8-flash` a provider's
  `opencode-go/qwen3.8-flash`. Accept the CLI's own id too, as is.
- **Match without regard to case,** so `GPT-6.1-Sol` finds `gpt-6.1-sol`.

ask doesn't enforce this; a model id is whatever your agent accepts. It is the convention for
agents you share. ask does treat ids without regard to case: it lowercases them, so a run, its
record, `models.json` and `ASK_MODEL` all use one spelling.

Harness limitations are explicit exceptions, not inferred backend versions: Amp accepts routing
modes, and Kimi's native `kimi-for-coding` service name does not pin a version. Pi and e require
native `provider/model` IDs to disambiguate providers. Check each agent's page for its naming
rules and configuration prerequisites.

### Running: `NAME`

ask runs the agent with no arguments, in the directory the agent should work in (`--directory`).

| Input | |
| --- | --- |
| stdin | The prompt, complete. ask adds only the JSON instruction for `--json` or `--schema`. |
| `ASK_MODEL` | The model id, without the agent or effort, in lowercase: `sonnet-5.5`. |
| `ASK_EFFORT` | The effort from `#effort`, or empty. |
| `ASK_ACCESS` | `read` or `write`. |
| `ASK_TITLE` | One-line title for the agent's session/thread, e.g. `GPT-6.1 Sol · Fix tests · write`; `--title` or a task's `title` field replaces the prompt text. |
| `ASK_SCHEMA` | Set only with `--schema`: a file holding the JSON Schema, for CLIs that enforce one. |
| `ASK_SESSION` | Set only for a follow-up: the session to continue (see [Sessions](#sessions)). |
| `ASK_REPORT` | A file path for the optional report. |
| `ASK_MAX_COST` | Set only when the task has a cost limit: dollars, like `2` or `0.5`. See [Cost limits](#cost-limits). |

| Output | |
| --- | --- |
| stdout | The answer, and nothing else. |
| exit code | 0 when the answer is good, anything else when the run failed. |
| stderr | On failure, the reason as the last line. ask shows that line. |
| `$ASK_REPORT` | Optional JSON: `{"session", "name", "input", "output", "cached", "cost", "note", "activity"}`. |

In the report, `session` is the agent session the run used, `name` is the model that actually ran
(`Sonnet 5.5`), the counts are tokens, `cost` is in USD, and `note` is a short remark ask adds to
the status line (`hit step cap; answer may be partial`). `cached` is reported cache-read tokens;
whether they are included in `input` depends on the agent. A missing metric is unknown, not zero.
Every field is optional. ask reads the
report even when the run fails or times out, so write it as early as you know something, above all
the session, and rewrite it whole as you learn more. ask also reads it while the agent runs, so
usage you rewrite as it grows shows live in the terminal. Write a temporary file and rename it over
the report, so ask never reads half a file; ask skips a report it can't parse until the next one.

`activity` is an optional string describing the most recently observed work, chosen only from
`thinking`, `running commands`, `editing files`, `searching`, `using tools`, and `answering`.
For example, `{"session":"abc","input":1200,"activity":"editing files"}`. Derive it from
structured event types, never commands, paths, reasoning, messages, tool arguments or output.
An empty string, omission, `null`, unknown string or other JSON type clears the label without
discarding valid usage, cost or session fields. This additive field needs no
contract version change; agents may omit it and older ask versions ignore it.

ask polls reports about twice a second. Activity is transient: it appears in the live stderr row,
or as `ask RUN · activity · CATEGORY` in a pipe or dumb terminal. Plain output suppresses repeats
and emits at most one activity line per task every five seconds (reset for a follow-up round).
Brief changes may be missed or suppressed. Activity is neither an answer nor a heartbeat, and is
not saved in run results. Keep cumulative usage and session when replacing the report; optional
activity must not replace them. Timeouts and reported-cost limits apply as before.

ask handles everything else: timeouts, stopping, batches, recording runs, follow-ups, worktrees,
reporting what changed and checking JSON answers. Official agents apply `ASK_TITLE` when their
harness provides a session-naming CLI or API; agents without one leave native titles unchanged.
Each agent's page documents its support.
It runs each agent in its own process group, so stopping a run also stops the CLI your agent
started. Once the agent exits, ask kills any descendants still in that group so their output
pipes cannot delay completion. Don't detach the CLI from that group.
On Linux, agent processes also receive a parent-death signal, so killing ask outright kills the agent process.

## Sessions

Follow-ups (`ask -c RUN`) continue the agent's own conversation, so they need the CLI's session
id. An agent that supports them:

1. reports the session in `$ASK_REPORT` as `"session"`, as soon as the CLI says what it is;
2. when `ASK_SESSION` is set, resumes that session with the prompt instead of starting a new one.

ask runs a follow-up in the same directory as the run it continues, which most CLIs need to find
the session. An agent that reports no session simply can't be continued; ask says so.

## Cost limits

When a task has a cost limit (`--max-cost`, models.json or the `max_cost` setting), ask passes it
in `ASK_MAX_COST` and watches the cost in your report: once it passes the limit, ask stops the
agent as it does on a timeout and records `stopped at the $2.00 cost limit`. So an agent that
rewrites its report with the cost as it grows gets the limit for free. An agent whose CLI reports
cost only at the end can pass the limit to the CLI, if it has a budget option, and fail with the
same words when the CLI stops; the official Claude Code agent does that. Either way, keep the
session in the report so `ask -c` can continue the work.

## Read-only

ask passes `ASK_ACCESS=read` for read runs and trusts the agent to keep it. How depends on the
CLI:

- **An OS sandbox** is the strongest: the agent may run any command, but nothing can write.
- **Tool rules**: allow only reading and search tools, and deny the shell. Rules that match a
  command's text cannot follow everything a shell expands (substitution, globs, quoting), so an
  allow-list of "safe" commands is not a boundary; the official agents allow none in read runs.
- **Neither**: refuse read runs. Exit 1 with a reason rather than run with write access.

ask sends the prompt exactly as given. A read run is usually a question about the code, so an
agent does well to tell its model to answer from the files: the official agents start a read run
that is not a follow-up with "Answer from the files in your working directory: search and read
them before answering. Never guess file names, functions or facts; if you cannot find something,
say so."

## Example: Claude Code in shell

Create `~/.ask/agents/` first (`mkdir -p ~/.ask/agents`), save this as
`~/.ask/agents/claude`, then make it executable with the command below. This overrides the
official Claude agent if installed. Model ids here are examples; use ids your CLI supports.

The smallest useful agent. It maps ask's model names to Claude Code's (`sonnet-5.5` becomes
`claude-sonnet-5-5`), gives read runs only Claude Code's reading and search tools, and lets write
runs edit and run commands:

```sh
#!/bin/sh
# ~/.ask/agents/claude: runs Claude Code for ask.
if [ "$1" = models ]; then
  printf 'sonnet-5.5\tSonnet 5.5\nhaiku-4.5\tHaiku 4.5\n'
  exit 0
fi

# ask names models sonnet-5.5; Claude Code calls them claude-sonnet-5-5.
set -- -p --model "claude-$(printf '%s' "$ASK_MODEL" | tr . -)"
[ -n "$ASK_EFFORT" ] && set -- "$@" --effort "$ASK_EFFORT"
if [ "$ASK_ACCESS" = write ]; then
  set -- "$@" --permission-mode bypassPermissions
else
  set -- "$@" --permission-mode default --allowedTools Read,Grep,Glob --disallowedTools Edit,Write,NotebookEdit,Bash
fi

exec claude "$@"   # the prompt arrives on stdin
```

```sh
chmod +x ~/.ask/agents/claude
ask models
ask -m claude:sonnet-5.5 "What does this project do?"
ask -m claude:haiku-4.5 -w "Add a .editorconfig with 2-space indents."
```

This minimal agent does not report sessions or usage, so it cannot support `ask -c`.
A read run asked to change something answers that it can't; a write run makes the change.

## Example: Claude Code with sessions and usage

The same agent in Node, using Claude Code's JSON output to report the session, so `ask -c` can
follow up in the same conversation, and the tokens and cost for status lines. Save this at
`~/.ask/agents/claude` and make it executable as above; it needs Node.js 18 or newer. Unlike the
official streaming agent, this example reports its session and usage only after the CLI exits:

```js
#!/usr/bin/env node
// ~/.ask/agents/claude: runs Claude Code for ask, with sessions (for ask -c) and usage.
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync, renameSync } = require('node:fs');

if (process.argv[2] === 'models') {
  console.log('sonnet-5.5\tSonnet 5.5\nhaiku-4.5\tHaiku 4.5');
  process.exit(0);
}
const { ASK_MODEL, ASK_EFFORT, ASK_ACCESS, ASK_SESSION, ASK_REPORT } = process.env;
const args = ['-p', '--output-format', 'json', '--model', `claude-${ASK_MODEL.replaceAll('.', '-')}`];
if (ASK_EFFORT) args.push('--effort', ASK_EFFORT);
if (ASK_SESSION) args.push('--resume', ASK_SESSION);
if (ASK_ACCESS === 'write') args.push('--permission-mode', 'bypassPermissions');
else args.push('--permission-mode', 'default', '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Edit,Write,NotebookEdit,Bash');

let out;
try {
  out = JSON.parse(execFileSync('claude', args, { input: readFileSync(0), encoding: 'utf8' }));
} catch (error) {
  console.error(error.stderr?.trim().split('\n').pop() || error.message);
  process.exit(1);
}
const u = out.usage || {};
writeFileSync(`${ASK_REPORT}.tmp`, JSON.stringify({
  session: out.session_id,
  input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
  output: u.output_tokens,
  cached: u.cache_read_input_tokens,
  cost: out.total_cost_usd,
}));
renameSync(`${ASK_REPORT}.tmp`, ASK_REPORT);
if (out.is_error) {
  console.error(out.result);
  process.exit(1);
}
console.log(out.result);
```

Run inside ask's own repository:

```text
$ ask -m claude:haiku-4.5 "Which file decides how ask formats its status lines? One sentence."
ask file-decides-ask-formats · ok · Haiku 4.5 · 8.5s · 94.7k in · 439 out · $0.08
The file `internal/status/status.go` formats ask's status lines, including event lines, completion
status, and batch summaries.
$ ask -c file-decides-ask-formats "Which function in it formats the usage part, like '31.0k in · 812 out'?"
ask file-decides-ask-formats · ok · Haiku 4.5 · 6.0s · 34.9k in · 362 out · $0.08
The `Usage` function formats token usage and optional cost in the pattern "input in · output out".
```

To show usage live, stream instead: `--output-format stream-json --verbose
--include-partial-messages` prints each model call's usage as it starts (`message_start`) and
finishes (`message_delta`), and the run's cost in the final `result` event. Rewrite the report
with the running sum on each one.

## Other agents

The same shape works for any coding agent with a non-interactive mode. The pieces to map:

| | Codex | Opencode |
| --- | --- | --- |
| Run one prompt from stdin | `codex exec -m MODEL -` | `opencode run -m PROVIDER/MODEL` |
| Read-only | `--sandbox read-only` (an OS sandbox) | an agent with only read tools allowed |
| Write | `--sandbox workspace-write` | `--agent build` |
| Session for `ask -c` | `codex exec resume SESSION -` | `opencode run --session SESSION` |
| Machine-readable output | `--json` | `--format json` |

## Testing an agent

Run it the way ask does:

```sh
echo "say hi" | ASK_MODEL=haiku-4.5 ASK_ACCESS=read ASK_REPORT=/tmp/r.json ~/.ask/agents/claude
cat /tmp/r.json
```

To use an agent on another machine, or to share it, put it in a [package](packages.md).
