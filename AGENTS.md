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
                                         # (the sandbox tests compile native/sandbox.c with cc)
bun src/cli.ts doctor                    # run this checkout (node src/cli.ts works too)
.github/release/release.sh vX.Y.Z        # prepare a changelog PR, then dispatch the checked main commit
```

`ask help`, `ask help COMMAND` and `ask help requests` are the contract for commands and requests.

## Where things live

- `src/`: the engine in layers, lowest first: `base/`, `providers/`, `sandbox/`, `agent/`,
  `harnesses/`, `sessions/`, `commands/`; a file imports only from its own layer and below.
  `src/cli.ts` is the command, `src/sessions/protocol.ts` the agent interface. The map is in
  [docs/contributing/architecture.md](docs/contributing/architecture.md).
- `native/sandbox.c`: the Linux sandbox helper, the only C; its design is
  [docs/contributing/sandbox.md](docs/contributing/sandbox.md).
- `test/`: mirrors `src/`, tests against a fake provider (`test/fake.ts`); `cli.test.ts` runs
  the real command and its detached workers.
- `bench/`: measures subagents on real models (`bench/run.ts`) and how agents delegate
  through ask (`bench/callers.ts`); a change to prompts, tools or the skill ships when it
  does at least as well. It spends quota, so `npm test` never runs it.
- `docs/`: user docs. `docs/contributing/` is for people working on ask.
- `.github/release/`: packaging with Bun, the Homebrew formula, cutting a release
  ([docs/contributing/releases.md](docs/contributing/releases.md)). `.github/brand/`: the logo.

## Conventions

- Fewest moving parts. No runtime dependencies, no daemon, no configuration beyond what a change
  needs.
- One word per file and folder; `.test` is the only suffix.
- The engine imports only Node's built-ins and its own files. It ships two harnesses, Claude
  Code and Codex, and how each is run lives in its own file (`src/claude.ts`, `src/codex.ts`);
  other agents come as extensions. `test/rules.test.ts` checks these.
- Grow by need: a new tool, request field or setting only when a real use needs it. New request
  fields are free; changing or removing one breaks every agent that uses it.
- Document module purpose, public contracts and non-obvious reasons. Omit comments that repeat
  names or code. Update the comments and docs a change touches.
- One focused test per behavior change, in its area's file. Never call a network or a real model
  in a test.
- A user-visible change gets a `CHANGELOG.md` entry under `## Unreleased` at the top and an
  update to `docs/`.
