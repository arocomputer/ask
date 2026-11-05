# Extensions

An extension is a folder in `~/.ask/agent/extensions/`, named however you like, with an
`extension.json` saying what its executables are for. It can do any of four things:

| Key | What it adds |
| --- | --- |
| `harness` | An external harness: models named `PREFIX:MODEL` run through its executable |
| `tools` | Tools the model can call in ask's own harness |
| `commands` | Your own `ask NAME` commands |
| `instructions` | A note the model gets about the extension's tools |

```json
{
  "harness": { "prefix": "claude", "command": "claude" },
  "tools": [
    { "name": "search_docs", "description": "Search the team docs", "command": "bin/search", "access": "read",
      "parameters": { "type": "object", "properties": { "q": { "type": "string" } } } }
  ],
  "commands": { "review": "bin/review" },
  "instructions": "NOTES.md"
}
```

Every key is optional, and every path is relative to the folder and must stay inside it. An
unknown key is an error, so a typo never silently does nothing. Nothing runs inside ask: each
piece is a file or an executable you can read. `ask extensions` lists what each one provides,
and a broken manifest is listed with its error and provides nothing.

```sh
ask extensions             # NAME, what it provides, where it came from
ask install claude         # a built-in one
ask install ./my-tools     # a folder: copied in
ask install acme/ask-docs  # a GitHub repository, or any URL git can clone
ask remove my-tools
```

A folder you made yourself in `~/.ask/agent/extensions/` is never replaced by `install`.

## Harnesses

ask runs sessions with its own harness against a model provider. A harness extension hands
them to another coding agent instead: Claude Code, Codex, or anything with a non-interactive
mode. Its `prefix` is how models name it, so `"prefix": "claude"` serves `claude:sonnet-5.5`,
whatever the folder is called.

### The built-in ones

```sh
ask install claude      # claude:sonnet-5.5 runs Claude Code
ask install codex       # codex:gpt-5.5 runs Codex
```

They are built into ask and written to `~/.ask/agent/extensions/NAME/`; ask rewrites that copy
when its own version changes. Each uses the CLI's own login and needs Node.js 18 or newer. Read
sessions use the CLI's own read-only controls: Claude Code gets only its Read, Grep and Glob
tools and no MCP servers or slash commands; Codex runs in its read-only sandbox. Their READMEs
in [extensions/](../extensions/README.md) give the details and limits.

### The contract

`ASK_CONTRACT=4`. ask runs the executable as `COMMAND models` to list models, and as `COMMAND`
for a turn, in the directory the session works in.

`COMMAND models` prints one model per line, as `id` or `id<TAB>name`, or nothing. Models you
declare under the prefix in [models.json](models.md) are listed too.

| Input | |
| --- | --- |
| stdin | The prompt, complete. |
| `ASK_MODEL` | The model id, lowercase, without the prefix or effort. |
| `ASK_EFFORT` | The effort from `#effort`, or empty. |
| `ASK_ACCESS` | `read` or `write`. |
| `ASK_SESSION` | Set on a later turn: the harness's own session to continue. |
| `ASK_SCHEMA` | Set with `--schema`: a file holding the JSON Schema the answer must match. |
| `ASK_TITLE` | A one-line title for the harness's own session or thread. |
| `ASK_MAX_COST` | Set when the turn has a cost limit, in dollars. |
| `ASK_REPORT` | A file path for the optional report. |
| `ASK_EVENTS` | A private JSONL file for visible activity: append complete records as work happens. |
| `ASK_HOME`, `ASK_BIN`, `ASK_CONTRACT` | ask's home, path and contract version. |

| Output | |
| --- | --- |
| stdout | The answer, and nothing else. |
| exit code | 0 when the answer is good, anything else when the turn failed. |
| stderr | On failure, the reason as the last line. |
| `$ASK_REPORT` | Optional JSON: `{"session", "name", "input", "output", "cached", "cost", "note"}`. |

In the report, `session` is the CLI's own session, `name` the model that ran (`Sonnet 5.5`), the
counts are tokens, `cost` is USD. Every field is optional; a missing metric is unknown, not
zero. ask reads the report every half second while the harness runs and once after, so write
it early (above all the session) and replace it atomically as you learn more. When the reported
cost passes `ASK_MAX_COST`, ask stops the harness and records `stopped at the $2.00 cost limit`.

Events are one JSON object per line, at most 16 KiB each: `{"type", "text", "tool"}` with type
`message`, `tool`, `tool_result` or `reasoning`. Emit only what the CLI actually exposes.

A later turn continues the CLI's own conversation: report the session as soon as the CLI says
what it is, and when `ASK_SESSION` is set, resume it with the prompt. A harness that reports no
session cannot take a later turn; ask says so.

ask trusts the harness to keep `ASK_ACCESS=read`. An OS sandbox is strongest; else allow only
the CLI's reading and search tools and deny its shell; else refuse read turns with exit 1. ask
handles the rest: timeouts, stopping, recording, worktrees and what changed. It runs the
harness in its own process group and ends everything in it when the turn stops.

### A small one

```sh
#!/bin/sh
# ~/.ask/agent/extensions/haiku-cli/run: runs Claude Code for ask.
[ "$1" = models ] && { printf 'haiku-4.5\tHaiku 4.5\n'; exit 0; }
set -- -p --model "claude-$(printf '%s' "$ASK_MODEL" | tr . -)"
if [ "$ASK_ACCESS" = write ]; then
  set -- "$@" --permission-mode bypassPermissions
else
  set -- "$@" --allowedTools Read,Grep,Glob --disallowedTools Edit,Write,NotebookEdit,Bash
fi
exec claude "$@"   # the prompt arrives on stdin
```

```json
{ "harness": { "prefix": "cc", "command": "run" } }
```

```sh
chmod +x ~/.ask/agent/extensions/haiku-cli/run
ask -m cc:haiku-4.5 --wait "What does this project do?"
```

It reports no session or usage, so it cannot take a later turn. The built-in one does both;
its source in [extensions/claude](../extensions/claude/) is the full example.

## Tools

A tool is an executable ask's own harness offers the model. It gets the call's arguments as
JSON on stdin, runs in the session's directory, and writes its result on stdout; a nonzero exit
is an error the model sees, with the last line of stderr. It runs at most 120 seconds and never
sees provider credentials (`*_API_KEY`) or ask's own variables.

- `name`: letters, digits, `_` and `-`; not a built-in tool's name (`read`, `list`, `grep`,
  `write`, `edit`, `shell`).
- `description`: what the model reads to decide when to call it. Required.
- `parameters`: a JSON Schema object for the arguments; none means no arguments.
- `access`: `read` offers the tool in every session; anything else, only in write sessions.
  A read tool must not change anything: read-only sessions trust it.

An MCP server becomes tools through a small extension that proxies it; MCP itself is not
part of ask.

## Commands

`commands` maps names to executables: `ask review HEAD~3` runs the `review` executable with
your terminal, its arguments, its signals and its exit status, and with `ASK_BIN` set so it
can call this ask back. Built-in commands win over an extension's of the same name; `ask help`
lists extension commands. Put `--` first to send a prompt that starts with a command's name:
`ask -- review this design`.

## Instructions

`instructions` names a Markdown file the model reads in ask's own harness, after ask's own
system prompt and the project's `AGENTS.md` or `CLAUDE.md`. It is for the extension's tools:
when to use them and how. It is included when one of the extension's tools is offered, or
always for an extension with no tools.
