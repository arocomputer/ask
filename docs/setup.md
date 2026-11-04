# Setup

`ask setup` sets ask up the first time: it connects the coding agents you have, sets your defaults,
and teaches the apps you work in to use ask. Change anything later with
[`ask settings`](settings.md).

Before setup, install and authenticate the coding agent CLIs you want to use. For example,
authenticate Claude Code or Codex, or connect at least one provider in OpenCode. See
[official packages](../packages/README.md) for each harness's prerequisites. The official ask agents also need
Node.js 18 or newer. Setup installs ask's agents and integrations; it does not install those
CLIs or Node.js, or sign you in. See [Install](install.md#set-up).

## The first time

In a terminal, `ask setup` walks you through it, then shows everything it will change before it
saves defaults or app integrations. Selected agents install immediately; the example below
illustrates a machine with Claude Code and Codex:

```text
ask setup  connects your coding agents; nothing else changes until you review it

✔ Which coding agents should ask use? claude, codex
✔ claude is ready: 4 models, see ask models
✔ codex is ready: 8 models, see ask models
✔ Default model, when you don't give -m claude:sonnet-5.5
✔ Where should --worktree runs work? Somewhere else
✔ Folder for each worktree, with {name} ~/code/worktrees/ask-{name}
✔ Teach these apps to use ask Claude Code
✔ Show ask runs by model and task in Claude Code's task list? Yes

~/.ask/settings.json new  +4
  {
    "model": "claude:sonnet-5.5",
    "worktrees": "~/code/worktrees/ask-{name}"
  }

~/.claude/settings.json  +12
  ...

~/.claude/skills/ask/SKILL.md new  +16
  16 new lines

3 files changed, 32 insertions(+)

? Save these changes? (Y/n)
```

- **Agents** are the official ones for the CLIs it finds, built into ask; they install as you pick
  them and are checked at once. The [packages list](packages.md) includes Copilot, Gemini CLI,
  Pi, e, Cursor, Aider, Amp, Goose, Cline, Kilo, Continue, OpenHands, Qwen Code, Kimi Code and
  Mistral Vibe, alongside Claude, Codex and OpenCode. OpenCode detects v1 or v2 automatically.
  Each agent's page states its feature limits.
- **Defaults** go to your [settings](settings.md): the model, and where worktrees go.
- **The ask skill** goes to each app that reads skills and is installed here: Claude Code, Codex,
  Opencode, Cursor and pi. It teaches focused delegation when useful: provide the goal, context,
  constraints and expected evidence, use independent tasks for parallel work, and review the
  results. It leaves small, tightly coupled steps to the host agent and does not require Ask
  instead of another delegation tool. Examples use existing commands, explicit stdin context,
  and saved raw answers for structured failure recovery.
- **Task titles** register `ask title --hook` in Claude Code (see [Hosts](hosts.md)).

Saying no saves nothing but the agents. Once ask is set up, `ask setup` opens your settings.

## Without a terminal

```sh
ask setup --yes            # the recommended setup: agents for the CLIs found, skills, task titles
ask setup --check          # exit 1 if no agent is ready or any installed agent cannot run
ask setup --check --json
```

`--yes` shows what it changes as it saves; it leaves your default model unset unless you
already chose one. Use `-m` or `ask settings set model MODEL`, replacing `MODEL` with an id from
`ask models`. Readiness checks ask agents to list models; they do not run a task or verify that
your account can use each model. `--check --json` prints `agents` (each with `name`,
`cli`, `installed`, `ready`, `models` and `reason`), `settings`, `skills` (by app: `missing`,
`current`, `outdated` or `yours`) and `hook`. Without a terminal or options, `ask setup` prints the
report.

## What it changes

Only what you choose. ask's own files go in `~/.ask`. The skill is `skills/ask/SKILL.md` in each
app's folder, like `~/.claude/skills/ask/SKILL.md`; ask updates the ones it wrote and never
replaces a skill you wrote (it marks its own with a comment line; delete that line to keep your
edits). The hook is one entry in `~/.claude/settings.json`; everything else in that file stays as
it is, in the same order.
