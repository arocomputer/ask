# ask docs

These pages are built into ask: `ask docs` lists them and `ask docs PAGE` shows one, matching the
ask you have. ask hands a task to a coding agent you already use and gives you its answer. These pages cover
everything it does. Replace example model ids with ones from `ask models`, and run names with
the names or ids printed by your runs.

| Page | What it covers |
| --- | --- |
| [Install](install.md) | Getting ask, adding an agent, and checking it works |
| [Setup](setup.md) | Setting ask up the first time, and checking it |
| [Settings](settings.md) | Agents, defaults, cost limits, worktrees and apps, in a terminal or by key |
| [Usage](usage.md) | One task: read and write, what changed, worktrees, JSON answers, output |
| [Runs](runs.md) | Run names, follow-ups, listing, waiting, stopping and cleaning up runs |
| [Batches](batches.md) | Many tasks in parallel, recorded runs, resuming |
| [Bench](bench.md) | Comparing models on the same tasks, scored by your own checks |
| [Models](models.md) | Model ids, effort, turning models on and off, and models.json |
| [Environment](environment.md) | Per-agent inherited variables, integration opt-in and actual limits |
| [Agents](agents.md) | Reaching a coding agent: the contract, read-only, and examples |
| [Hosts](hosts.md) | Background command titles and a Claude Code hook |
| [Hooks](hooks.md) | Changing tasks and checking results: verify, guard, add context |
| [Commands](commands.md) | Your own `ask NAME` workflows, like a review by several models |
| [Packages](packages.md) | Sharing agents, hooks and commands, and keeping them up to date |
| [Compatibility](compatibility.md) | The contracts ask keeps across releases |

Quick reference and local models: `ask help`. Contract details: `ask help batch`,
`ask help hooks`, `ask help agents`.

`ask docs PAGE --url` prints the page's GitHub URL on current main; that web page may differ
from the version bundled with your installed ask.
