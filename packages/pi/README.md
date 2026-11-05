# pi

The ask adapter for [Pi](https://pi.dev). Runs one JSON-mode turn with Node.js
built-ins only. The shell launcher requires Node.js 18+; the initially researched Pi 1.0.4
CLI itself requires Node.js 22.19+. Authenticate in Pi before using the adapter.

## Install and models

```sh
ask install pi
```

Pi has no machine-readable model catalog command, so `pi models` through this
adapter prints nothing. Add the exact `provider/model` IDs you use to ask's
`~/.ask/models.json`; consult upstream `pi --list-models` for available IDs.

```sh
ask --model pi:anthropic/claude-sonnet-4-5 "Explain this project"
ask -w -m pi:anthropic/claude-sonnet-4-5#high "Fix the issue"
```

The provider and model ID are passed separately through `--provider` and `--model`.
Nested IDs such as `openrouter/anthropic/claude-sonnet-4.5` work. Supply an exact
ID: Pi's own model resolver also accepts fuzzy queries, which this adapter does
not expand or independently validate. Unqualified names and wildcard patterns
are rejected. `ASK_EFFORT` maps to `--thinking`: `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, or `max`; the selected Pi version/model decides which it supports.
Thinking suffixes in the model ID are rejected; use ask's `#effort` instead.

## Access

Read runs explicitly allow only `read,grep,find,ls`. Shell, edits, writes and
other tools are unavailable. This policy is reapplied on continuation.
`--no-mcp` also prevents native server connections and MCP tools (the tool list
alone keeps MCP tools in Pi 1.5.0). Extensions, skills, prompt templates and themes
are disabled by default. Both modes set `PI_OFFLINE=1` to avoid startup package
downloads. Installed help must confirm required controls before a task starts.
Configured extension/package sources cause a refusal before they can be disabled:
they may contain policy hooks. See [Agent environments](../../docs/environment.md)
for inheritance defaults, skill/MCP/plugin opt-in, policy-hook preservation and
unsupported combinations. MCP and plugins cannot be enabled for read runs.

Write runs enable `read,grep,find,ls,bash,edit,write`; they have unrestricted shell
access as the current user. There is no OS sandbox in either mode. Read-only is
a model tool boundary, not a filesystem sandbox: Pi still persists its session,
may migrate its global configuration,
and may cache/download search binaries. Read runs refuse a legacy `.pi/commands`
directory that Pi would rename to `.pi/prompts` at startup. Context files such as `AGENTS.md` remain
available. New read prompts also ask the model to ground its answer in files;
the actual restriction comes from the tool list and disabled extensions/MCP.

## Sessions, titles and usage

The JSON session header's ID is reported immediately. `ASK_SESSION` continues it
with `--session`, using Pi's session lookup. Pi stores the conversation in its own
session directory. `ASK_TITLE` maps to native `--name` on new and resumed sessions.
The researched CLI trims the name and rejects an empty value; it imposes no
explicit character cap. This is a session display label, not a terminal-window
title. Older Pi versions without `--name` are unsupported when a title is supplied.

Each completed assistant message adds usage once. Streaming usage updates report
the current message plus earlier messages; compaction usage is added when Pi
exposes `compaction_end.result.usage`. Input includes cache reads and writes,
`cached` counts cache reads, and output already includes reasoning tokens.
Cost uses Pi's estimate. Ask can stop at its cost limit after a report update,
so billing can exceed the limit before the next update. Missing usage stays absent.

Only the last completed assistant text reaches stdout. JSON-mode errors and
aborts fail even if Pi exits zero; a tool-only or empty turn fails. An answer cut
off at the output-token limit is marked partial. `ASK_SCHEMA` is not enforced
natively; ask supplies the JSON instruction and validates the answer. There is
no adapter step cap, image input, interactive extension UI or model alias mapping.

## Live activity

When ask supplies `ASK_EVENTS`, the agent appends native visible activity to its private JSONL
file, separately from the final answer on stdout.

Completed visible text blocks produce `message`; tool execution starts and ends produce
`tool` and `tool_result`. Thinking, signatures, images and argument deltas are omitted.

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

## Environment and tests

Ask applies the defaults in `agents/pi.environment.json` and user overrides from
`$ASK_HOME/environment.json` before launching this adapter. Auth/config directories
and supported provider variables remain available; arbitrary parent variables do not.
`ASK_ENVIRONMENT` carries the effective integration booleans. Direct launcher use
outside Ask also checks integration controls, but does not filter inherited variables.

`ASK_PI_BIN` selects the CLI executable; otherwise it is found on PATH,
`~/.local/bin`, `/opt/homebrew/bin`, or `/usr/local/bin`. `ASK_NODE` selects the
launcher's Node runtime; the launcher also searches the existing official
packages' Node installation locations. An invalid explicit CLI override fails
without falling back. Standard ask inputs are `ASK_MODEL`, `ASK_EFFORT`,
`ASK_ACCESS`, `ASK_SESSION`, `ASK_TITLE`, `ASK_REPORT` and `ASK_EVENTS`.

```sh
cd packages/pi && node --test
```

Tests drive `test/bin/pi`, with no network or real model calls.

## Research

Environment controls were also checked against locally installed Pi 1.5.0
`--help` and resource/auth loading source. The help probe uses a disposable config
directory during research; tests use only the fake CLI. No auth commands or model
requests are needed.

Originally implemented after reading upstream at commit
`ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba` (Pi package version 1.0.4):

- [CLI flags and name normalization](https://github.com/earendil-works/pi/blob/ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba/packages/coding-agent/src/cli/args.ts).
- [Print/JSON mode and session header](https://github.com/earendil-works/pi/blob/ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba/packages/coding-agent/src/modes/print-mode.ts).
- [JSON event shapes](https://github.com/earendil-works/pi/blob/ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba/packages/coding-agent/src/modes/json-event.ts),
  [tool selection](https://github.com/earendil-works/pi/blob/ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba/packages/coding-agent/src/core/sdk.ts),
  [extension discovery](https://github.com/earendil-works/pi/blob/ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba/packages/coding-agent/src/core/resource-loader.ts).
- [Package startup/offline behavior](https://github.com/earendil-works/pi/blob/ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba/packages/coding-agent/src/core/package-manager.ts),
  [usage categories](https://github.com/earendil-works/pi/blob/ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba/packages/ai/src/types.ts).
