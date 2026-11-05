# Commands

A command is an executable in `~/.ask/commands/` that you run as `ask NAME`. Commands are for
workflows: a review by three models, a council that weighs their answers, a triage of open issues.
When they call ask to run tasks, those tasks are recorded runs you can show and follow up.

```sh
ask review HEAD~3..HEAD
ask council "Should we move the parser to a separate package?"
```

## The contract

- `ask NAME ARGS...` runs `~/.ask/commands/NAME ARGS...` (or a [package's](packages.md)), with your
  terminal's stdin, stdout and stderr. The command replaces ask, so it receives terminal signals
directly and supplies the exit status.
- The command gets `ASK_BIN`, the path of the running ask binary with symlinks resolved, so it calls the same ask; plus
  `ASK_HOME` and `ASK_CONTRACT` (see [Compatibility](compatibility.md)).
- A line containing `ask-command: TEXT` near the top of the file is its description in `ask help`.
- ask's own commands (`run`, `continue`, `wait`, `batch`, `show`, `runs`, `models`, ...) always win over yours of the same name.
  To run a prompt that starts with a command's name, use `ask run --model claude:sonnet-5.5 "review"`
  or put `--` first: `ask --model claude:sonnet-5.5 -- review`.

The examples need `jq` and the listed models (choose replacements from `ask models`). Create
`~/.ask/commands/` first (`mkdir -p ~/.ask/commands`), save each script at the path in its
comment and make it executable.

## Example: a review by several models

```sh
#!/bin/sh
# ~/.ask/commands/review: three models review a range of commits; prints their findings.
# ask-command: review commits with several models, read-only
range="${1:-HEAD~1..HEAD}"
diff=$(git diff "$range") || exit 1
for model in claude:opus-5.5 codex:gpt-6.1-sol opencode:glm-5.3-flash; do
  printf '%s' "$diff" | jq -Rsc --arg model "$model" --arg range "$range" \
    '{id: $model, model: $model, prompt: ("Review this diff for " + $range + ". List real bugs only, with file and line.\n\n" + .)}'
done | "$ASK_BIN" batch --wait - | jq -r '.[] | "## \(.name)\n\(.answer // .error)\n"'
```

```sh
chmod +x ~/.ask/commands/review
ask review main..HEAD
```

The script supplies the diff because Claude Code and OpenCode read runs cannot execute
`git diff`. It feeds the diff to `jq` on stdin to avoid command-line argument size limits.

Each command example prints results through `jq`; its exit status is `jq`'s, so inspect failures
in the output rather than treating exit 0 as success for every task.

## Example: a council

```sh
#!/bin/sh
# ~/.ask/commands/council: three models answer, then one weighs their answers.
# ask-command: ask three models, then have one weigh their answers
answers=$(for model in claude:opus-5.5 codex:gpt-6.1-sol opencode:deepseek-4.1-flash; do
  printf '{"model": "%s", "prompt": %s}\n' "$model" "$(printf '%s' "$*" | jq -Rs .)"
done | "$ASK_BIN" batch --wait - | jq -r '.[] | "### \(.name)\n\(.answer // .error)"')
printf 'Question: %s\n\nThree answers follow. Weigh them and give the best answer, noting where they disagree.\n\n%s' "$*" "$answers" |
  "$ASK_BIN" --wait -m claude:opus-5.5 -
```
