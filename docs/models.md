# Models

A model id is `agent:id`, with an optional `#effort`:

```text
claude:sonnet-5.5
claude:sonnet-5.5#high
codex:gpt-6.1-sol
```

- **agent** names the executable in `~/.ask/agents/` or an installed package that ask runs (see
  [Agents](agents.md)).
- **id** is the model as the agent names it. By convention that is the lowercase family,
  version and variant, like `gpt-6.1-sol` or `sonnet-5.5`, never an alias like `latest` (see
  [Naming models](agents.md#naming-models)). Ids ignore case: ask lowercases them, so
  `claude:Sonnet-5.5` is `claude:sonnet-5.5`, with its `models.json` entry.
- **effort** is passed to the agent, which passes it on in its CLI's own form. Supported
  values depend on the model and CLI; ask does not validate them.

## Model roles

Optionally give exact models your own names in `~/.ask/settings.json` (or
`$ASK_HOME/settings.json`):

```json
{
  "roles": {
    "fast": "claude:haiku-4.5",
    "deep": "codex:gpt-6.1-sol#high",
    "review": "claude:sonnet-5.5#high"
  },
  "model": "fast"
}
```

These names are your choices: ask supplies no roles and never routes a task automatically.
Use a role anywhere a run, batch task or benchmark accepts a model:

```sh
ask --model fast "Explain this function"
ask --model deep "Investigate the failure"
ask continue RUN --model review "Review the fix"
ask batch tasks.json --model fast
ask bench tasks.json --model fast --model deep
ask models --roles
```

`ask models --roles` prints `name<TAB>agent:id[#effort]`, sorted by role name, with lowercase
model ids. It reads settings without calling agents, so it also lists roles whose agents are
missing or whose models are off.

Existing `ask models`, `--all` and `--names` output is unchanged. Roles are listed only with
`--roles`, which takes no other flags or model arguments.

Edit roles through **Model roles** in `ask settings`, or replace the map from a script:

```sh
ask settings set roles '{"fast":"claude:haiku-4.5","deep":"codex:gpt-6.1-sol#high"}'
ask settings get roles --json
ask settings set model fast
ask settings unset roles
```

`set roles` replaces the whole map, so include every role you want to keep; use `--dry-run` to
review without saving. The terminal menu adds, edits and removes individual roles.

**Defaults** can choose a role as the default model. Removing a role used by `model` requires
choosing a new default or unsetting `model` before starting a task without `--model`.

Names must match `[a-z][a-z0-9_-]*`: lowercase ASCII letters, digits, underscores and hyphens,
starting with a letter. Targets must be direct `agent:id[#effort]` strings, with no spaces and at
most one `#`.

Duplicate names, uppercase names, malformed targets and role-to-role references are errors; chains
and cycles are not supported. Multiple names may point to the same model. There are no effort
overrides such as `fast#high`; define a role with that effort instead.

Roles resolve before tasks are saved. Task and result records, hooks and agent calls receive the
concrete model and effort, so editing or removing a role cannot change a saved run's model.

Follow-ups inherit the recorded model unless you explicitly choose another, and must keep the same
agent even when the override is a role. Reruns keep the recorded model. Benches deduplicate roles
and exact specifications that resolve to the same model and effort, and record that specification
in their reports.

A role respects the target's enabled state and cost limit in `models.json`; an explicit task or
command cost limit still takes precedence. A follow-up inherits a positive recorded limit before
looking at the target model's limit or your current default. Roles have no separate budget. Manage
enabled state and model limits with the concrete `agent:id`, not a role.

Saving roles checks syntax without requiring installed agents or querying model catalogs. Running a
role requires its agent to be installed and its model to be on.

As with exact model specifications, ask cannot verify account availability, provider-side aliases
or supported effort values; those remain the agent's responsibility.

## Listing

```sh
ask models          # the models that are on
ask models --all    # every model, on or off
```

```text
claude:sonnet-5.5
claude:haiku-4.5
codex:gpt-6.1-sol
```

ask calls each agent with `models` to get its list. The official Claude Code agent has a built-in
list; Codex reads its local model cache; OpenCode queries `opencode models`.

Listing a model does not verify that your account can use it. Every model is on until you turn it
off.

`ask models --names` prints `agent:id<TAB>Display Name`, and `--all` in a pipe prints
`agent:id<TAB>on` or `off`. At a terminal, `ask models` groups each agent's ids with their names
and cost limits. `ask help` is a compact command overview and does not discover models.
`NO_COLOR` removes styling.

## Turning models on and off

Turn off what you don't use, so `ask models` and the agents that pick from them see only
the rest:

```sh
ask settings opencode                               # pick in a list you can filter
ask models codex:gpt-6.1-sol opencode:gpt-4o --disable
ask models codex:gpt-6.1-sol --enable
```

A model that is off is refused: `-m codex:gpt-6.1-sol` says it is off and how to turn it on.

## models.json

Your choices are in `~/.ask/models.json`, by agent: the models you turned off, the ones you added,
and the ones with their own cost limit. Ids ignore case; a file naming one id twice in different
case is refused.

Everything else is on, so the file stays short and never copies the whole catalog. Models you
explicitly add stay even if the agent does not list them; `ask models --all` combines the agent's
list with those additions.

```json
{
  "claude": {
    "opus-5.5": { "enabled": true, "max_cost": 10 },
    "sonnet-5": true
  },
  "opencode": {
    "gpt-4o": false,
    "gpt-4o-mini": false
  }
}
```

`false` turns a model off. `true` adds a model the agent doesn't list, like `sonnet-5`, an older
Claude model. An object sets `enabled` and `max_cost`, its own [cost limit](usage.md#cost-limits).

`ask settings NAME` writes the file for you, as do `ask models MODEL --enable`,
`ask models MODEL --disable` and `ask models MODEL --max-cost USD`. Replace `MODEL` with an
`agent:id` and `USD` with a dollar amount; `--max-cost 0` clears the model limit and uses your
default. You can also edit the file.

The older form, a list of ids per agent (`{"opencode": ["glm-5.3-flash"]}`), still works and adds
those models. Adding an id does not make a model available to the underlying CLI or account. If the
file exists it must be valid JSON; mistakes name the agent and model.

## Names in output

Status lines and results use the model's own name, not its id. ask takes the first of:

1. the name the agent reports for the run (`Opus 5.5`, from what Claude Code says it ran);
2. the name the agent lists next to the id (`GPT-6.1 Sol`, from Codex's model list);
3. the id in title case (`glm-5.3-flash` becomes `Glm 5.3 Flash`).

Effort is appended: `Sonnet 5.5 (high)`.
