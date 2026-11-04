# e

The ask adapter for [arocomputer/e](https://github.com/arocomputer/e), using its
JSONL RPC protocol 2. Node.js 18+ runs the adapter. Upstream public releases are
currently paused: build e from source, authenticate with a provider and explicitly
trust the working directory with `e trust /path/to/project` before using ask.
The adapter never changes trust settings.

## Install and models

```sh
ask install e
ask models e
ask --model e:openai/gpt-5.5 "Explain this project"
ask -w -m e:openai/gpt-5.5#high "Fix the issue"
```

`models` reads `models.list` over RPC and lists unique native `provider/model`
IDs. Pass an exact ID, including nested provider IDs if needed. Unqualified
aliases are rejected; e resolves the supplied ID and validates effort against
that model's catalog. `ASK_EFFORT` is passed as `session.create.effort`; there is
no invented translation of effort levels.

## Enforced access

The process starts as `e rpc --no-extensions` in both modes. Extension processes,
startup hooks, replacement tools and interactive extension questions are disabled.

Read runs use `session.create.tools: ["read", "grep", "read_result"]`.
Upstream checks this list before tool execution, not just when advertising
schemas. The shell, file writes/edits and extension tools cannot execute.
`read_result` reads cached tool output; upstream also permits it implicitly.
The policy is reapplied to a resumed log. New read prompts include a grounding
instruction as well.

RPC accepts unknown parameter fields for compatibility. Before any read prompt,
the adapter sends a create request with a deliberately unknown tool and requires
the documented allowlist error. Servers that silently ignore `tools` are refused;
there is no fallback to unrestricted print mode or prompt-only protection.
A protocol other than 2 is also refused. Use the researched upstream revision or
an equivalent revision with this execution policy.

Write runs omit the allowlist and enable all built-in tools, including shell and
file writes, as the current user. Extensions remain disabled. Neither mode has
an OS sandbox: session logs, cache and configuration metadata can still be
written, and reads are not confined to the workspace.

## Continuation and native titles

`session.create` sets `save: true`. The adapter reports the persisted log **path**,
not the process-local RPC session ID. It queries `session.info` at turn start and
on usage events until the log is available, then also checks the final result.
A timeout before e creates/reports the log may leave no resumable path.
`ASK_SESSION` is passed as `session.create.resume` with persistence enabled,
continuing the saved conversation in place. e locks the log while it is open.

`ASK_TITLE` maps to `session.create.name`, including on continuation. Upstream
trims persisted names and ignores blank names, with no explicit character cap.
This is a native session label shown in `/resume`, not a terminal-window title.
Without a supplied name, e derives a title from the first prompt line, limited
to eight words and 60 characters. There is no separate rename RPC method; create
with a name is the supported surface used here.

## Usage and limitations

Usage events provide live token counts. The final turn result replaces these
with authoritative totals including compaction, whose wire event does not expose
its token usage. Input includes uncached input and all cache reads/writes;
`cached` is cache reads, and output is e's output count.

`cost_usd` is an estimate available only in the final result; unknown pricing is
omitted. e exposes neither a live priced usage stream nor a native turn budget,
so ask cannot interrupt a turn on its cost. With `--max-cost`, ask compares the
final cost and notes an overspend; the completed answer still stands. The limit
is not a live spending cap for this harness.

Errors, aborted turns, premature RPC exits and empty answers fail, preserving any
saved path/usage already reported. Only `final_output` reaches stdout. The server
exits after stdin closes; it remains in ask's process group for cancellation.
There is no adapter step cap, image input or interactive extension UI.
`ASK_SCHEMA` has no native enforcement here: ask supplies instructions and checks
the JSON answer. Headless directory trust remains an upstream prerequisite.

Print mode was researched but is not used: `e -p` rejects `--continue` and
`--resume`, and its CLI exposes only all/no-tools selection. RPC provides both
the execution allowlist and saved-path continuation needed for this adapter.

## Environment and tests

`ASK_E_BIN` selects the executable; otherwise it is found on PATH,
`~/.local/bin`, `/opt/homebrew/bin`, or `/usr/local/bin`. An invalid override does
not fall back. `ASK_NODE` and the launcher follow the other official packages'
Node lookup. Contract inputs include `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`,
`ASK_SESSION`, `ASK_TITLE` and `ASK_REPORT`.

```sh
cd packages/e && node --test
```

The tests use `test/bin/e`, a fake RPC CLI; no network, account or real model.

## Research

Read upstream docs and source before implementation, pinned to
`0b35c22ff459871246f5372bbd562a0b4c53c2d8`:

- [Automation/RPC contract](https://github.com/arocomputer/e/blob/0b35c22ff459871246f5372bbd562a0b4c53c2d8/docs/guides/usage/automation.md).
- [CLI parsing and print continuation restriction](https://github.com/arocomputer/e/blob/0b35c22ff459871246f5372bbd562a0b4c53c2d8/crates/cli/src/args.rs).
- [RPC server, allowlist validation and persisted paths](https://github.com/arocomputer/e/blob/0b35c22ff459871246f5372bbd562a0b4c53c2d8/crates/rpc/src/lib.rs),
  [parameter types](https://github.com/arocomputer/e/blob/0b35c22ff459871246f5372bbd562a0b4c53c2d8/crates/rpc/src/params.rs).
- [Execution-time tool refusal](https://github.com/arocomputer/e/blob/0b35c22ff459871246f5372bbd562a0b4c53c2d8/crates/core/src/agent/mod.rs),
  [final usage and cost](https://github.com/arocomputer/e/blob/0b35c22ff459871246f5372bbd562a0b4c53c2d8/crates/rpc/src/result.rs),
  [native names and derived titles](https://github.com/arocomputer/e/blob/0b35c22ff459871246f5372bbd562a0b4c53c2d8/crates/core/src/session.rs).
