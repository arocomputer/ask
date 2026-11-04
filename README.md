<div align="center">
  <img src="assets/white/lockup.svg#gh-dark-mode-only" alt="ask" height="52">
  <img src="assets/black/lockup.svg#gh-light-mode-only" alt="ask" height="52">

  <h3>Every model, as a subagent.</h3>

  <p>Hand tasks to your coding agents, on any model they run,<br>
  from your terminal or from another agent. One task or many at once, recorded, with live usage.</p>

  <p>
    <a href="https://github.com/arocomputer/ask/releases/latest"><img src="https://img.shields.io/github/v/release/arocomputer/ask?style=flat-square&color=111111&label=release" alt="Release"></a>
    <a href="https://github.com/arocomputer/ask/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/arocomputer/ask/ci.yml?branch=main&style=flat-square&color=111111&label=ci" alt="CI"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT"></a>
  </p>

```sh
curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh
```

  <img src="assets/screens/dark/run.svg#gh-dark-mode-only" alt="A synchronous ask --wait investigation and write follow-up" width="760">
  <img src="assets/screens/light/run.svg#gh-light-mode-only" alt="A synchronous ask --wait investigation and write follow-up" width="760">
</div>

<br>

## Start

Install at least one coding agent CLI: authenticate Claude Code or Codex, or connect a provider
in Opencode. Install Node.js 18 or newer for the official ask agents. Then, in a project directory:

```sh
ask setup                                        # connect the coding agents you have
ask models                                       # choose an available agent:model id
id=$(ask -m claude:sonnet-5.5 "Why does the login test fail?")
ask wait "$id"                                   # block and print the answer
ask continue "$id" --wait -w "Fix it, then run the test."
```

The examples use Claude Code; choose a model from `ask models` for your installation. Use the
stable ID returned on stdout for `ask wait`, `ask show` and `ask continue`.
`-m` / `--model` selects a model or configured role; `-w` / `--write` allows edits and commands.
Runs are read-only by default.

With a default model configured in `ask settings`, use `ask "prompt"`, `ask run "prompt"`, or
pipe a prompt directly: `git diff | ask`. These launch detached work and print only its stable
run ID after admission. Exit 0 means accepted, not completed successfully. Add `--wait` to run
synchronously and return only the answer: `git diff | ask --wait`. Status and errors go to stderr.

`ask setup` finds supported coding CLIs and installs the agents you pick immediately.
It shows changes to defaults and app integrations before saving them. Each agent keeps its own
login; ask hands it the task and gives you the answer. See [official packages](packages/README.md)
for each harness's tools, access controls and continuation support.

<table>
  <tr>
    <td width="33%" valign="top">
      <b>Like a native subagent</b><br>
      Read-only by default, <code>--write</code> to edit files and run commands, <code>--worktree</code> for its own
      branch. <code>ask continue RUN "prompt"</code> follows up, inheriting model and access.
    </td>
    <td width="33%" valign="top">
      <b>Every model</b><br>
      <code>claude:opus-5.5</code>, <code>codex:gpt-6.1-sol</code>,
      <code>opencode:deepseek-4.1-flash</code>: one command, whichever agent runs it.
    </td>
    <td width="33%" valign="top">
      <b>Recorded and accountable</b><br>
      Every run is named and kept, with time, changes and usage when reported. Cost limits
      stop a run when reported cost exceeds its limit; a model call or step can take it over.
    </td>
  </tr>
</table>

## Many at once

`ask batch FILE` launches parallel tasks and returns one stable batch ID. Use
`ask wait ID` to collect results, or `ask batch --wait FILE` to return the result array synchronously.
`ask show ID` inspects current state immediately; `ask wait ID` blocks for completion.
For scripts, `ask runs --json` lists machine-readable state and `ask wait ID --json` returns
result data, including failures. Check the exit status: wait returns 1 for failed or stopped work.

`ask continue RUN "prompt"` launches a follow-up and returns its new stable ID; add `--wait`
for the answer. Without a prompt, it finishes stopped or failed work in a usable saved
conversation, otherwise restarts. Successful batch tasks stay untouched; auth,
refusal and cost blockers need an explicit prompt after resolution. Running work gets wait
guidance; completed runs require an explicit follow-up prompt.
`ask stop ID` cancels work; interrupting `ask wait` only stops waiting. See [Runs](docs/runs.md)
for lifecycle details and waiting for the first of several runs.

<p align="center"><img src="assets/screens/dark/batch.svg#gh-dark-mode-only" alt="A synchronous ask batch --wait review on three models" width="760">
  <img src="assets/screens/light/batch.svg#gh-light-mode-only" alt="A synchronous ask batch --wait review on three models" width="760"></p>

## See it before it saves

`ask settings` holds every control: agents and their models, defaults, cost limits, worktrees,
and the apps that use ask. Nothing is written until you have seen the change.

<p align="center"><img src="assets/screens/dark/settings.svg#gh-dark-mode-only" alt="ask settings showing each file's changes before saving" width="760">
  <img src="assets/screens/light/settings.svg#gh-light-mode-only" alt="ask settings showing each file's changes before saving" width="760"></p>

## Make it yours

<table>
  <tr>
    <td width="25%" valign="top"><b>Agents</b><br>Any CLI, through a small executable. The official ones are built in: <code>ask install claude</code>.</td>
    <td width="25%" valign="top"><b>Hooks</b><br>Change tasks and check results: add context, guard writes, run the tests and hand failures back.</td>
    <td width="25%" valign="top"><b>Commands</b><br>Your own <code>ask NAME</code> workflows, like a review by three models.</td>
    <td width="25%" valign="top"><b>Packages</b><br>Share all three: <code>ask install owner/repo</code>, kept up to date. Yours always win.</td>
  </tr>
</table>

Agents in Claude Code, Codex, Opencode, Cursor and pi can hand work to ask too: `ask setup`
gives them the ask skill, and Claude Code names each ask run in its task list.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh            # macOS and Linux
brew tap arocomputer/ask https://github.com/arocomputer/ask && brew install ask
go install github.com/arocomputer/ask/cmd/ask@latest             # Go 1.26 or newer
```

One binary, no additional UI runtime to install. `ask update` keeps a curl install current. Each agent needs its CLI
authenticated or a provider connected, and the official ones need Node.js 18 or newer. More in [Install](docs/install.md).

## Docs

Quick reference: `ask help`; command options: `ask help COMMAND`.

Built into ask: `ask docs` lists every page and `ask docs PAGE` shows one, offline and matching
your version.

| | |
| --- | --- |
| [Install](docs/install.md) · [Setup](docs/setup.md) · [Settings](docs/settings.md) | Getting ask and setting it up |
| [Usage](docs/usage.md) · [Runs](docs/runs.md) · [Batches](docs/batches.md) · [Bench](docs/bench.md) · [Models](docs/models.md) | Running tasks, following up, many at once, comparing models, cost limits |
| [Agents](docs/agents.md) · [Hooks](docs/hooks.md) · [Commands](docs/commands.md) · [Packages](docs/packages.md) | Extending ask |
| [Hosts](docs/hosts.md) · [Compatibility](docs/compatibility.md) | Other tools using ask, and what stays stable |

## Baymax

Baymax is ask's mascot and integration doctor. He checks packaged harnesses, writing behavior
and package lifecycle through the real ask binary. Run `./x baymax` from a checkout, or
`./x baymax copilot` for one harness. See [Baymax](docs/contributing/baymax.md) for coverage,
requirements and limitations.

<br>

<p align="center"><sub>MIT · <a href="https://github.com/arocomputer/ask">github.com/arocomputer/ask</a></sub></p>
