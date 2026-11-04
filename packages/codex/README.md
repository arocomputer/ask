# codex

The official ask agent for [Codex](https://developers.openai.com/codex).
It runs `codex exec` for ask, so `ask -m codex:gpt-6.1-sol "..."` hands a task to Codex.

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

- **Read runs** use the `read-only` sandbox: Codex may run any command, but nothing can write. The
  prompt starts with an instruction to answer from the files in the working directory and never
  guess.
- **Write runs** (`ask -w`) use `workspace-write` with network access, so installing dependencies
  and running tests work.

A `--schema` is passed as `--output-schema`, converted to the strict form OpenAI's structured
output requires: every object closed and every property required.

## Follow-ups

The thread id Codex announces first is reported to ask at once, so `ask continue RUN "prompt"` runs
`codex exec resume` on it, with the same sandbox. A follow-up's prompt is passed as is.

## Usage

The agent rewrites ask's report as each Codex turn completes, so token counts show live. Codex
reports no cost. The report names the model by Codex's display name.
Codex JSON item events also report coarse activity: thinking, running commands, editing files,
searching, using tools or answering. Only the item type is used; commands, paths, reasoning,
messages and tool input/output never enter activity. Unknown or malformed events are skipped.
The label describes the latest recognized item event, rather than every concurrent operation;
a completed turn clears it. ask samples it on stderr, so brief activity can be missed.

## Cost limits

The agent reports no cost, so ask cannot enforce a cost limit for Codex, regardless of how
you authenticate it. Use `-t` to bound how long a run may take.

## Environment

| Variable | |
| --- | --- |
| `ASK_CODEX_BIN` | The `codex` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_NODE` | The Node.js executable to run the agent with. |
| `CODEX_HOME` | Codex's home, for its model cache; `~/.codex` by default. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`, `ASK_TITLE`,
`ASK_SCHEMA`, `ASK_SESSION` and `ASK_REPORT` (see [Agents](../../docs/agents.md)).

## Testing

```sh
cd packages/codex && node --test
```

The tests drive a fake `codex` in `test/bin`; they need no network or account. To try the real
thing by hand:

```sh
echo "say hi" | ASK_MODEL=gpt-6.1-sol ASK_ACCESS=read ASK_REPORT=/tmp/r.json \
  ~/.ask/packages/ask/packages/codex/agents/codex
cat /tmp/r.json
```
