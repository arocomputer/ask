# copilot

The official ask agent for [GitHub Copilot CLI](https://github.com/github/copilot-cli). It runs
`copilot` non-interactively for ask, so `ask --model copilot:gpt-5.4 "..."` hands a task to Copilot.

## Install

```sh
ask install copilot
```

Requires Copilot CLI 1.0 or newer, logged in (`copilot login`, or `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`
or `GITHUB_TOKEN`), and Node.js 18 or newer. The agent finds both even when they are not on ask's
`PATH`: Copilot in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`,
`/home/linuxbrew/.linuxbrew/bin` or `~/.npm-global/bin`; Node.js in Homebrew, `/usr/local/bin`,
Volta, nvm (the newest), fnm or `~/.local/bin`. Without one, `ask models` shows what to install.

## Models

Copilot CLI has no command that lists its models, so `copilot models` lists none. Add the ones you
use to `~/.ask/models.json`; `/model` in an interactive `copilot` shows the ids your plan offers.
Name a model by Copilot's id (`gpt-5.4`, `gpt-5.3-codex`, `gemini-3.7-flash`), and a Claude model
either way: `haiku-4.5` runs Copilot's `claude-haiku-4.5`. Names match without regard to case.
`auto`, which lets Copilot pick, is refused: a run's record should say which model answered. An
effort (`copilot:gpt-5.4#high`) is passed as `--reasoning-effort`.

## Read and write

- **Read runs** pass `--available-tools=view,glob,grep,rg`, so the model sees only Copilot's
  file-reading and search tools (`grep` is called `rg` for some models), and deny `shell` and
  `write` outright; deny rules win over any allow rule in your Copilot settings. No shell command
  runs, not even `git log`: rules over a command's text cannot follow everything a shell expands.
  Git runs Copilot starts itself take no optional locks and no fsmonitor. The prompt starts with an
  instruction to answer from the files in the working directory and never guess.
- **Write runs** (`ask -w`) pass `--allow-all-tools --allow-all-urls`: the agent edits files, runs
  commands and fetches URLs without asking. File tools stay limited to the working directory, as
  Copilot does by default.

Copilot enforces no schema, so `ASK_SCHEMA` is ignored; ask still checks JSON answers.

## Follow-ups

Every run starts with its own session id, reported to ask at once and passed as `--session-id`,
so `ask continue RUN "prompt"` resumes it, even after a run that was stopped. A follow-up's prompt is passed as is.

## Titles

`ASK_TITLE` names a new session with `--name`, which `copilot --resume=NAME` and `/resume` find.
Copilot names only new sessions, so a follow-up keeps the name its first run gave it. Copilot
documents no length limit.

## Usage

Copilot prints no token counts while it runs, so ask shows usage once the run ends: the agent
reads it from `--usage-output-file`. That file counts the whole session, so a follow-up subtracts
what the session had used before, from the last `session.shutdown` event in Copilot's session log
(`~/.copilot/session-state/ID/events.jsonl`). Input counts include cache reads. Copilot bills in
AI credits rather than dollars, so no cost is reported. The report names the model that did most of
the work (`GPT-5.4`, `Haiku 4.5`).

## Live activity

When ask supplies `ASK_EVENTS`, the agent appends visible main-agent activity to that absolute,
pre-created private JSONL file. Supported native events and fields are verified against the
[CLI runtime event schema](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts)
and offline fixtures:

- `assistant.message`: string `data.content` becomes `message`. Each `data.toolRequests` entry
  becomes `tool` using `name` and serialized `arguments`.
- `assistant.message_delta`: string `data.deltaContent` becomes `message`; the matching
  `data.messageId` final message snapshot is suppressed in activity only.
- `tool.execution_start`: `data.toolName` and serialized `data.arguments` become `tool`.
  `data.toolCallId` suppresses a duplicate call already emitted from a message request.
- `tool.execution_complete`: string `data.result.detailedContent`, else `data.result.content`,
  else `data.error.message` becomes `tool_result`. A matching call ID supplies the tool name.

Only events actually present on stdout produce activity; CLI versions may omit deltas or tool
execution events. Subagent events (`agentId` or `data.parentToolCallId`), user/lifecycle events,
reasoning and opaque fields, partial tool snapshots, shell-output events and unknown events are
ignored. No reasoning is inferred. Final answers still come from complete main-agent messages.

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
status unchanged. See [Agents](../../docs/agents.md) for the bundled writer safeguards.

Each correlation cache holds at most 1,024 IDs of up to 256 code units: eviction can allow duplicate
snapshots/calls or omit a result's tool name. Complete final native lines work without a trailing
newline; incomplete JSON is ignored.

## Cost limits

Copilot reports no cost, so ask's cost limits (`--max-cost`, models.json or the `max_cost` setting)
don't apply to it. Copilot's own `--max-ai-credits` counts AI credits, not dollars, so the agent
doesn't map one to the other. Use `-t` to bound how long a run may take.

## Environment

| Variable | |
| --- | --- |
| `ASK_COPILOT_BIN` | The `copilot` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_NODE` | The Node.js executable to run the agent with. |
| `COPILOT_HOME` | Copilot's home, for its session logs; `~/.copilot` by default. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`, `ASK_TITLE`,
`ASK_SESSION`, `ASK_REPORT` and `ASK_EVENTS` (see [Agents](../../docs/agents.md)).

## Testing

```sh
cd packages/copilot && node --test
```

The tests drive a fake `copilot` in `test/bin`; they need no network or account. To try the real
thing by hand:

```sh
echo "say hi" | ASK_MODEL=gpt-5.4 ASK_ACCESS=read ASK_REPORT=/tmp/r.json \
  ~/.ask/packages/ask/packages/copilot/agents/copilot
cat /tmp/r.json
```
