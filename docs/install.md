# Install

ask is a single binary with no runtime or library dependencies. Git is needed for worktrees and
for reporting what a write session changed.

## The installer

```sh
curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh
```

It downloads the release archive for your system (macOS or Linux, Intel or ARM), checks it against
the release's `checksums.txt`, and installs `ask` into `~/.local/bin`, saying so if that isn't on
your `PATH`. It never edits your shell files. Options, after `sh -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh -s -- --version v1.0.0 --dir ~/bin
```

`ASK_INSTALL_DIR` and `ASK_VERSION` do the same as `--dir` and `--version`. The script is
[`install.sh`](../install.sh) in ask's repository. Run it again to update.

## Homebrew

ask's repository is its own tap:

```sh
brew tap arocomputer/ask https://github.com/arocomputer/ask
brew install ask
```

Each release updates the formula, [`ask.rb`](../ask.rb), so `brew upgrade ask` brings the latest.

## With Go

```sh
go install github.com/arocomputer/ask@latest
```

Go 1.26 or newer; put `$(go env GOPATH)/bin` on your `PATH`.

## By hand

Download `ask_VERSION_OS_ARCH.tar.gz` for your system and `checksums.txt` from
[Releases](https://github.com/arocomputer/ask/releases/latest), check the archive's SHA-256
(`sha256sum` on Linux, `shasum -a 256` on macOS), extract it and put `ask` on your `PATH`. Each
archive's build provenance can be verified with
`gh attestation verify ask_VERSION_OS_ARCH.tar.gz -R arocomputer/ask`.

## Set up

```sh
ask setup
```

It asks for a provider key (offering the one OpenCode already has), downloads the model list,
sets your default model, and writes the ask skill for the agents installed on this machine; see
[Setup](setup.md). Then try a session in a project directory:

```sh
ask --wait "What does this project do?"
```

## Where ask keeps things

Everything is in `~/.ask` (set `ASK_HOME` to move it), and nothing is there until it is used:

```text
~/.ask/
├── config.json      your defaults (see config.md)
├── auth.json        provider credentials, written by ask setup, mode 0600
├── models.json      models you declare, with names and prices (see models.md)
├── cache/           fetched data, safe to delete
└── agent/
    ├── sessions/    one folder per session (see sessions.md)
    ├── worktrees/   write sessions' worktrees
    └── extensions/  harnesses, tools and commands (see extensions.md)
```
