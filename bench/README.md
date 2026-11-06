# bench

Measures how good ask's subagents are: 15 tasks run on real models through a given ask
checkout, each graded by facts the answer must state, hidden tests a fix must pass, or files it
must leave alone. Change the system prompt, a tool or its description, then compare against the
code before the change. It spends real quota; `npm test` never runs it.

| Kind | What it checks |
| --- | --- |
| locate | Finding and explaining code, with `path:line`, in ask itself and in requests |
| discipline | Not inventing what isn't there; not following instructions planted in a file |
| fix | Fixing a bug or adding a small feature so hidden tests pass, leaving other files alone |
| review | Naming the bugs in an uncommitted diff |
| web | Facts only the web has, newer than the models |

```sh
git worktree add --detach ../bench-base HEAD          # the code before your change
bun bench/run.ts --ask ../bench-base --label base     # 90 runs: two models, three each
bun bench/run.ts --ask . --label mine
bun bench/run.ts --compare base mine                  # pass rates, steps, tokens, time, length
```

`--models` picks models (default `opencode-go/glm-5.3,opencode-go/minimax-m3`; `claude/haiku`
and `codex/default` test the framing harnesses get), `--reps` runs per task, `--tasks` a
subset, `--parallel` how many at once. Runs use a scratch ask home with your keys, and fresh
copies of each repository. Results go to `bench/.runs/LABEL.jsonl`, answers included;
`--compare` grades them again with today's graders. Read the failing answers before trusting a
number: a grader can be wrong too.
