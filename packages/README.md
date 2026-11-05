# Official agents

The agents ask ships for the coding agents most people use. Each folder is an ordinary ask package,
built into the ask binary so `ask install NAME` needs no download:

| Folder | Reaches | Install |
| --- | --- | --- |
| [`claude/`](claude/) | Claude Code (`claude -p`) | `ask install claude` |
| [`codex/`](codex/) | Codex (`codex exec`) | `ask install codex` |
| [`opencode/`](opencode/) | OpenCode v1.1.65+ or v2, detected automatically (`opencode run`) | `ask install opencode` |
| [`copilot/`](copilot/) | GitHub Copilot CLI (`copilot`) | `ask install copilot` |
| [`gemini/`](gemini/) | Gemini CLI (`gemini`) | `ask install gemini` |
| [`pi/`](pi/) | Pi (`pi --mode json`) | `ask install pi` |
| [`e/`](e/) | e (`e rpc`) | `ask install e` |
| [`cursor/`](cursor/) | Cursor CLI (`cursor-agent` or `agent`) | `ask install cursor` |
| [`aider/`](aider/) | Aider (`aider --message-file`) | `ask install aider` |
| [`amp/`](amp/) | Amp (`amp --execute`) | `ask install amp` |
| [`qwen/`](qwen/) | Qwen Code (`qwen`) | `ask install qwen` |
| [`kimi/`](kimi/) | Kimi Code (`kimi --prompt`) | `ask install kimi` |
| [`goose/`](goose/) | Goose (`goose run`) | `ask install goose` |
| [`cline/`](cline/) | Cline CLI (`cline --acp`) | `ask install cline` |
| [`kilo/`](kilo/) | Kilo CLI (`kilo run`) | `ask install kilo` |
| [`continue/`](continue/) | Continue CLI (`cn -p`) | `ask install continue` |
| [`openhands/`](openhands/) | OpenHands CLI (`openhands --headless`) | `ask install openhands` |
| [`vibe/`](vibe/) | Mistral Vibe (`vibe -p`) | `ask install vibe` |

Installing these packages connects ask to existing CLIs; it does not install or authenticate
them. All official agents need Node.js 18 or newer. See each package's README for prerequisites.

Use `ask -m MODEL "prompt"`, or set a default model and use `ask "prompt"`. A launch prints
its run ID; use `ask wait RUN` for the answer, or add `--wait` to the launch to wait directly.
`ask continue RUN "prompt"` follows up in the saved conversation, inheriting model and access;
write access may run commands. Without a prompt, `ask continue RUN` recovers unfinished work.
See [Runs](../docs/runs.md) for details.

They get no special treatment: each uses only the agent contract in
[docs/agents.md](../docs/agents.md), the same one anyone's agent uses. ask's core knows nothing
about them; `scripts/guard.sh` checks that.

Capabilities differ: not every harness supports enforced read access, native titles, usage or
continuation. Read each package's README (also available as `ask docs NAME`) for prerequisites
and limits. Amp chooses routing modes rather than a fixed backend model. e currently requires
a source build. OpenCode remains one package and uses the installed executable, or
`ASK_OPENCODE_BIN`; there are no separate v1/v2 model namespaces.

## Layout

```text
packages/NAME/
├── agents/NAME      a small sh launcher that finds Node.js 18+ and runs lib/NAME.mjs
├── agents/NAME.environment.json  optional environment defaults and supported integration keys
├── lib/NAME.mjs     the agent: runs the CLI, maps access and models, writes the report
├── test/            node --test, against a fake CLI in test/bin
└── README.md        what a user needs: install, models, read and write
```

`packages.go` embeds `agents/`, `lib/` and `README.md` of each. `ask install NAME` writes them to
`~/.ask/packages/ask/packages/NAME`, and ask rewrites that copy whenever its own build differs, so
an installed agent always matches the ask running it.

## Working on one

```sh
./x integration           # every official agent, offline through real ask
./x integration claude    # one harness, adapter tests and integration
cd packages/claude && node --test
```

The agents use Node.js built-ins only. A change to what users see goes in that folder's
`README.md` and in `CHANGELOG.md`.

[Integration checks](../docs/contributing/integration.md) share test process/report plumbing.
Tests need no installed coding CLIs,
credentials or running agents; harness-specific assertions and simulators remain beside each
package. A pass verifies covered simulator contracts, not live provider compatibility.
