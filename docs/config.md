# Config

Three files in `~/.ask` (or `$ASK_HOME`) are yours to edit: `config.json`, `auth.json` and
[`models.json`](models.md). Everything else ask keeps is under `agent/` and `cache/`.

```text
~/.ask/
├── config.json      your defaults
├── auth.json        provider credentials, mode 0600
├── models.json      models you declare, with names and prices (see models.md)
├── cache/           fetched data, safe to delete: the models.dev listing
└── agent/
    ├── sessions/    one folder per session (see sessions.md)
    ├── worktrees/   write sessions' worktrees, unless config puts them elsewhere
    └── extensions/  harnesses, tools and commands (see extensions.md)
```

Nothing is created until it is needed: `agent/sessions/` on the first launch, `worktrees/` on
the first worktree session, `extensions/` on the first install, `auth.json` when setup saves a
key, `cache/` when the listing is fetched.

## config.json

```sh
ask config                              # print it
ask config model                        # one key
ask config model opencode-go/glm-5.3    # set one
ask config model ""                     # remove one
```

```json
{
  "model": "opencode-go/glm-5.3",
  "timeout": 1800,
  "max_cost": 2,
  "worktree": true,
  "worktrees": "~/code/worktrees/ask-{name}",
  "branches": "ask/{name}"
}
```

| Key | What it sets | Built in |
| --- | --- | --- |
| `model` | The model when `-m` is not given; checked when you set it | none: `-m` is required |
| `timeout` | Seconds a turn may take, unless `-t` says otherwise | `900` |
| `max_cost` | Dollars a turn may spend before ask stops it, unless `--max-cost` says otherwise; `0` for none | none |
| `worktree` | Give every write session its own git worktree | `false` |
| `worktrees` | Where worktrees go: an absolute or `~` path, or a path inside the repository like `.ask/worktrees/{name}`, whose last part holds `{name}` once | `~/.ask/agent/worktrees/{name}` |
| `branches` | The branch of a session's worktree, holding `{name}` once | `ask/{name}` |

`{name}` is made from the prompt's first words, like `add-rate-limiting-to`, with `-2`, `-3`
added when another session has that name. A relative `worktrees` path is inside the repository
the session starts in; add it to that repository's `.gitignore`. An unknown key or a value of
the wrong kind is an error that names the key.

## auth.json

Provider credentials, mode 0600, written by `ask setup`:

```json
{
  "opencode-go": { "api_key": "..." },
  "openai": { "api_key": "sk-..." },
  "proxy": { "api_key": "...", "base_url": "https://llm.example.com/v1" }
}
```

A built-in provider (`openai`, `opencode`, `opencode-go`) needs only `api_key`. Any other name
with a `base_url` is a provider too, for an endpoint or proxy that speaks the OpenAI Responses
protocol, used as `proxy/MODEL`. `NAME_API_KEY` and `NAME_BASE_URL` in the environment
(`OPENCODE_GO_API_KEY`, `OPENAI_BASE_URL`) take precedence over the file. ask sends gateways its
own user agent and the session's ID, which OpenCode uses to route and cache a conversation.

## What the subagent is told

ask's own harness has a fixed system prompt that makes a session a subagent: answer from the
files, make the final message the deliverable, never ask questions, and keep a read session
read-only. After it come the project's own `AGENTS.md` or `CLAUDE.md`, the nearest one between
the session's directory and the repository root, and the notes of any [extension](extensions.md)
whose tools are offered. The task itself comes from the prompt. There is no global instructions
file: what a subagent needs is either the project's rules or the caller's task.
