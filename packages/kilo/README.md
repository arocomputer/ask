# kilo

The official ask agent for [Kilo CLI](https://kilo.ai/cli), the terminal agent from Kilo Code. It
runs `kilo run` for ask, so `ask -m kilo:claude-sonnet-5.5 "..."` hands a task to Kilo.

## Install

```sh
ask install kilo
```

Requires Kilo CLI (`npm install -g @kilocode/cli`, `brew install Kilo-Org/tap/kilo` or
`curl -fsSL https://kilo.ai/cli/install | bash`), signed in or with a provider connected, and Node.js
18 or newer. The agent finds Kilo even when it is not on ask's `PATH`: in `~/.kilo/bin`,
`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin` or `~/.bun/bin`.

## Models

The agent lists every model `kilo models` shows, once each. That can be hundreds; turn off the
ones you don't use with `ask settings kilo`.

Name a model like ask's other agents, family-version-variant in lowercase, from the last part of
Kilo's id: `claude-sonnet-5.5` for `kilo/anthropic/claude-sonnet-5.5`, `qwen-3.8-flash` for
`qwen3.8-flash`. When several providers offer it, the agent takes the one in `ASK_KILO_PROVIDER`,
else Kilo's own gateway (`kilo`), else the first alphabetically. A `provider/model` id is used as it
is. An effort (`kilo:claude-sonnet-5.5#high`) is passed as `--variant`.

## Read and write

Kilo has no read-only flag, and its sandbox keeps the workspace writable, so read runs inject
permission rules through `KILO_CONFIG_CONTENT`:

- **Read runs** inject a primary agent with a fresh name every run (`ask-read-<UUID>`) that may
  use only the read, grep and glob tools. Kilo deep-merges agent config, so a fixed name could pick
  up `allow` rules from an agent of the same name in your config; a fresh name has none. Everything
  else is denied: no shell (rules over a command's text cannot follow everything a shell expands),
  no edits, no subagents, no MCP tools (Kilo counts reading an MCP resource as read, so that stays
  allowed). Kilo applies an agent's deny before any approval you saved and before plugin hooks.
  The agent is also made Kilo's `default_agent`, since `kilo run` silently runs the default agent
  when it cannot find the one named by `--agent`. Git runs Kilo starts itself take no optional
  locks and no fsmonitor. The prompt starts with an instruction to answer from the files in the
  working directory and never guess. They stop after 25 steps.
- **Write runs** (`ask -w`) use Kilo's `code` agent with `--auto`: whatever your own Kilo
  permissions don't deny is approved, since nobody is there to answer. They stop after 100 steps.

A run that hits its step cap is noted in ask's status line: its answer may be partial.

Not covered: plugin code you or the repository installed runs inside Kilo, as in any Kilo session,
and can do what any program can; and an organization or MDM-managed Kilo config is applied after
the injected one and can change its rules or `default_agent`.

## Follow-ups

Every event carries Kilo's session id; the agent reports it at once, so `ask continue RUN "prompt"` continues the
session with `--session`. A follow-up's prompt is passed as is.

## Title and usage

`ASK_TITLE` names the session (`--title`). The agent rewrites ask's report after every step with the
tokens and cost so far, so both show live, and ask enforces a cost limit (`--max-cost`) from them:
a run can go over by up to one step's cost.

## Environment

| Variable | |
| --- | --- |
| `ASK_KILO_BIN` | The `kilo` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_KILO_PROVIDER` | The provider to prefer when several offer a model. |
| `ASK_NODE` | The Node.js executable to run the agent with. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`, `ASK_TITLE`,
`ASK_SESSION` and `ASK_REPORT` (see [Agents](../../docs/agents.md)). Kilo enforces no schema, so
`ASK_SCHEMA` is ignored; ask still checks JSON answers.

## Testing

```sh
cd packages/kilo && node --test
```

The tests drive a fake `kilo` in `test/bin`; they need no network or account. To try the real thing
by hand:

```sh
echo "say hi" | ASK_MODEL=claude-sonnet-5.5 ASK_ACCESS=read ASK_REPORT=/tmp/r.json \
  ~/.ask/packages/ask/packages/kilo/agents/kilo
cat /tmp/r.json
```

## Sources

What the agent relies on, checked against Kilo's source (`Kilo-Org/kilocode`, CLI 7.8.3, in
`packages/opencode`):

- [`src/cli/cmd/run.ts`](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/cli/cmd/run.ts):
  `kilo run` flags, `--format json` events, the silent fallback to the default agent, and `--auto`.
- [`src/config/config.ts`](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/config/config.ts):
  `KILO_CONFIG_CONTENT`, agent config deep-merged across sources, and the org and managed configs
  applied after it.
- [`src/agent/agent.ts`](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/agent/agent.ts):
  how an agent's rules are built, and `default_agent`.
- [`src/permission/index.ts`](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/permission/index.ts):
  the last matching rule wins, and an agent's deny comes before saved approvals.
- [`src/kilocode/sandbox/config.ts`](https://github.com/Kilo-Org/kilocode/blob/main/packages/opencode/src/kilocode/sandbox/config.ts):
  the sandbox confines writes to the workspace, it doesn't forbid them.
- [`src/tool/`](https://github.com/Kilo-Org/kilocode/tree/main/packages/opencode/src/tool): tool
  names.
