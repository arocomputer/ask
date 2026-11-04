# aider

The official ask agent for [Aider](https://aider.chat). It runs `aider --message-file` for ask, so
`ask -w -m aider:gpt-4o "..."` hands a task to Aider. **Write runs only**: see
[Read and write](#read-and-write).

## Install

```sh
ask install aider
```

Requires Aider, with an API key for your model set the way Aider reads it (its config, `.env` or
the environment) and Node.js 18 or newer. The agent finds Aider even when it is not on ask's
`PATH`: in `~/.local/bin` (where `aider-install` and `pipx` put it), `/opt/homebrew/bin` or
`/usr/local/bin`; Node.js in Homebrew, `/usr/local/bin`, Volta, nvm (the newest), fnm or
`~/.local/bin`. Without one, `ask models` shows what to install.

## Models

Aider takes any model [litellm](https://docs.litellm.ai) knows, and its model list needs a search
term, so the agent lists none. Add the ones you use:

```sh
ask models aider:gpt-4o --enable
```

The id is passed to `--model` as it is, and ask lowercases it, so a provider id with capitals
cannot be named. Aider's own aliases (`sonnet`, `4o`) are passed on too, though ask's convention is
a full name. An effort (`aider:o3#high`) is passed as `--reasoning-effort`.

## Read and write

**Read runs are refused**: the agent exits 1 before starting Aider. Its ask mode (`--chat-mode
ask`) applies no edits, but Aider still writes its repo-map cache, `.aider.tags.cache.v4`, into the
project, and its config files and environment (`.aider.conf.yml`, `.env`, `AIDER_*`) can switch
on linting, testing, committing and loading by themselves. ask does not parse those to guess what
is safe.

**Write runs** (`ask -w`) use Aider's default edit mode for the model, with `--yes-always`. Aider
does not commit (`--no-auto-commits`, `--no-dirty-commits`), so ask sees the changes in the working
tree, as with the other agents. Aider never runs shell commands it suggests under `--yes-always`.
Its chat, input and LLM history and its analytics log go to a temporary directory that is removed
after the run, and `.gitignore` is left alone. Use `ask -w` in a worktree you can throw away.

A prompt that starts with `/` or `!` gets a leading space, since Aider would run it as one of its
commands.

## Gaps

- **Sessions**: Aider has no session ids, so conversation follow-ups (`ask continue RUN "prompt"`) are unavailable.
- **Titles**: Aider has no session title, so `ASK_TITLE` is not used.
- **Usage**: tokens and cost come from Aider's analytics log once the run ends, summed over every
  response, so they do not show live, and ask can't stop a run at a cost limit mid-run. A run that
  sends nothing to the model fails, since Aider exits 0 even on a bad key.
- **Answer**: Aider has no machine-readable output; the answer is the last response in its LLM
  history file.

## Environment

| Variable | |
| --- | --- |
| `ASK_AIDER_BIN` | The `aider` executable to run, instead of looking on `PATH` and in the usual places. |
| `ASK_NODE` | The Node.js executable to run the agent with. |

The agent also reads ask's contract variables: `ASK_MODEL`, `ASK_EFFORT`, `ASK_ACCESS` and
`ASK_REPORT` (see [Agents](../../docs/agents.md)). Aider enforces no schema, so `ASK_SCHEMA` is
ignored; ask still checks JSON answers.

## Sources

What the agent relies on, from Aider's documentation and source:

- [Options reference](https://aider.chat/docs/config/options.html): `--message-file`, `--yes-always`,
  `--model`, `--reasoning-effort` and the `--no-*` flags
- [Scripting](https://aider.chat/docs/scripting.html) and
  [chat modes](https://aider.chat/docs/usage/modes.html)
- [`ask_coder.py`](https://github.com/Aider-AI/aider/blob/main/aider/coders/ask_coder.py),
  [`base_coder.py`](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py),
  [`main.py`](https://github.com/Aider-AI/aider/blob/main/aider/main.py),
  [`io.py`](https://github.com/Aider-AI/aider/blob/main/aider/io.py),
  [`analytics.py`](https://github.com/Aider-AI/aider/blob/main/aider/analytics.py) and
  [`repomap.py`](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py): messages starting
  with `/` or `!` run as commands, the LLM history and analytics log formats, exit code 0 on
  failure, the repo-map cache location

## Testing

```sh
cd packages/aider && node --test
```

The tests drive a fake `aider` in `test/bin`; they need no network or account. To try the real
thing by hand, in a git repository you can discard:

```sh
echo "say hi" | ASK_MODEL=gpt-4o ASK_ACCESS=write ASK_REPORT=/tmp/r.json \
  ~/.ask/packages/ask/packages/aider/agents/aider
cat /tmp/r.json
```
