# opencode

The official ask agent for [Opencode](https://opencode.ai). It runs
`opencode run` for ask, so `ask --model opencode:deepseek-4.1-flash "..."` hands a task to Opencode.

## Install

```sh
ask install opencode
ask models
```

Requires Opencode v1.1.65 or newer in the v1 series, or v2, with at least one provider connected,
and Node.js 18 or newer. Both use the same bundled `opencode` agent. The adapter checks the chosen
executable with `--version` before listing models or running tasks; unknown, malformed, failed
version probes and older versions fail without starting a task. The v1 minimum is a verified
release that preserves permission key order; earlier schemas can reorder the catch-all deny.

The agent finds Opencode and Node.js even when they are not on ask's `PATH`: Opencode in `~/.opencode/bin`, `~/.local/bin`,
`/opt/homebrew/bin`, `/usr/local/bin` or `~/.bun/bin`; Node.js in Homebrew, `/usr/local/bin`, Volta,
nvm (the newest), fnm or `~/.local/bin`. Without one, `ask models` shows what to install.

Installing the ask package does not install its CLI, Node.js or credentials. `ask models`
checks model listing, not whether a task can authenticate and run.

## Models

The agent lists every model `opencode models` shows, which is every model of the providers you
have set up in Opencode, once each. That can be a hundred or more; turn off the ones you don't
use, in a list you can filter:

```sh
ask settings opencode
ask models opencode:gpt-4o --disable     # or one at a time
```

Name a model like ask's other agents, family-version-variant in lowercase: `deepseek-4.1-flash` for
`deepseek-v4.1-flash`, `qwen-3.8-flash` for `qwen3.8-flash`. The agent finds it in `opencode models`
across all providers. When several providers offer it, the agent takes the one in
`ASK_OPENCODE_PROVIDER`, else `opencode-go`, else `opencode`, else the first alphabetically. A
`provider/model` id is used as it is. Names match without regard to case. An effort
(`opencode:deepseek-4.1-flash#max`) is passed as `--variant max` with `-m provider/model` on v1,
and as `-m provider/model#max` on v2. Available variants depend on the provider and model.

## Read and write

Opencode has no read-only flag, so read runs inject enforceable tool permission rules through
`OPENCODE_CONFIG_CONTENT`. V2 uses `agents.plan.permissions`, an ordered rule array. V1 uses
`agent.<fresh-name>.permission`, an object with a catch-all deny followed by read, grep and glob
allows. Each v1 read run creates a fresh primary agent name so deep-merging a configured `plan`
agent cannot leave tool-specific allows in place. Follow-ups select a fresh restricted agent too.

- **Read runs** may use only the read, grep and glob tools; the shell is denied, so no command
  runs, not even `git log`: rules over a command's text cannot follow everything a shell expands.
  Delegation, MCP/custom tools, edits and other actions are denied by the catch-all rule.
  Git runs Opencode starts itself take no optional locks and no fsmonitor. The prompt starts with
  an instruction to answer from the files in the working directory and never guess. They stop
  after 25 steps.
- **Write runs** (`ask --write`) use the `build` agent with your own Opencode permissions, for up to 100
  steps.

A run that hits its step cap is noted in ask's status line: its answer may be partial. Runs use
`--standalone` on v2, so stopping a run also ends its private server. V1 runs its local
CLI directly and has no `--standalone` flag.

## Follow-ups

The session id of Opencode's first event is reported to ask at once, so `ask continue RUN "prompt"` continues it
with `--session`. A follow-up's prompt is passed as is.

## Usage

The agent rewrites ask's report after every step with the tokens and cost so far, so both show
live. Opencode 2.0 prints no usage for the step that writes the answer, so once Opencode exits the
agent tries to read that step's tokens and cost from `opencode session export --standalone`
and add them. If export fails, usage can be incomplete.
V1 uses `opencode export SESSION`, whose messages wrap assistant metadata and usage in `info`.
Only unfinished messages from the current run are added, so streamed usage and earlier turns are
not counted twice. Exports retry briefly for delayed saves; unavailable usage remains unreported.

## Cost limits

Opencode reports cost after every step, so ask enforces its limit (`--max-cost`, models.json or
the `max_cost` setting) itself: once the reported cost passes it, ask stops Opencode. The run fails
as `stopped at the $2.00 cost limit`, keeps its session, and `ask continue RUN "prompt"` continues it. Cost is
known after each step, so a run can go over the limit by up to one step's cost.

## Environment

| Variable | |
| --- | --- |
| `ASK_OPENCODE_BIN` | The `opencode` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_OPENCODE_PROVIDER` | The provider to prefer when several offer a model. |
| `ASK_NODE` | The Node.js executable to run the agent with. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`, `ASK_TITLE`,
`ASK_SESSION` and `ASK_REPORT` (see [Agents](../../docs/agents.md)).
Opencode enforces no schema, so `ASK_SCHEMA` is ignored; ask still checks JSON answers.

## Testing

```sh
cd packages/opencode && node --test
```

The tests drive a fake `opencode` in `test/bin`; they need no network or account. To try the real
thing by hand:

```sh
echo "say hi" | ASK_MODEL=deepseek-4.1-flash ASK_ACCESS=read ASK_REPORT=/tmp/r.json \
  ~/.ask/packages/ask/packages/opencode/agents/opencode
cat /tmp/r.json
```

## Compatibility sources and limits

The version-specific behavior follows the [v1 CLI](https://opencode.ai/docs/cli/),
[v1 permissions](https://opencode.ai/docs/permissions/), [v1 config](https://opencode.ai/docs/config/)
and [v1 models](https://opencode.ai/docs/models/) docs, checked against the
[v1.1.65 config schema](https://github.com/anomalyco/opencode/blob/v1.1.65/packages/opencode/src/config/config.ts)
and v1.2.9 source for [run flags](https://github.com/anomalyco/opencode/blob/v1.2.9/packages/opencode/src/cli/cmd/run.ts),
[agent permission merging](https://github.com/anomalyco/opencode/blob/v1.2.9/packages/opencode/src/agent/agent.ts),
[permission evaluation](https://github.com/anomalyco/opencode/blob/v1.2.9/packages/opencode/src/permission/next.ts)
and [exports](https://github.com/anomalyco/opencode/blob/v1.2.9/packages/opencode/src/cli/cmd/export.ts).
V2 follows the [CLI](https://opencode.ai/v2/docs/cli),
[commands](https://opencode.ai/v2/docs/cli/commands/), [config](https://opencode.ai/v2/docs/config),
[permissions](https://opencode.ai/v2/docs/permissions) and [models](https://opencode.ai/v2/docs/models) docs.

Tests use fake CLIs, not real providers or model calls. Read-only applies to agent tool permissions;
OpenCode still maintains its own sessions and caches. It is not an operating-system sandbox for
installed plugins or the executable itself. V1 managed administrator configuration has higher
precedence than inline configuration and must not grant permissions that weaken this policy.
