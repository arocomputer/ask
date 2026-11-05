# kimi

The official ask agent for [Kimi Code](https://github.com/MoonshotAI/kimi-code) (`kimi`, not the
archived kimi-cli). It runs `kimi -p` for ask, so `ask --model kimi:kimi-for-coding "..."` hands a task
to Kimi Code.

## Install

```sh
ask install kimi
```

Requires Kimi Code, signed in (`kimi login`) or with a provider configured, and Node.js 18 or newer.
The agent finds `kimi` on `PATH`, in `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin`.

## Models

The agent lists the model aliases of `kimi provider list --json`. Each alias in `config.toml` names
one provider and one provider-side model id, so the agent lists the model id (`kimi-for-coding`)
and passes the alias to `-m`. When several aliases share a model id, which may route to different
providers, they are listed and accepted by alias (`a/shared`) only. Names match in any case.
`KIMI_MODEL_*` variables, which can define a model of their own, are removed from Kimi's
environment.

`kimi-for-coding` is the name Kimi's own service gives its current coding model, so which version
answers is Kimi's choice; ask records the name it was asked for. Kimi prints no model in its
output, so the agent cannot check which one answered, and a `[secondary_model]` in `config.toml`
can run write-run sub-agents on another model. `#effort` is refused: `kimi -p` has no effort option.

## Read and write

- **Read runs** start the session with the bundled [`lib/read-agent.md`](lib/read-agent.md)
  (`--agent-file`), which holds Kimi's default system prompt and the tools `Read`, `Grep` and
  `Glob`. Kimi enforces an agent's tool list before running a tool, so a read run has no shell, no
  editor, no web and no sub-agent. The prompt starts with an instruction to answer from the files
  in the working directory and never guess.
- **Write runs** (`ask -w`) use the default agent. Print mode approves tool calls itself, with your
  `deny` permission rules still applying; Kimi does not allow `--yolo` or `--plan` with `-p`.

## Follow-ups

Kimi binds the agent at session creation and refuses `--agent-file` on resume, so a session keeps
its access for good. The session stores the agent's rendered prompt and tool list rather than the
file's path, and the agent file is a stable file in the package anyway, so resuming needs nothing
from the first run. Read sessions are reported as `ask-read:ID`; a read follow-up resumes one, and
a write follow-up of it is refused, so a write run can never loosen it. A read follow-up of a write
session is refused too, since its agent has the write tools. Start a new run for the other kind.

Kimi prints the session id when the run ends, so a run that is stopped or times out cannot be
continued.

## Limits

The prompt is passed as one argument (`--prompt=TEXT`), so prompts over 100 KB are refused. Kimi
prints no usage or cost in print mode, so ask shows none and `--max-cost` cannot apply. It has no
option to name a session, so `ASK_TITLE` is not applied. `ASK_SCHEMA` is ignored; ask still checks
JSON answers.

## Environment

| Variable | |
| --- | --- |
| `ASK_KIMI_BIN` | The `kimi` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_NODE` | The Node.js executable to run the agent with. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`,
`ASK_SESSION` and `ASK_REPORT` (see [Agents](../../docs/agents.md)).

## Sources

Checked against upstream at commit 21406fb:

- [Repository and README](https://github.com/MoonshotAI/kimi-code)
- [`kimi` command](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-command.md): `-p`, `--output-format`, `--session`, `--agent-file`, flag conflicts
- [Config files](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/config-files.md): `[models]` aliases, `[permission]`, `[secondary_model]`
- [Config overrides](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/overrides.md)
- [Agents and sub-agents](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/customization/agents.md): agent file format, `tools`, `${base_prompt}`
- Source: [`prompt-render.ts`](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/src/cli/prompt-render.ts) (stream-json lines, resume hint),
  [`run-v2-print.ts`](https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/src/cli/v2/run-v2-print.ts) (session creation and binding),
  [`profileService.ts`](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core-v2/src/agent/profile/profileService.ts) (binding snapshot restored on resume)

## Testing

```sh
cd packages/kimi && node --test
```

The tests drive a fake `kimi` in `test/bin`; they need no network or account.
