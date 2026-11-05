# Install

The installer and Homebrew give you one self-contained binary. Through npm, ask runs on Node 24
or newer. Git is needed for worktrees and for listing what a write task changed.

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

## npm

```sh
npm install -g @arocomputer/ask
```

The same package is a library: `import { handle } from "@arocomputer/ask"` takes the requests
described in [Requests](requests.md) and returns the same responses.

## By hand

Download `ask_VERSION_OS_ARCH.tar.gz` for your system and `checksums.txt` from
[Releases](https://github.com/arocomputer/ask/releases/latest), check the archive's SHA-256
(`sha256sum` on Linux, `shasum -a 256` on macOS), extract it and put `ask` on your `PATH`. Each
archive's build provenance can be verified with
`gh attestation verify ask_VERSION_OS_ARCH.tar.gz -R arocomputer/ask`.

## Set up

```sh
ask settings
```

It asks for a provider, its key and the models you want; see [Settings](settings.md). Then check
everything works:

```sh
ask doctor
```

## Where ask keeps things

Everything is in `~/.ask` (set `ASK_HOME` to move it), and nothing is there until it is used:

```text
~/.ask/
├── config.json      your default model, chosen models and timeout
├── auth.json        pasted provider keys, mode 0600
├── cache/           the model catalog, safe to delete
├── sessions/        one folder per session (see sessions.md)
└── worktrees/       the checkouts worktree tasks work in
```
