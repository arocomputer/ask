# Contributing

Smallness is the point: no dependencies, no daemon, and a core that knows nothing about any
particular coding agent. A change that makes ask simpler is welcome; one that adds a moving
part needs a strong reason.

You need Go 1.26 or newer, git, a POSIX shell, Node.js 18+ for the harness tests, shellcheck
for `./x shell`, actionlint for `./x workflows` and ruby for the formula check; `./x tools`
says which are missing.

```sh
./x hooks     # once: gofmt and vet before each commit
./x           # before a pull request; CI runs the same checks
```

`./x` defaults to `check`: formatting and vet, the Go tests, `baymax` (the harness tests),
shellcheck, actionlint, the formula's syntax and the architectural guards, each with a header
and its time. `./x test` and `./x build` forward Go arguments, for example
`./x test ./internal/test -run TestRuns`.

- [AGENTS.md](AGENTS.md): commands, where things live, conventions.
- [docs/contributing/architecture.md](docs/contributing/architecture.md): how a turn goes, the
  packages, and the rules the layout keeps.
- [internal/test/README.md](internal/test/README.md): the tests, the fakes, and which file covers what.
- [docs/contributing/releases.md](docs/contributing/releases.md): cutting a release.

A behavior change comes with one test for it, and a user-visible change with a line in
`CHANGELOG.md` and an update to `docs/`. Support for another coding agent is an extension under
the contract in `docs/extensions.md`, not a change to ask.

To report an issue, include your operating system, the command you ran, what you expected, and
what happened, with the output of `ask --version`; redact private paths, prompts and other
sensitive details before sharing them.

By contributing you agree that your work is licensed under the MIT license of this project.
