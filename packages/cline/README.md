# cline

The official ask agent for [Cline CLI](https://github.com/cline/cline/tree/main/apps/cli). It drives
`cline --acp` for ask, so `ask -w -m cline:claude-sonnet-5.5 "..."` hands a task to Cline.

## Install

```sh
ask install cline
```

Requires Cline CLI 3 (`npm install -g cline`), signed in (`cline auth`), and Node.js 18 or newer.
The agent finds Cline even when it is not on ask's `PATH`: in `~/.npm-global/bin`, `~/.local/bin`,
`/opt/homebrew/bin`, `/usr/local/bin` or `~/.bun/bin`.

## How it runs

The agent is a client of Cline's [Agent Client Protocol](https://agentclientprotocol.com) server,
`cline --acp`, the one editors use: it gives the agent the session id, an explicit model and a
clean answer. It sets `CLINE_SESSION_BACKEND_MODE=local`, so the run stays in ask's process group
instead of moving to Cline's background hub, and ask's stop and timeout reach it.

## Models

The agent lists the models Cline offers for the provider you signed in with, as Cline names them
(`anthropic/claude-sonnet-5.5` with the Cline provider); set `ASK_CLINE_PROVIDER` to use another
provider you set up in Cline. A model is found by that id or by the part after its last slash
(`claude-sonnet-5.5`), without regard to case, and set explicitly on every run, follow-ups included,
so Cline's own default never answers instead. A model Cline doesn't offer fails the run.

Cline's ACP server has no reasoning-effort setting, so the agent refuses an effort
(`cline:claude-sonnet-5.5#high`) rather than drop it.

## Read and write

**Read runs are refused.** Nothing in Cline CLI 3 can hold a run read-only:

- plan mode keeps the shell (`run_commands`) and only checks the command's text, which is not a
  boundary;
- the CLI takes no tool rules: it sets tool policies itself, `--hooks-dir` sets a variable nothing
  reads, and `CLINE_COMMAND_PERMISSIONS` is implemented only in the VS Code extension;
- over ACP Cline does ask the client before each tool call, but a plugin's `beforeTool` hook can
  return `autoApprove` and skip that question. Plugins load from `~/.cline/plugins`, the
  repository's `.cline/plugins` and more, and the only way to turn one off is by its path in your
  global settings, so the agent cannot rule them out for a run.

Use another agent for questions.

**Write runs** (`ask -w`) are in act mode and approve every tool call.

## Follow-ups

The session id from `session/new` is reported to ask at once, so `ask continue RUN "prompt"` continues it with
`session/load`; the history Cline replays when loading is not part of the answer. A follow-up's
prompt is passed as is.

## Gaps

Cline's ACP server reports neither usage nor cost and takes no session title, so:

- ask shows no tokens or cost for Cline runs, and a cost limit (`--max-cost`) is never reached;
- `ASK_TITLE` is not applied.

## Environment

| Variable | |
| --- | --- |
| `ASK_CLINE_BIN` | The `cline` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_CLINE_PROVIDER` | The Cline provider to use instead of the one you signed in with (Cline's `CLINE_PROVIDER`). |
| `ASK_NODE` | The Node.js executable to run the agent with. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`,
`ASK_SESSION` and `ASK_REPORT` (see [Agents](../../docs/agents.md)). Cline enforces no schema, so
`ASK_SCHEMA` is ignored; ask still checks JSON answers.

## Testing

```sh
cd packages/cline && node --test
```

The tests drive a fake ACP server in `test/bin/cline`; they need no network or account. To try the
real thing by hand:

```sh
echo "add a .editorconfig" | ASK_MODEL=claude-sonnet-5.5 ASK_ACCESS=write ASK_REPORT=/tmp/r.json \
  ~/.ask/packages/ask/packages/cline/agents/cline
cat /tmp/r.json
```

## Sources

What the agent relies on, checked against Cline's source (`cline/cline`, CLI 3.0.68):

- [CLI reference](https://github.com/cline/cline/blob/main/docs/cli/cli-reference.mdx): flags,
  environment variables, `--json` output.
- [`apps/cli/src/acp/acpAgent.ts`](https://github.com/cline/cline/blob/main/apps/cli/src/acp/acpAgent.ts):
  `session/new`, `session/load`, the `model` and `mode` config options, approvals asked of the
  client.
- [`sdk/packages/agents/src/agent-runtime.ts`](https://github.com/cline/cline/blob/main/sdk/packages/agents/src/agent-runtime.ts):
  a `beforeTool` hook's `policy` overrides the approval check.
- [`sdk/packages/core/src/extensions/tools/presets.ts`](https://github.com/cline/cline/blob/main/sdk/packages/core/src/extensions/tools/presets.ts):
  plan mode keeps `run_commands`.
- [`sdk/packages/core/src/runtime/host/host.ts`](https://github.com/cline/cline/blob/main/sdk/packages/core/src/runtime/host/host.ts):
  `CLINE_SESSION_BACKEND_MODE`, and the detached hub started otherwise.
- [`sdk/packages/shared/src/storage/paths.ts`](https://github.com/cline/cline/blob/main/sdk/packages/shared/src/storage/paths.ts):
  where plugins and hooks are found.
- [ACP schema](https://github.com/agentclientprotocol/agent-client-protocol/tree/main/schema):
  method names and messages.
