# ask docs

ask hands tasks to subagents. Agents send it JSON requests; people use a few commands to set it
up and look at what the subagents did. `ask -h` lists commands, `ask COMMAND -h` explains one,
and `ask -h requests` documents every request field. `ask -h environment` lists environment settings.

Close command and flag typos get a “Did you mean…?” suggestion. A flag in the wrong place names
the command it belongs to. Suggestions never execute anything; correct the command and run it
again. The older `ask help` and `--help` forms remain accepted aliases.

| Page | What it covers |
| --- | --- |
| [Install](install.md) | Getting ask, and where it keeps things |
| [Migration](migration.md) | Upgrading from Go, retained data, legacy sessions and rollback |
| [Settings](settings.md) | Providers and keys, your models, the default, `ask doctor` |
| [Requests](requests.md) | How agents use ask: starting, collecting, continuing and stopping tasks |
| [Sessions](sessions.md) | Turns, write tasks, worktrees, resuming, what the subagent is told |
| [Models](models.md) | Model names, the catalog, the three protocols, effort |
| [Harnesses and extensions](extensions.md) | Claude Code and Codex, `ask install`, the agent skill, writing an extension |
