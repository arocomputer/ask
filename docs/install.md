# Install

ask is a single binary with no language runtime or library dependencies. Git is needed for packages,
worktrees and reporting changes. Your agents keep their own CLI and runtime requirements.

## The installer

```sh
curl -fsSL https://fschrhunt.com/ask/install.sh | sh
```

It downloads the release archive for your system (macOS or Linux, Intel or ARM), checks it against
the release's `checksums.txt`, and installs `ask` into `~/.local/bin`, saying so if that isn't on
your `PATH`. It never edits your shell files. Options, after `sh -s --`:

```sh
curl -fsSL https://fschrhunt.com/ask/install.sh | sh -s -- --version v0.1.0 --dir ~/bin
```

`ASK_INSTALL_DIR` and `ASK_VERSION` do the same as `--dir` and `--version`. The script is
[`install.sh`](../install.sh) in ask's repository; read it before you run it if you like.
To see installer options without installing, pipe it to `sh -s -- --help`. For ask's own
commands after installation, use `ask help` or `ask help COMMAND`.

## Homebrew

ask's repository is its own tap:

```sh
brew tap arocomputer/ask https://github.com/arocomputer/ask
brew install ask
```

If Homebrew refuses the tap as untrusted, run `brew trust arocomputer/ask` and install
again. Each release updates the formula, [`ask.rb`](../ask.rb), so
`brew upgrade ask` brings the latest.

## With Go

Go 1.26 or newer can build and install ask (also required for the source build below):

```sh
go install github.com/arocomputer/ask/cmd/ask@latest
```

Put `$(go env GOPATH)/bin` on your `PATH`.

## By hand

Download `ask_VERSION_OS_ARCH.tar.gz` for your system and `checksums.txt` from
[Releases](https://github.com/arocomputer/ask/releases/latest), check the archive's SHA-256
(`sha256sum` on Linux, `shasum -a 256` on macOS), extract it and put `ask` on your `PATH`. Each
archive's build provenance can be verified with
`gh attestation verify ask_VERSION_OS_ARCH.tar.gz -R arocomputer/ask`.

## From source

```sh
git clone https://github.com/arocomputer/ask
cd ask
go build -o ask ./cmd/ask
mkdir -p ~/.local/bin
cp ask ~/.local/bin/ask
```

`ask --version` prints the release tag, or `dev` for an unversioned source build.

## Set up

```sh
ask setup
```

It finds the coding agent CLIs you have, connects ask to them, sets your defaults and teaches the
apps you work in to use ask; see [Setup](setup.md). ask runs each coding agent through an agent:
a small executable that runs that agent's CLI. The official ones are built into ask and install by
name, which is what setup does:

```sh
ask install claude        # Claude Code
ask install codex         # Codex
ask install opencode      # Opencode
```

Installing an ask agent does not install its coding agent CLI or sign you in. For example,
Claude Code and Codex need their CLIs installed and authenticated; OpenCode needs its CLI
installed with at least one provider connected. Official ask agents need Node.js 18 or newer;
see [official packages](../packages/README.md) for each harness's prerequisites. The agent finds the CLI even
when it isn't on your `PATH`, and setup says what is missing if anything is. To write your own,
see [Agents](agents.md): a minimal one is a few lines of shell.

Then check what ask can reach:

```sh
ask models
```

```text
claude:sonnet-5.5
claude:haiku-4.5
```

The output depends on the agents installed here. In a project directory, choose one of the ids
from `ask models` and try a first run (this example uses Claude Code):

```sh
ask --model claude:haiku-4.5 "What does this project do?"
```

## Update

```sh
ask update            # an ask from the installer or an archive: replaced with the latest release
ask update --check    # only say whether a newer one is out
```

On a terminal, checking and installing show a transient progress indicator; the final result
stays in scrollback. Redirected output uses plain status messages.

Homebrew updates its own (`brew upgrade ask`), and so does Go (rerun `go install ...@latest`);
`ask update` says so for those. In a terminal, ask mentions a newer release at most once a day;
`ASK_NO_UPDATE_CHECK=1` turns that off. Your `~/.ask` agents, hooks, commands, packages and
recorded runs keep working across updates.

## Where ask keeps things

Everything ask uses is in `~/.ask` (set `ASK_HOME` to move it):

```text
~/.ask/
├── agents/       one executable per coding agent (see agents.md)
├── hooks/        change tasks and check results (see hooks.md)
├── commands/     your own ask commands (see commands.md)
├── packages/     installed packages (see packages.md)
├── models.json   extra model ids per agent (see models.md)
├── settings.json your defaults: model, timeout, worktree folders (see settings.md)
├── runs/         recorded runs (see runs.md)
└── worktrees/    isolated write runs (see usage.md)
```

ask creates `runs/` on the first run, and `worktrees/` when needed.
