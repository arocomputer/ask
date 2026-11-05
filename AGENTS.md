# ask

Hands a task to a subagent and returns a session ID. ask's own harness runs the task against a
model provider; an extension's harness (Claude Code or Codex) can run it instead. Go 1.26 or newer,
standard library only; the harnesses use Node.js 18+, built-ins only.

## Commands

```sh
./x                                     # every offline check, as CI runs it
./x test ./internal/test -run TestSessions  # one feature; add /subtest_name for one behavior
./x baymax claude                       # one built-in extension's tests, against a fake CLI
./x dev sessions                        # build this checkout and run it
./x install                             # build this checkout into ~/.local/bin
./x hooks                               # once per clone: gofmt and vet before each commit
./x release vX.Y.Z                      # prepare a changelog PR, then dispatch the checked main commit
```

`ask help` and `ask help COMMAND` are the contract for flags and output.

## Where things live

- `main.go`: the binary; holds the release version.
- `internal/cmd/NAME/`: one package per command, its `Help` page and its `Run`; `cmd/root`
  dispatches, `cmd/worker` is the detached side of a turn.
- `internal/cmdutil/`: what commands share. `internal/harness`, `provider`, `sessions`,
  `extension`, `git`, `process`, `term`, `config`: the core, one package per purpose. The map and the
  layering rules are in [docs/contributing/architecture.md](docs/contributing/architecture.md).
- `internal/test/`: black-box tests of the binary against a fake provider and a fake harness,
  one file per feature ([internal/test/README.md](internal/test/README.md)).
- `extensions/`: the two extensions ask ships ([extensions/README.md](extensions/README.md)).
- `.github/brand/`: the logo, lockup, wordmark, the README hero (`screen.png`) and `render.py`.
- `docs/`: user docs. `docs/contributing/` is for people working on ask.
- `.github/checks/`: architectural guards. `.github/release/`: release preparation, packaging
  and formula generation ([docs/contributing/releases.md](docs/contributing/releases.md)).

## Conventions

- Fewest moving parts. No dependencies, no daemon, no configuration beyond what a change needs.
- One word per file and folder; `_test` is the only suffix, and Go's own `_linux`/`_darwin`.
- Nothing about a particular coding agent goes in `internal/`; it belongs in its extension,
  which uses only the contract any extension could. The contract changes only as
  `docs/compatibility.md` says: additions are free, a breaking change bumps `ASK_CONTRACT`.
- Grow by need: a new tool, config key or contract field only when a real use needs it.
  Extensions add executables, never code inside ask.
- Document package purpose, public contracts and non-obvious reasons. Omit comments that repeat
  names or code. Update the comments and docs a change touches.
- One test per behavior change, as a subtest in its feature's file. Never call a network or a
  real model in a test.
- A user-visible change gets a `CHANGELOG.md` entry under `## Unreleased` at the top and an
  update to `docs/`.
