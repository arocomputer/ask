# Install

Worker identity checks need the system `ps` command (`procps` on minimal Linux images).
`ask doctor` checks it; ask refuses to guess whether an unverified worker is safe to restart or stop.

The installer and Homebrew give you one self-contained binary, and on Linux `ask.sandbox` and
`ask.bwrap`, the helpers that confine commands and filesystem tools. Through npm, ask runs on Node
24 or newer, and the published package carries both helpers. Git is needed for worktrees and for
listing what a write task changed. Built-in tasks need Linux with Landlock and working unprivileged
user namespaces, or macOS with Seatbelt. Linux releases bundle static, non-setuid bubblewrap 0.13.1.
If host policy blocks that copy, ask tries system `bwrap` executables on PATH under the same
namespace probe. A source checkout without built helpers needs system bubblewrap and a C compiler.
`ask doctor` probes availability;
ask does not change host security settings or fall back to unconfined filesystem tools.

## The installer

```sh
curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh
```

It downloads the release archive for your system (macOS or Linux, Intel or ARM), checks it against
the release's `checksums.txt`, and installs `ask` (and on Linux `ask.sandbox`) into `~/.local/bin`, saying so if that isn't on
your `PATH`. Linux bundles also install `ask.bwrap` and `ask.sandbox.sources.tar.gz`, containing
upstream sources, licenses and an offline rebuild script. It never edits your shell files.
Options, after `sh -s --`:

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
On Linux, keep both helper executables beside `ask` and retain the source/license archive.

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
