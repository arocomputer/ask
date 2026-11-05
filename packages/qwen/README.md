# qwen

The official ask agent for [Qwen Code](https://github.com/QwenLM/qwen-code). It runs `qwen` headless
for ask, so `ask --model qwen:qwen-3-coder-plus "..."` hands a task to Qwen Code.

## Install

```sh
ask install qwen
```

Requires Qwen Code (`npm install -g @qwen-code/qwen-code`), signed in or with API keys set up, and
Node.js 18 or newer. Without `qwen`, `ask models qwen` fails as well, even when settings list models. The agent finds `qwen` on `PATH`, in `~/.local/bin`, `/opt/homebrew/bin` or
`/usr/local/bin`.

## Models

Qwen Code has no command that lists models, so the agent lists the ids in the `modelProviders`
setting of `~/.qwen/settings.json` (or `$QWEN_HOME/settings.json`), once each. Name one as ask's
other agents do, in lowercase, or by its id in any case: `qwen-3-coder-plus` or `qwen3-coder-plus`.
The agent passes the id exactly as written in settings to `--model`. A clean name that fits several
ids is listed by id, and a name that fits several is refused.

Models Qwen Code offers without `modelProviders` (its built-in OAuth model) are not listed and are
refused. A run also fails if Qwen Code reports another model answering, which its `modelFallbacks`
setting can cause on capacity errors; the answer is not used. Qwen Code has no effort option, so
`#effort` is refused.

## Read and write

**Write only.** `ask -w` runs Qwen Code with `--approval-mode yolo`: every tool is approved, shell
included. Read runs (the default) are refused before `qwen` starts, with a message saying so.

Qwen Code has no way to restrict a run to reading that nothing else can widen. Its `--core-tools`
allowlist is merged with `tools.core` from user, workspace and system settings, and is ignored
under `--bare` and `--safe-mode`; MCP servers and extensions add tools of their own; plan mode lets
read-only shell commands run. A repository could change any of those, so the agent does not
pretend. Use another agent for read-only questions.

## Follow-ups

The session id of Qwen Code's first event is reported to ask at once, so `ask continue RUN "prompt"` continues it
with `--resume`.

## Usage and limits

Tokens (input, output, cached) are reported after every answer and corrected from Qwen Code's
result. Qwen Code reports no cost, so there is none to limit with `--max-cost`. It has no option to
name a session, so `ASK_TITLE` is not applied. `ASK_SCHEMA` is ignored; ask still checks JSON
answers.

## Environment

| Variable | |
| --- | --- |
| `ASK_QWEN_BIN` | The `qwen` executable to run, instead of looking on `PATH` and in the usual places. |
| `QWEN_HOME` | Where Qwen Code keeps `settings.json`; the agent reads the model list from there. |
| `ASK_NODE` | The Node.js executable to run the agent with. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`,
`ASK_SESSION` and `ASK_REPORT` (see [Agents](../../docs/agents.md)).

## Sources

Checked against upstream at v0.25.0 (commit 9cdb0f3):

- [Repository and README](https://github.com/QwenLM/qwen-code)
- [Headless mode](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/headless.md): `stream-json` events, `--resume`, stdin prompt
- [Approval modes](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/approval-mode.md)
- [Model providers](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/model-providers.md): `modelProviders`
- [Settings](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md): `modelFallbacks`, `tools.core`
- Source: [`top-level-options.ts`](https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/config/top-level-options.ts) (flags),
  [`config.ts`](https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/config/config.ts) (core-tools merging, bare and safe mode),
  [`protocol.ts`](https://github.com/QwenLM/qwen-code/blob/main/packages/sdk-typescript/src/types/protocol.ts) (event and usage shapes)

## Testing

```sh
cd packages/qwen && node --test
```

The tests drive a fake `qwen` in `test/bin`; they need no network or account.
