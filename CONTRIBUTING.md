# Contributing

Smallness is the point: no runtime dependencies, no daemon, and an engine that knows nothing
about any particular coding agent. A change that makes ask simpler is welcome; one that adds a
moving part needs a strong reason.

You need Node 24 or newer, Bun, git and a POSIX shell; shellcheck and actionlint check the
scripts and workflows, as CI does.

```sh
bun install                 # once: TypeScript and Node's types
npm run check && npm test   # before a pull request; CI runs the same, on Linux and macOS
```

`npm test` runs every test under Node, then under Bun. The tests use a fake provider and never
call a network or a real model.

- [AGENTS.md](AGENTS.md): commands, where things live, conventions.
- [docs/contributing/architecture.md](docs/contributing/architecture.md): how a turn goes, the
  modules, and the rules the layout keeps.
- [docs/contributing/releases.md](docs/contributing/releases.md): cutting a release.
- [docs/contributing/terminal.md](docs/contributing/terminal.md): terminal design and offline
  desktop/phone fixtures.

A behavior change comes with one test for it, and a user-visible change with a line in
`CHANGELOG.md` and an update to `docs/`.

To report an issue, include your operating system, what you ran, what you expected, and what
happened, with the output of `ask --version` and `ask doctor`; redact private paths, prompts and
other sensitive details before sharing them.

By contributing you agree that your work is licensed under the MIT license of this project.
