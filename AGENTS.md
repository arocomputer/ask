# ask

Hands tasks to subagents. Agents send JSON requests on stdin; people run a few commands. ask runs
its own agent loop against model providers. TypeScript with no runtime dependencies, on Node 24
or Bun.

## Commands

```sh
bun install                              # once: TypeScript and Node's types, for development
npm run check                            # the typecheck
npm test                                 # every test, under Node and then Bun
node --test test/cli.test.ts             # one area; --test-name-pattern="..." for one behavior
bun src/cli.ts doctor                    # run this checkout (node src/cli.ts works too)
.github/release/release.sh vX.Y.Z        # prepare a changelog PR, then dispatch the checked main commit
```

`ask help`, `ask help COMMAND` and `ask help requests` are the contract for commands and requests.

## Where things live

- `src/`: the engine, one module per purpose; `src/cli.ts` is the command, `src/protocol.ts` the
  agent interface, `src/cmd/` the commands for people. The map is in
  [docs/contributing/architecture.md](docs/contributing/architecture.md).
- `test/`: tests against a fake provider (`test/fake.ts`), one file per area; `cli.test.ts` runs
  the real command and its detached workers.
- `docs/`: user docs. `docs/contributing/` is for people working on ask.
- `.github/release/`: packaging with Bun, the Homebrew formula, cutting a release
  ([docs/contributing/releases.md](docs/contributing/releases.md)). `.github/brand/`: the logo.

## Conventions

- Fewest moving parts. No runtime dependencies, no daemon, no configuration beyond what a change
  needs.
- One word per file and folder; `.test` is the only suffix.
- The engine imports only Node's built-ins and its own files, and names no particular coding
  agent; `test/rules.test.ts` checks both.
- Grow by need: a new tool, request field or setting only when a real use needs it. New request
  fields are free; changing or removing one breaks every agent that uses it.
- Document module purpose, public contracts and non-obvious reasons. Omit comments that repeat
  names or code. Update the comments and docs a change touches.
- One focused test per behavior change, in its area's file. Never call a network or a real model
  in a test.
- A user-visible change gets a `CHANGELOG.md` entry under `## Unreleased` at the top and an
  update to `docs/`.
