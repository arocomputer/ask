# cursor

The official ask agent for [Cursor CLI](https://cursor.com/cli). It runs `agent -p`
for ask, so `ask -w -m cursor:gpt-5 "..."` hands a task to Cursor. **Write runs only**: see
[Read and write](#read-and-write).

## Install

```sh
ask install cursor
```

Requires Cursor CLI, signed in (`agent login`, or `CURSOR_API_KEY` set for scripts), and
Node.js 18 or newer. The agent finds both even when they are not on ask's `PATH`: `agent` or `cursor-agent`
in `~/.local/bin`, where Cursor's installer puts both; Node.js in Homebrew, `/usr/local/bin`, Volta, nvm
(the newest), fnm or `~/.local/bin`. Without one, `ask models` shows what to install.

## Models

Cursor's models depend on your account, and its documentation does not say what `agent models`
prints, so the agent lists none. Add the ids it shows, as Cursor names them:

```sh
agent models
ask models cursor:gpt-5 --enable
```

The id is passed to `--model` as it is, and ask lowercases it. Cursor has no effort flag; an
effort is part of the model id, so `cursor:ID#effort` is refused.

## Read and write

Cursor's documentation calls `--mode ask` read-only, yet it also says print mode "has access to all
tools, including write and shell" and "full write access in non-interactive mode". Cursor is closed
source, and ask never trusts a mode or a prompt alone to keep a run read-only, so **read runs are
refused**: the agent exits 1 before starting Cursor.

**Write runs** (`ask -w`) use `--force --trust`, so Cursor changes files and runs commands without
asking. Use `ask -w` in a worktree you can throw away.

Enabling reads needs one thing: proof that Cursor enforces `--mode ask` with no permission to
write or run commands in print mode, from Cursor or from a run against a real account.

## Follow-ups

The session id of Cursor's first event is reported to ask at once, so `ask continue RUN "prompt"` continues it
with `--resume`.

## Gaps

- **Usage and cost**: Cursor's stream-json output documents none, so ask shows no tokens or cost
  for a run and `--max-cost` has nothing to measure.
- **Titles**: Cursor has no flag for a session's title, so `ASK_TITLE` is not used.
- **Prompt size**: the prompt is an argument, since Cursor documents no stdin prompt, so one over
  the operating system's argument limit (about 128 KB on Linux) fails.

## Environment

| Variable | |
| --- | --- |
| `ASK_CURSOR_BIN` | The Cursor executable to run, instead of looking for `agent` or `cursor-agent` on `PATH` and in `~/.local/bin`. |
| `ASK_NODE` | The Node.js executable to run the agent with. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS`,
`ASK_SESSION` and `ASK_REPORT` (see [Agents](../../docs/agents.md)). Cursor enforces no schema, so
`ASK_SCHEMA` is ignored; ask still checks JSON answers.

## Sources

What the agent relies on, from Cursor's documentation (the CLI is closed source):

- [Parameters](https://cursor.com/docs/cli/reference/parameters): `-p`, `--force`, `--trust`,
  `--output-format`, `--model`, `--resume`, `--mode`, and "print mode has access to all tools"
- [Output format](https://cursor.com/docs/cli/reference/output-format): the stream-json events
- [Using the CLI](https://cursor.com/docs/cli/using): ask mode, and "full write access in
  non-interactive mode"
- [Headless](https://cursor.com/docs/cli/headless): `--force`, `CURSOR_API_KEY`
- [Installation](https://cursor.com/docs/cli/installation) and the
  [install script](https://cursor.com/install): `agent` as the command, and the `agent` and
  `cursor-agent` symlinks in `~/.local/bin`
- [Permissions](https://cursor.com/docs/cli/reference/permissions) and
  [configuration](https://cursor.com/docs/cli/reference/configuration)

## Testing

```sh
cd packages/cursor && node --test
```

The tests drive a fake `agent` in `test/bin`; they need no network or account. To try the
real thing by hand:

```sh
echo "say hi" | ASK_MODEL=gpt-5 ASK_ACCESS=write ASK_REPORT=/tmp/r.json \
  ~/.ask/packages/ask/packages/cursor/agents/cursor
cat /tmp/r.json
```
