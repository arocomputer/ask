# Upgrading from the Go version

This release changes the command and extension interfaces. Upgrade in place without moving or
deleting existing data. Keep the previous executable if you need to finish an old conversation.
Do not run both versions against the same conversation or edit their shared settings concurrently.

## Sessions and worktrees

- New sessions live in `~/.ask/sessions`; new worktrees in `~/.ask/worktrees`.
- Old sessions, native transcripts, locks, worktrees and extensions remain in `~/.ask/agent`.
  Custom worktree locations also remain where they were. `ASK_HOME` changes the common root.
- `ask legacy` lists old sessions. `ask legacy ID` prints the original session record;
  `ask legacy ID --transcript` prints the original native transcript. These commands never
  rewrite or resume old sessions. A malformed record is reported and retained.
- Resume old conversations with the previous executable. To use an old checkout with the new
  engine, first stop its old worker, then start a new task with `dir` set to that checkout and
  supply the relevant earlier context. Do not copy native transcripts into new sessions:
  provider and harness transcript formats differ.

## Settings and authentication

Back up `config.json` and `auth.json` before editing them. The existing `model`, `timeout` and
provider `api_key`/`base_url` fields are reused. Model names still use `provider/model`.
No credentials are imported from another coding agent.

The old `max_cost`, `worktree`, `worktrees` and `branches` settings are not implemented by the
new engine. Tasks refuse to start while any of those fields is present, rather than silently
ignoring a spending or isolation constraint. Remove them explicitly after reviewing the change:

- Use `worktree: true` on write task requests that need a separate checkout. There is no global
  worktree requirement or custom naming template in this release.
- There is no dollar budget enforcement. `timeout` bounds time, not spending.
- Models are discovered from models.dev; old custom `models.json` declarations are retained but
  not loaded. Use provider credentials/endpoints in `auth.json` and a catalog model, or port a
  custom backend to a new extension.

The sandbox defaults to enabled, with config-only `"sandbox": false` as an opt-out. It does not
change a task's read/write tool selection. See [settings](settings.md#sandbox).

## Commands and extensions

Agents now send JSON requests on stdin; `ask -h requests` is the contract. Old `run`, `wait`,
`stop`, `continue` and batch CLI forms are replaced by the corresponding request operations.
Run `ask install skill` to update supported callers' instructions.

Go-era executable extensions are retained but never automatically executed or converted. Port
them to the documented JavaScript [extension interface](extensions.md), then explicitly install
them. Install the shipped harnesses individually with `ask install claude` and `ask install codex`.

## Cleanup: retain work, never guess

Automatic `ask clean` is deliberately removed in this release. This replaces main's #82 cleanup
implementation with a stronger retention rule: ask does not delete sessions, worktrees or branches
at all. Neither a launch race nor landed/contained/superseded heuristics can remove work. Old
`ask clean --yes`, `--contained` and `--superseded` invocations fail without deleting anything.

Review finished work with `git worktree list` and the session record. After stopping all workers
using a checkout and integrating its changes, explicitly remove that checkout with
`git worktree remove PATH` (without `--force`); Git refuses dirty or locked worktrees. Keep the
branch and session transcript for review. Never use recursive deletion of `~/.ask` as cleanup.
If using the previous executable's clean command, use a version containing #82 or later.

## Rollback

Stop new workers before switching executables. Restore backed-up configuration if necessary.
Old sessions and worktrees remain available to the old executable; new sessions remain available
when you return to this version. Neither version can resume the other's transcript format.
