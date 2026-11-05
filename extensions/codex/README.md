# codex

The official ask agent for [Codex](https://developers.openai.com/codex).
It runs `codex exec` for ask, so `ask --model codex:gpt-6.1-sol "..."` hands a task to Codex.

## Install

```sh
ask install codex
ask models
```

Requires Codex, logged in, and Node.js 18 or newer. The agent finds both even when they are not on
ask's `PATH`: Codex in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`,
`/home/linuxbrew/.linuxbrew/bin` or the Codex app; Node.js in Homebrew, `/usr/local/bin`, Volta,
nvm (the newest), fnm or `~/.local/bin`. Without one, `ask models` shows what to install.

Installing the ask package does not install its CLI, Node.js or credentials. `ask models`
checks model listing, not whether a task can authenticate and run.

## Models

`ask models` includes the models in Codex's own model cache (`~/.codex/models_cache.json`, or under
`$CODEX_HOME`), without review or reserved models, with Codex's display names (`gpt-6.1-sol` shows as GPT-6.1 Sol). Run
Codex once to fill the cache. Ids are Codex's own and match without regard to case. An effort
(`codex:gpt-6.1-sol#high`) is passed as `model_reasoning_effort`.

## Read and write

Both run in Codex's OS sandbox, never asking for approval:

- **Read sessions** use the `read-only` sandbox for model commands. The
  prompt starts with an instruction to answer from the files in the working directory and never
  guess.
- **Write sessions** (`ask -w`) use `workspace-write` with network access, so installing dependencies
  and running tests work.

The sandbox governs model commands. Codex still writes its own sessions and caches, and loads
its MCP servers, plugins, skills and hooks as you configured them.

A `--schema` is passed as `--output-schema`, converted to the strict form OpenAI's structured
output requires: every object closed and every property required.

## Follow-ups

The thread id Codex announces first is reported to ask at once, so `ask continue RUN "prompt"` runs
`codex exec resume` on it, with the same sandbox. A later turn's prompt is passed as is.

## Usage

The agent rewrites ask's report as each Codex turn completes, so token counts show live. Codex
reports no cost. The report names the model by Codex's display name.
Codex JSON item events also report coarse activity: thinking, running commands, editing files,
searching, using tools or answering. Only the item type is used; commands, paths, reasoning,
messages and tool input/output never enter the coarse report activity. Unknown or malformed
events are skipped.
The label describes the latest recognized item event, rather than every concurrent operation;
a completed turn clears it. ask samples it on stderr, so brief activity can be missed.

## Live activity

When ask supplies `ASK_EVENTS`, the agent appends native visible activity to its private JSONL
file, separately from the final answer on stdout.

Native item snapshots produce new visible text suffixes as `message` and exposed reasoning
summaries as `reasoning`; tool lifecycle items produce `tool` and `tool_result`. Raw reasoning
fields are omitted. This transcript is separate from the coarse report activity above.

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

The agent reports no cost, so ask cannot enforce a cost limit for Codex, regardless of how
you authenticate it. Use `-t` to bound how long a turn may take.

## Environment

| Variable | |
| --- | --- |
| `ASK_CODEX_BIN` | The `codex` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_NODE` | The Node.js executable to run the agent with. |
| `CODEX_HOME` | Codex's home, for its model cache; `~/.codex` by default. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`, `ASK_TITLE`,
`ASK_SCHEMA`, `ASK_SESSION`, `ASK_REPORT` and `ASK_EVENTS` (see [Extensions](../../docs/extensions.md)).

## Testing

```sh
./x baymax codex
```

The tests drive a fake `codex` in `test/bin`; they need no network or account. To try the real
thing by hand:

```sh
echo "say hi" | ASK_MODEL=gpt-6.1-sol ASK_ACCESS=read ASK_REPORT=/tmp/r.json \
  ~/.ask/agent/extensions/codex/codex
cat /tmp/r.json
```
