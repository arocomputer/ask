# goose

The official ask agent for [Goose](https://github.com/aaif-goose/goose). It runs `goose run` for
ask, so `ask -w -m goose:anthropic/claude-sonnet-5-5 "..."` hands a task to Goose.

## Install

```sh
ask install goose
```

Requires Goose (`curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash`),
configured with `goose configure`, and Node.js 18 or newer. The agent finds Goose even when it is
not on ask's `PATH`: in `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin`.

## Models

Goose has no command that lists models, so `ask models` shows none for it; add the ones you use
to `~/.ask/models.json` (see [Models](../../docs/models.md)). Name a model as Goose does:

- `provider/model`, like `anthropic/claude-sonnet-5-5`, runs with `--provider` and `--model`;
- a bare model, like `gpt-6.1`, runs with `--model` on the provider set up in Goose.

ask lowercases model ids, so a model whose name in its provider has capitals can't be named. An
effort (`goose:anthropic/claude-sonnet-5-5#high`) is passed as `GOOSE_THINKING_EFFORT`: `off`,
`low`, `medium`, `high` or `max`. Goose ignores any other value without a word, so the agent refuses
it.

## Read and write

**Read runs are refused.** Goose reads file contents only through its developer extension's shell,
the same tool that runs any command; its other tools (`tree`, `analyze`) show structure, not
contents. It has no OS sandbox, and tool permissions live in your own `permission.yaml`, which a
run cannot replace; approve modes stop a headless run. So nothing can keep a Goose run read-only
while still letting it read. Use `-w`, or another agent for questions.

**Write runs** (`ask -w`) set `GOOSE_MODE=auto`, since nobody is there to approve tool calls, and
use your own Goose extensions.

## Follow-ups

A new run names its Goose session from `ASK_TITLE` plus a unique suffix
(`Sonnet 5.5 · Fix tests · write · 3f2a9c1e`) and reports that name to ask at once; `ask continue RUN "prompt"`
resumes it with `--resume --name`. A follow-up's prompt is passed as is.

## Usage

Goose reports tokens and cost only in the event that ends a run, as totals for the whole session
and its subagent sessions. So:

- usage shows when the run ends, not live, and ask cannot stop a run at a cost limit midway;
- a follow-up reports no usage. Those totals include the turns before it, and Goose offers no
  matching count to subtract: `goose session export` shows the session's own counters, without
  its subagents'.

## Environment

| Variable | |
| --- | --- |
| `ASK_GOOSE_BIN` | The `goose` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_NODE` | The Node.js executable to run the agent with. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`, `ASK_TITLE`,
`ASK_SESSION` and `ASK_REPORT` (see [Agents](../../docs/agents.md)). Goose enforces no schema, so
`ASK_SCHEMA` is ignored; ask still checks JSON answers.

## Testing

```sh
cd packages/goose && node --test
```

The tests drive a fake `goose` in `test/bin`; they need no network or account. To try the real
thing by hand:

```sh
echo "add a .editorconfig" | ASK_MODEL=anthropic/claude-sonnet-5-5 ASK_ACCESS=write \
  ASK_REPORT=/tmp/r.json ~/.ask/packages/ask/packages/goose/agents/goose
cat /tmp/r.json
```

## Sources

What the agent relies on, checked against Goose's source (`aaif-goose/goose`, formerly
`block/goose`):

- [`crates/goose-cli/src/cli.rs`](https://github.com/aaif-goose/goose/blob/main/crates/goose-cli/src/cli.rs):
  `goose run` flags (`-i -`, `--name`, `--resume`, `--provider`, `--model`, `--output-format`).
- [`crates/goose-cli/src/session/mod.rs`](https://github.com/aaif-goose/goose/blob/main/crates/goose-cli/src/session/mod.rs):
  `stream-json` events, and approve modes failing a headless run.
- [`crates/goose/src/agents/platform_extensions/developer/mod.rs`](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/agents/platform_extensions/developer/mod.rs):
  the developer tools (`write`, `edit`, `shell`, `tree`, `read_image`); none reads a file's text.
- [`crates/goose/src/config/permission.rs`](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/config/permission.rs):
  tool permissions live in the config directory's `permission.yaml`.
- [`crates/goose/src/config/base.rs`](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/config/base.rs)
  and [`crates/goose-provider-types/src/thinking.rs`](https://github.com/aaif-goose/goose/blob/main/crates/goose-provider-types/src/thinking.rs):
  `GOOSE_THINKING_EFFORT` and its values.
- [`crates/goose/src/session/session_manager.rs`](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/session/session_manager.rs):
  the session totals the final event reports.
