# Settings

`ask settings` is where you change ask: your agents and their models, your defaults, where
worktrees go, and what the apps you work in know about ask.

## In a terminal

```text
ask settings  ~/.ask

What do you want to change?
› Agents           claude, codex, opencode
  Model roles      {} (default)
  Defaults         claude:sonnet-5.5 · no cost limit · edited
  Worktrees        ~/code/worktrees/ask-{name}
  Apps             ask skill in 5 of 5 apps · task titles on
  Review and save  1 change
  Done
  ↑↓ move · type to filter · enter select
```

Nothing is written while you edit. Changes are marked `edited`, and **Review and save** shows
exactly what will change, file by file, before it asks:

```text
~/.ask/settings.json  +1 -1
  "timeout": 900
  "timeout": 1800

1 file changed, 1 insertion(+), 1 deletion(-)

Save these changes?
  Y/n · enter to confirm
```

Removed lines sit on a red band and added ones on a green band, under a bar naming each file
with its counts. Leaving with unsaved changes asks whether to save them. Ctrl-C discards them.

Prompts use an inline Bubble Tea interface with bold primary text and muted hints, using your
terminal's background and foreground. Lists adapt to the terminal size.

Text fields support left/right, Home/End, deletion and bracketed paste. Pasted newlines become
spaces rather than submitting. `NO_COLOR` disables styling. Completed answers remain in terminal
scrollback.

- **Agents**: install or remove an official agent, choose which of its models are on, and set
  their cost limits. `ask settings NAME` opens one directly, like `ask settings opencode`.
- **Model roles**: optional names such as `fast`, `deep` and `review`, each pointing directly to
  an exact `agent:id[#effort]`. Add or select one to edit it; enter `-` as its target to remove it.
  See [Model roles](models.md#model-roles).
- **Defaults**: the model when you don't give `-m`, the cost limit, the timeout and batch jobs.
- **Worktrees**: where worktrees go, their branch names, and whether writes always use one.
- **Apps**: the ask skill for each app that reads skills, and task titles in Claude Code.

## From scripts and agents

```sh
ask settings get                       # every setting, defaults marked
ask settings get model
ask settings get roles --json
ask settings set roles '{"fast":"claude:haiku-4.5","deep":"codex:gpt-6.1-sol#high"}'
ask settings set model fast
ask settings get --json                # the values that apply
ask settings set max_cost 2            # shows what changes, then saves
ask settings set worktree on           # require a worktree for writes
ask settings set worktrees '~/code/worktrees/ask-{name}' --dry-run
ask settings unset model               # back to the default
ask settings set hook on
ask settings set skills all
```

`set` and `unset` print the same review on stderr; `--dry-run` stops there. Without a terminal,
`ask settings` prints `get`, and `ask settings NAME` prints that agent's models with on or off.

Saving exits 1 if any package removal, installation/readiness check, settings or models write,
hook edit, skill write or saved-state reload fails. Independent operations are still attempted.
Successful changes stay applied, so a failed save can be partial.

Errors identify the failed parts, and the interactive session does not report “saved” for an
incomplete apply. The same failure handling applies to `ask setup --yes`.

## settings.json

Your defaults are in `~/.ask/settings.json` (or `$ASK_HOME/settings.json`). Every key is optional;
without the file, ask uses the built-in defaults below.

```json
{
  "model": "claude:sonnet-5.5",
  "timeout": 1800,
  "max_cost": 2,
  "jobs": 6,
  "worktree": true,
  "worktrees": "~/code/worktrees/ask-{name}",
  "branches": "ask/{name}"
}
```

| Key | What it sets | Built in |
| --- | --- | --- |
| `model` | The exact model or configured role when neither `-m`, a batch task, nor a follow-up gives one | none: `-m` is required |
| `roles` | Your names mapped directly to `agent:id[#effort]` strings; see [Model roles](models.md#model-roles). No built-in roles or automatic routing | `{}` |
| `timeout` | Seconds a task may run, unless `-t` or the task says otherwise | `900` |
| `jobs` | Batch tasks at once, unless `-j` says otherwise | `4` |
| `max_cost` | Dollars a task may spend before ask stops it, unless `--max-cost` or the model's own limit in [models.json](models.md#modelsjson) says otherwise; `0` for none (see [Cost limits](usage.md#cost-limits)) | none |
| `worktree` | Require every write task to use a Git worktree; refuse hook-routed in-place writes | `false` |
| `worktrees` | Where `--worktree` puts a run's worktree: an absolute or `~` path, or a path inside the repository like `.ask/worktrees/{name}`, whose last part holds `{name}` once | `~/.ask/worktrees/{name}` |
| `branches` | The branch of a run's worktree, holding `{name}` once | `ask/{name}` |

`{name}` is the run's name, like `add-rate-limiting-login`, or `NAME-POSITION-TASK` for a batch
task. With the example above, `ask --write --worktree "Add rate limiting to login"` works in
`~/code/worktrees/ask-add-rate-limiting-login` on branch `ask/add-rate-limiting-login`.

A relative path is inside the repository the run starts in, at its main checkout even from a
linked worktree. `.ask/worktrees/{name}` puts that run in `.ask/worktrees/add-rate-limiting-login`
there. Add `.ask/worktrees/` to the repository's `.gitignore`.

`ask settings set` also takes `hook` (`on` or `off`) and `skills` (`claude-code`, `codex`,
`opencode`, `cursor`, `pi` or `all`), which live in those apps' own files. An unknown key or a
value of the wrong kind is an error that names the key, so a typo never silently does nothing.

`set roles` takes a JSON object and replaces the entire map; `unset roles` removes it. The terminal
menu edits one role at a time. Both show the usual review before saving. Unknown roles fail when
used; the default `model` may name a role.

Existing records keep their values. A new follow-up inherits the recorded model and access, and
reuses a kept worktree's recorded path and branch even after `worktrees` or `branches` changes.
When the earlier run kept no worktree, its follow-up creates one using the current settings.

Resuming an older saved follow-up without a recorded path and branch still needs its original
worktree directory and branch settings. A new `ask continue RUN "prompt"` uses the saved result's
location.
