# Compatibility

What you build on ask keeps working when ask updates. These are the contracts ask keeps, and how
they may change.

## The contracts

| Contract | Where it is described |
| --- | --- |
| The command line: a launch prints the session ID; `wait` and `--wait` print the answer; `--json` prints the result record. Exit 0 admitted or succeeded, 1 failed or stopped, 2 usage error | `ask help`, [Usage](usage.md) |
| Piped status lines start with `ask ID · state ·`; piped `ask sessions` is tab-separated without a header | [Usage](usage.md#output), [Sessions](sessions.md) |
| The result record's fields | [Sessions](sessions.md#the-result-record) |
| Event records and `--after` pages | [Sessions](sessions.md#inspecting-a-session) |
| `session.json` in `~/.ask/agent/sessions/STAMP-ID/` | [Sessions](sessions.md#where-sessions-live) |
| `config.json`, `auth.json` and `models.json` | [Config](config.md), [Models](models.md) |
| `ASK_PARENT`, and the host session variables ask reads | [Sessions](sessions.md#whose-sessions) |
| `extension.json` and the harness contract, `ASK_CONTRACT=4` | [Extensions](extensions.md) |

## How they change

- **Additions are allowed.** New record fields, report fields, environment variables, event
  types and options can appear in any release. Ignore what you don't know.
- **A breaking change bumps the contract version.** Every harness gets `ASK_CONTRACT`, now `4`.
  A change that could break one changes that number and is called out in the changelog.
- **Session records stay readable** within a major version. ask 2 does not read the runs
  ask 1 wrote; its sessions start fresh in `~/.ask/agent/sessions/`.

JSON uses Go's `encoding/json`: records keep the documented field order, and insignificant
whitespace is not a contract.

## From ask 1

ask 2 is a rewrite. Launches, `wait`, `show`, `continue`, `stop`, `clean`, `models` and
`setup` keep their names and meaning, and so do `-w`, `-m`, `-C`, `-t`, `--worktree`,
`--schema`, `--stdin`, `--wait` and `--json`. What changed:

- `ask runs` is `ask sessions`, and a follow-up is a new turn in the same session, with the
  same ID, rather than a new run.
- `ask settings` is `ask config`, and `settings.json` is `config.json`.
- A model is `provider/model` or `harness:model`, no longer `agent:model`.
- Agents, user commands and packages are one thing: [extensions](extensions.md), folders in
  `~/.ask/agent/extensions/` with an `extension.json`, installed from a folder or git.
- Sixteen bundled agents are gone; Claude Code and Codex remain as built-in extensions.
- Gone without a replacement: run names (use IDs), batches (launch each task and `wait` for
  several), hooks, model roles, `environment.json`, `ask title`, `ask bench`, the settings
  screen, `ask update` and `ask docs`.
