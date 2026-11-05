<p align="center">
  <b>Subagents for your agents.</b> One request hands tasks to subagents that read, search and
  edit your project in the background, and returns their answers.
</p>

<p align="center">
  <a href="https://github.com/arocomputer/ask/releases/latest"><img src="https://img.shields.io/github/v/release/arocomputer/ask?style=flat-square&color=f2611d&label=release" alt="Release"></a>
  <a href="https://github.com/arocomputer/ask/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/arocomputer/ask/ci.yml?branch=main&style=flat-square&color=f2611d&label=ci" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f2611d?style=flat-square" alt="MIT"></a>
</p>

```sh
curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh
ask settings
```

## For agents

An agent sends one JSON request on stdin and reads one JSON response on stdout:

```sh
ask <<'EOF'
{"start": [{"prompt": "Where is the retry logic?"}, {"prompt": "List the API routes"}], "wait": 100}
EOF
```

```json
{"tasks": [
  {"id": "k3f9a2", "state": "succeeded", "answer": "The retry logic is in src/client/retry.ts:14 ..."},
  {"id": "p0q8zz", "state": "running", "activity": "grep router in src"}
]}
```

`start` returns once the first task finishes, or right away without `wait`. `collect` waits for
more, `continue` gives a finished session its next prompt or resumes a stopped one, `stop` stops
one, and `show` lists its steps. A task can `write`, and work in its own git `worktree` and
branch. Every response is small, and an error says what to send instead. `ask help requests` is
the reference; [docs/requests.md](docs/requests.md) explains it.

## For people

```sh
ask settings      # providers, keys, your models and the default
ask doctor        # check that ask can run tasks, and how to fix what can't
ask models        # the models you can use
ask sessions      # what subagents did, newest first
ask show k3f9a2   # one session's steps and answer
```

## How it works

ask runs its own agent loop and talks to the model directly. The [models.dev](https://models.dev)
catalog says how to reach each model: OpenAI's Responses API, chat completions (most providers
and gateways) or Anthropic's Messages API. Read-only means the subagent is given no tool that can
write or run a command. Each turn runs in a background worker and saves its transcript after
every step, so a worker stopped partway resumes where it left off.

<table>
  <tr>
    <td width="33%" valign="top">
      <b>Made for agents</b><br>
      One JSON request starts many tasks and returns the first answer. Results are small, and
      errors and hints say what to do next.
    </td>
    <td width="33%" valign="top">
      <b>Safe by construction</b><br>
      A read task has no tool that can write or run a command. A write task can work in its own
      worktree, and every change it makes is listed.
    </td>
    <td width="33%" valign="top">
      <b>Small</b><br>
      TypeScript with no runtime dependencies, on Node 24 or Bun. No daemon, no configuration
      beyond a model and its key.
    </td>
  </tr>
</table>

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/arocomputer/ask/main/install.sh | sh     # macOS and Linux
brew tap arocomputer/ask https://github.com/arocomputer/ask && brew install ask
npm install -g @arocomputer/ask                                                      # Node 24 or newer
```

The installer and Homebrew put one self-contained binary on your `PATH`. As a library,
`import { handle } from "@arocomputer/ask"` takes the same requests as the command line.

## Docs

`ask help` is the reference. The pages in [docs/](docs/README.md) cover [installing](docs/install.md),
[settings](docs/settings.md), [requests](docs/requests.md), [sessions](docs/sessions.md) and
[models](docs/models.md).

<br>

<p align="center"><sub>MIT · <a href="https://github.com/arocomputer/ask">github.com/arocomputer/ask</a></sub></p>
