# Harnesses and extensions

A **harness** is a coding agent that ask runs for a turn, in place of its own loop. A model named
`NAME/MODEL` goes to the harness called `NAME`. ask officially supports two, and anyone can add
more as an **extension**:

| Harness | Models | Runs |
| --- | --- | --- |
| `claude` | `claude/sonnet`, `claude/opus`, `claude/claude-sonnet-5-5`, … | your installed [Claude Code](https://code.claude.com/docs/en/setup) |
| `codex` | `codex/default`, `codex/gpt-5.5`, … | your installed [Codex](https://developers.openai.com/codex/cli) |

```sh
ask install            # what there is, and what is installed
ask install claude     # turn on the claude harness
ask install codex
ask install skill      # teach Claude Code and Codex to hand work to ask
ask remove codex       # turn it off again
```

ask doesn't install Claude Code or Codex for you, and doesn't sign in to them. Install each one
as its docs say, sign in its own way (`claude`, then `/login`; `codex login`), then run `ask
install`. ask starts the unmodified program you installed and never reads, stores or passes on
its sign-in. `ask install` and `ask doctor` say whether each one is ready.

## What a harness can reach

Neither harness gets your API keys: ask removes every `*_API_KEY` variable from their
environment, so Claude Code and Codex use their own sign-ins, and the commands they run never
see a key. To run one on an API key anyway, set it under `"env"` (below). Model names a CLI
could take for a flag are refused.

| | Read-only task | Write task |
| --- | --- | --- |
| ask's own loop | Reads only the task's folder; runs nothing | Commands in ask's sandbox ([Sessions](sessions.md#read-and-write)): writes only the folder, home hidden, web through ask's proxy |
| Claude Code | Reads only the task's folder; runs nothing | Edits only the folder; commands in Claude Code's sandbox, home unreadable, no network. Refused where that sandbox can't run (Linux without `bubblewrap` and `socat`) |
| Codex | Commands read the folder and system, not your home; write nothing; no network | Commands also write the folder and temp folders; no network |

Both harnesses can search the web with their own hosted search, which runs on Anthropic's or
OpenAI's side, not on your machine: Claude Code with its WebSearch tool, Codex from OpenAI's
search index ("cached", which is less open to prompt injection than live pages). Codex's
commands can't read environment files (`.env`, `.env.local`, ...); their examples stay readable.

## Moving between harnesses

A session can change models from one turn to the next, even between ask's own loop and a
harness, or from one harness to another. A harness continues its own session while turns stay
with it. When a turn moves to a harness that wasn't part of the conversation, ask sends the
conversation so far along with the prompt, as text, so the new harness picks up where the last
one stopped.

## Claude Code

`claude/MODEL` takes Claude Code's own model names: an alias like `sonnet`, `opus`, `fable` or
`haiku` (always its current model of that kind), or a full id like `claude-sonnet-5-5`. It is a
different route from `anthropic/MODEL`, which is ask's own loop calling Anthropic's API with
your API key.

Each run is kept to the task with Claude Code's documented controls. It runs `--restricted`:
its file tools can't reach outside the task's folder, and no settings file, yours or a
repository's, changes the run. There are no hooks, MCP servers, slash commands, auto memory or
background tasks, and anything that would ask for permission is refused.

- A read-only task gets Read, Grep and Glob, and nothing else.
- A write task also gets Edit, Write and Bash. Where Claude Code's sandbox can run (macOS, or
  Linux with `bubblewrap` and `socat` installed), its commands must run inside it: they can
  write only the task's folder and a temp folder, can't read your home folder, and have no
  network. Where it can't run, Claude Code takes read-only tasks only; `ask install claude` and
  `ask doctor` say so, with what to install.

Anthropic permits running the unmodified Claude Code with the user's own sign-in, and asks
developers building on it to use API keys; ask's reading is that running your own Claude Code
on your own machine is the first case. Anthropic decides how its terms apply, so if that matters
to you, use `anthropic/` models with an API key.

## Codex

`codex/default` uses Codex's own default model; `codex/MODEL` names one. ask needs Codex 0.166
or newer. Each run skips your Codex `config.toml` (its MCP servers, profiles and hooks) and
execution-policy rules, never asks for approval, and runs its commands under a Codex permission
profile ask defines:

- Commands can read the task's folder, the system, and the toolchains on your `PATH`. Your home
  folder stays hidden. There is no network.
- A write task can also write the task's folder and temp folders. Codex keeps `.git` read-only,
  so a Codex write task changes files but doesn't commit; the result lists what changed.

## Changing how a harness runs

`ask install` adds an entry for the harness to `~/.ask/config.json`, which you can edit:

```json
{
  "extensions": ["claude", "codex"],
  "harnesses": {
    "claude": { "command": "claude", "args": [], "env": {} },
    "codex": { "command": "/opt/codex/bin/codex", "args": ["-c", "model_verbosity=\"low\""], "env": {} }
  }
}
```

- `command`: the program, as a path or a name on your `PATH`.
- `args`: extra arguments, placed after ask's own, so they can override them.
- `env`: extra environment variables, set after ask removes API keys, so a key set here is
  passed on.

`"extensions"` lists what is turned on; taking a name out turns it off without uninstalling it,
and an extension that is turned off is never loaded.
`ask remove` deletes the `harnesses` entry only while it is as `ask install` wrote it.

## The agent skill

`ask install skill` writes a short skill, `skills/ask/SKILL.md`, into `~/.claude` and `~/.codex`
(whichever exist), so those agents hand work to ask with JSON requests. A different file already
there is kept as `SKILL.md.bak`, and `ask remove skill` puts it back.

## Turning tools off, and replacing them

ask's own loop gives a subagent `read`, `list`, `grep`, `fetch` and `search`, plus `write`,
`edit` and `shell` in a write task. `ask tools` lists them, where each comes from, and whether
it is on:

```sh
ask tools               # every tool, built-in or from an extension
ask tools off shell     # write tasks edit files but run no commands
ask tools on shell
```

Turning one off sets it to `false` under `"tools"` in `~/.ask/config.json`, which you can also
edit. An extension's tool with a built-in's name replaces the built-in, so an extension can
swap ask's `search` for another engine, or `fetch` for one that renders pages. A read-only task
only takes read-only tools, so a replacement for `read`, `list`, `grep`, `fetch` or `search`
must say `readonly: true`. These are tools for ask's own loop; Claude Code and Codex use their
own.

## Installing an extension

```sh
ask install ./my-harness
ask install https://github.com/someone/ask-gemini
```

An extension is a folder, or a git repository ask clones. ask loads it to check it, then copies
it to `~/.ask/extensions/NAME` (made only when the first extension is installed). Installing it
again updates it; `ask remove NAME` deletes it. An extension runs as part of ask, with your
permissions, so install only ones you trust. One that fails to load, or takes over ten seconds,
is skipped, and `ask doctor` says why.

## Writing an extension

An extension is an ES module, `index.js` or `package.json`'s `"main"`, whose default export
names it and adds a harness, tools for ask's own loop, or both. It is loaded as it is, so it
imports only Node's built-ins and its own files: bundle anything else. For TypeScript, the
`Extension`, `Harness` and `Tool` types come from `@arocomputer/ask` as a development
dependency.

```js
// index.js
import { spawnSync } from "node:child_process"

export default {
  name: "gemini",
  harness: {
    name: "gemini",
    title: "Gemini",
    command: "gemini",
    models: () => [{ id: "pro", name: "Gemini Pro" }],
    status(settings) {
      const ok = spawnSync(settings.command ?? "gemini", ["--version"]).status === 0
      return ok ? { ready: true, detail: "Gemini is installed" } : { ready: false, detail: "Gemini isn't installed", fix: "install it" }
    },
    async run(r) {
      // r: model, dir, prompt, history, write, effort, schema, session, messages, settings, signal
      // Call r.onSession(id) once its own session id is known, and r.onUpdate(messages, usage)
      // after each step, so ask saves progress. Resolve with {answer} or {error}, plus the
      // messages and usage.
    },
  },
  tools: [
    {
      name: "weather",
      description: "Today's weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      readonly: true,
      async run(args, { dir, signal }) {
        return "sunny"
      },
    },
  ],
}
```

- **name**: lowercase letters, digits and dashes; the folder's name, and the harness's.
- **harness.run** runs one turn. `history`, when given, is the conversation so far as text, for
  a harness that wasn't part of it: send it before the prompt. `session` is the harness's own
  session to continue, when there is one. `prompt` is absent when a stopped turn is resumed.
  Stop when `signal` aborts. Honor `write`: a read-only task must not change anything. Keep the
  agent to `dir` as far as it allows, and, as ask's own harnesses do, don't pass `*_API_KEY`
  variables on unless `settings.env` sets them.
- **harness.status** says whether it can run here, and how to fix it if not.
- **harness.parent**, optional, reads the calling conversation's id from the environment a
  command run by that agent gets, so ask can scope `sessions` to it.
- **tools** are added to ask's own loop; one with a built-in's name replaces it. Read-only
  tasks get only tools marked `readonly`, and may run those in parallel. `run(args, context)`
  gets `context.dir`, the task's folder; `context.signal`, which aborts when the task stops;
  and in a write task `context.sandbox`, whose `command(script)` gives the program, arguments
  and environment that run a shell command in ask's sandbox. A tool that runs commands should
  use it. It returns the text the model sees; what it throws reaches the model as an error.

For example, an extension that replaces `search` with [ddgs](https://github.com/deedy5/ddgs),
for people who have it installed (`pip install ddgs`):

```js
// ~/my-search/index.js; install with: ask install ~/my-search
import { execFileSync } from "node:child_process"

export default {
  name: "ddgs",
  tools: [
    {
      name: "search",
      description: "Search the web; returns results with their title, address and a snippet.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      readonly: true,
      async run({ query }) {
        const script = "import json, sys; from ddgs import DDGS; print(json.dumps(DDGS().text(sys.argv[1], max_results=8)))"
        const results = JSON.parse(execFileSync("python3", ["-c", script, String(query)], { encoding: "utf8" }))
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.href}\n   ${r.body}`).join("\n")
      },
    },
  ],
}
```
