# Built-in extensions

The two extensions ask ships, each adding an external harness: Claude Code or Codex runs a
session instead of ask's own harness. Each folder is built into the binary, so `ask install
NAME` needs no download:

| Folder | Reaches | Install |
| --- | --- | --- |
| [`claude/`](claude/) | Claude Code (`claude -p`) | `ask install claude` |
| [`codex/`](codex/) | Codex (`codex exec`) | `ask install codex` |

Installing one connects ask to a CLI you already have; it does not install or authenticate it.
Both need Node.js 18 or newer. Use `ask -m claude:sonnet-5.5 "prompt"` or
`ask -m codex:gpt-5.5 "prompt"` as with any model.

They get no special treatment: each is an ordinary extension under the contract in
[docs/extensions.md](../docs/extensions.md), the same one anyone's uses. ask's core knows nothing
about them; `.github/checks/guard.sh` checks that. Capabilities differ: read each README for how
read-only is enforced, what is reported and what the CLI still loads.

## Layout

```text
extensions/NAME/
├── extension.json   {"harness": {"prefix": "NAME", "command": "NAME"}}
├── NAME             a small sh launcher that finds Node.js 18+ and runs NAME.mjs beside it
├── NAME.mjs         the harness: runs the CLI, maps access and models, writes the report
├── activity.mjs     visible activity for ASK_EVENTS, from the CLI's own event stream
├── writer.mjs       the private append-only JSONL writer activity.mjs uses
├── README.md        what a user needs: install, models, read and write
└── test/            node --test, against a fake CLI in test/bin
```

`extensions.go` builds the manifest, launcher, scripts and README of each into ask. `ask install
NAME` writes them to `~/.ask/agent/extensions/NAME/`, and ask rewrites that copy when its version
changes. A folder of your own by that name is never replaced.

The two `writer.mjs` files are identical copies, since neither folder may import the other; the
guard checks they match. `test/writer.mjs` is their shared regression suite and `test/helper.mjs`
the shared test plumbing, neither of which ships.

## Working on one

```sh
./x baymax                 # both, offline
./x baymax claude          # one
```

The extensions use Node.js built-ins only. A change to what users see goes in that folder's
`README.md` and in `CHANGELOG.md`.
