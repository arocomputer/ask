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
curl -fsSL https://fschrhunt.com/ask/install.sh | sh
```

  <img src="assets/screens/dark/run.svg#gh-dark-mode-only" alt="ask answering why a test fails, then fixing it in the same conversation" width="760">
  <img src="assets/screens/light/run.svg#gh-light-mode-only" alt="ask answering why a test fails, then fixing it in the same conversation" width="760">
</div>

<br>

## Start

Install at least one coding agent CLI: authenticate Claude Code or Codex, or connect a provider
in Opencode. Install Node.js 18 or newer for the official ask agents. Then, in a project directory:

```sh
ask setup                                        # connect the coding agents you have
ask models                                       # choose an available agent:model id
ask --model claude:sonnet-5.5 "Why does the login test fail?"
ask --continue login-test-fail --write "Fix it, then run the test."
```

The examples use Claude Code; choose a model from `ask models` for your installation. Use the
run name or id printed by the first run for `--continue` (names can have a numeric suffix or be set by a hook).

`ask setup` finds supported coding CLIs and installs the agents you pick immediately.
It shows changes to defaults and app integrations before saving them. Each agent keeps its own
login; ask hands it the task and gives you the answer. See [official packages](packages/README.md)
for each harness's tools, access controls and continuation support.

<table>
  <tr>
    <td width="33%" valign="top">
      <b>Like a native subagent</b><br>
      Read-only by default, <code>--write</code> to change files, <code>--worktree</code> for its own
      branch. <code>ask --continue RUN</code> follows up in the same conversation.
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

`ask batch` runs tasks in parallel, on one model or several, each in its own worktree if you
like, and prints every answer as one JSON array. Start runs in the background and use
`ask wait` to collect the next one that finishes, or `ask show RUN` for a completed run.

<p align="center"><img src="assets/screens/dark/batch.svg#gh-dark-mode-only" alt="ask batch running a review on three models at once" width="760">
  <img src="assets/screens/light/batch.svg#gh-light-mode-only" alt="ask batch running a review on three models at once" width="760"></p>

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
curl -fsSL https://fschrhunt.com/ask/install.sh | sh            # macOS and Linux
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

<p align="center"><sub>MIT · <a href="https://fschrhunt.com/ask">fschrhunt.com/ask</a></sub></p>
