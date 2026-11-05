# gemini

The official ask agent for [Gemini CLI](https://geminicli.com). It runs `gemini` headless for ask,
so `ask --model gemini:gemini-3.5-flash "..."` hands a task to Gemini CLI.

## Install

```sh
ask install gemini
ask models
```

Requires Gemini CLI 0.62 or newer, signed in, and Node.js 18 or newer for the agent (Gemini CLI
itself needs Node.js 20). The agent finds both even when they are not on ask's `PATH`: Gemini CLI
in `/opt/homebrew/bin`, `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin`, `~/.npm-global/bin`,
`~/.local/bin` or `~/.local/share/pnpm`; Node.js in Homebrew, `/usr/local/bin`, Volta, nvm (the
newest), fnm or `~/.local/bin`. Without one, `ask models` shows what to install.

Gemini CLI refuses to run headless in a folder it doesn't trust. Trust the folder in Gemini CLI, or
set `GEMINI_CLI_TRUST_WORKSPACE=true` yourself; the agent doesn't, since trusting a folder loads
its settings, `.env` and MCP servers.

## Models

`gemini models` lists the models Gemini CLI uses by default: `gemini-3.1-pro-preview`,
`gemini-2.5-pro`, `gemini-3.5-flash` and `gemini-3.1-flash-lite`. Name any other by Gemini CLI's
id and add it to `~/.ask/models.json`. Names match without regard to case. Gemini CLI's aliases
(`auto`, `pro`, `flash`, `flash-lite`) are refused with the exact name to use: they change meaning
as new models ship. Gemini CLI may serve a newer model for a flash id; the report names the one
that answered.

Gemini CLI has no option for reasoning effort, so a run with one (`gemini:gemini-2.5-pro#high`)
is refused rather than run without it.

## Read and write

- **Read runs** use plan mode under an admin-tier policy (`--admin-policy`) that denies every tool
  except `read_file`, `read_many_files`, `list_directory`, `glob` and `grep_search`. Denied tools
  are never offered to the model, and admin rules outrank your own policies. Plan mode alone is not
  enough: it still lets the model write `.md` files, start subagents and leave plan mode. No shell
  command runs, not even `git log`: rules over a command's text cannot follow everything a shell
  expands. Git runs Gemini CLI starts itself take no optional locks and no fsmonitor. The prompt
  starts with an instruction to answer from the files in the working directory and never guess.
- **Write runs** (`ask -w`) use yolo mode: the agent edits files and runs commands freely.

Gemini CLI ignores `--admin-policy` when its system policy directory (`/etc/gemini-cli/policies`,
`/Library/Application Support/GeminiCli/policies` on macOS) holds policies, so there read runs are
refused rather than run without the read-only rules; write runs still work.

Gemini CLI enforces no schema, so `ASK_SCHEMA` is ignored; ask still checks JSON answers.

## Follow-ups

Every run starts with its own session id, reported to ask at once and passed as `--session-id`, so
`ask continue RUN "prompt"` resumes it with `--resume`, in the same directory. A follow-up's prompt is passed as is.

## Titles

Gemini CLI has no way to name a session, so `ASK_TITLE` is not used.

## Usage

Gemini CLI reports tokens only when the run ends, so ask shows usage then. Output counts everything
beyond the prompt, thinking included; input includes cache reads. Gemini CLI reports no cost. The
report names the model that did most of the work (`Gemini 3.5 Flash`).

## Live activity

When ask supplies `ASK_EVENTS`, the agent appends visible activity to that absolute, pre-created
private JSONL file. Assistant `message` events (`role: assistant`, string `content`) become
`message` entries, including native deltas. `tool_use` becomes `tool` with `tool_name` and serialized
`parameters`; `tool_result` becomes `tool_result` with string `output`, falling back to
`error.message` when output is absent. Results include the tool name when a matching `tool_id`
was seen. These fields are verified against the native
[stream schema](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts)
and the offline CLI fixture. User messages, lifecycle events, errors outside tool results, usage
and any unknown event or reasoning fields produce no activity. No reasoning is inferred.

Every append is one UTF-8 JSON line, at most 16 KiB including its newline, with `type`, string
`text` and optional string `tool`. Text is inspected up to 64 Ki UTF-16 code units, sanitized for
terminal escapes, controls and bidi overrides, and truncated by encoded JSON size with an ellipsis.
Tool names are limited to 128 UTF-16 code units. Common credential forms are redacted best effort;
this is incomplete, especially for credentials split across chunks. Only activity is sanitized;
the answer and report retain their existing behavior.

The agent never creates or truncates the sink, so retries append. Missing, unwritable, relative,
symlink, non-regular, non-private or differently owned sinks disable activity without changing the
answer, report or exit status. A write failure disables activity for that invocation. Tool-name
correlation keeps at most 1,024 calls, with IDs up to 256 code units; older or untracked results
omit `tool`. Complete final native lines work without a trailing newline; incomplete JSON is ignored.

## Cost limits

Gemini CLI reports no cost and has no budget option, so ask's cost limits don't apply to it. Use
`-t` to bound how long a run may take.

## Environment

| Variable | |
| --- | --- |
| `ASK_GEMINI_BIN` | The `gemini` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_NODE` | The Node.js executable to run the agent with. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`,
`ASK_SESSION`, `ASK_REPORT` and `ASK_EVENTS` (see [Agents](../../docs/agents.md)).

## Testing

```sh
cd packages/gemini && node --test
```

The tests drive a fake `gemini` in `test/bin`; they need no network or account. To try the real
thing by hand:

```sh
echo "say hi" | ASK_MODEL=gemini-3.5-flash ASK_ACCESS=read ASK_REPORT=/tmp/r.json \
  ~/.ask/packages/ask/packages/gemini/agents/gemini
cat /tmp/r.json
```
