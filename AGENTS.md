# ask

Hands tasks to coding agents, one task or a batch in parallel. Each coding agent is reached through
an agent: an executable in `~/.ask/agents` or a package. ask's core (`src/`) knows nothing about
any of them; the official agents live in `packages/` and are built into the binary. Go 1.26 or
newer; terminal presentation uses Bubble Tea and Lip Gloss, while execution uses the standard
library only. The official agents use Node.js 18+, built-ins only.

## Commands

```sh
./x check                            # PR checks: fmt, vet, tests, integration, shellcheck, guard
./x integration copilot               # offline integration checks for Copilot
./x test ./src/test -run 'TestRuns'    # one feature; add /subtest_name for one behavior
./x dev runs                         # build this checkout and run it
./x hooks                            # once per clone: gofmt and vet before each commit
```

`ask help` and `ask help COMMAND` are the contract for flags and output. Prefer these forms in
guidance and examples; `--help` and `-h` remain supported aliases.

## Where things live

- `main.go`: entry point only; holds the release version.
- `src/`: ask itself, one package per purpose. The map and the layering rules are in
  [docs/contributing/architecture.md](docs/contributing/architecture.md).
- `src/test/`: black-box tests of the binary against a fake agent, one file per feature. How they work
  and which file covers what: [src/test/README.md](src/test/README.md).
- `packages/`: the official agents ([packages/README.md](packages/README.md)).
- `docs/`: user docs, built into ask for `ask docs`. `docs/contributing/` is for people working on
  ask and is not built in.
- `scripts/`: `guard.sh` (the rules below that grep can check) and the release scripts
  ([docs/contributing/releases.md](docs/contributing/releases.md)). `install.sh` is the installer
  people run; `ask.rb` is the Homebrew formula each release regenerates.

## Conventions

- Fewest moving parts. Terminal dependencies belong in `tui` and `status`; no configuration
  beyond what a change needs.
- Nothing about a particular agent goes in `src/`; it belongs in an agent, official ones in
  `packages/`. An official agent uses only the contract any agent could. The agent, hook and
  command contracts change only as `docs/compatibility.md` says: additions are free, a breaking
  change bumps `ASK_CONTRACT`. Files in `src/test/fixtures/` are never rewritten.
- Grow by need: a new hook event or contract field only when a real use needs it.
- Names say what a thing covers: a file is named for its feature or command, never for how it came
  about (no `bugs_test.go`, no `misc.go`).
- Document package purpose, public contracts and non-obvious reasons. Omit comments that repeat
  names or code. Update the comments and docs a change touches.
- One test per behavior change, as a subtest in its feature's file. Never call a network or a real
  model in a test.
- A user-visible change gets a `CHANGELOG.md` entry under `## Unreleased` at the top (add the
  heading when it's missing) and an update to `docs/`; every help topic's footer names its page.
  A release that changed the run record format pins one in `src/test/fixtures/run-vX.Y.Z/`.
