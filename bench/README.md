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

`bench/callers.ts` measures the other side: Claude Code and Codex, given work to hand off,
with a version of ask's skill in their instructions (never installed), graded on the outcome
and on how they delegated: sessions, whether they started together, how much their task
prompts said.

```sh
bun bench/callers.ts --ask . --skill SKILL.md --label mine [--drivers claude,codex] [--reps N]
bun bench/callers.ts --compare old mine
```

## Results, November 2026

ask's own loop, 15 tasks × 3 runs, before → after the new prompt and the git tool:

| | Passed | Review | Steps | Input tokens | Seconds | Answer chars |
| --- | --- | --- | --- | --- | --- | --- |
| GLM-5.3 | 43 → 45 of 45 | 1 → 3 of 3 | 8.1 → 6.5 | 73k → 41k | 41 → 25 | 2460 → 1697 |
| MiniMax-M3 | 42 → 45 of 45 | 1 → 3 of 3 | 8.6 → 6.6 | 112k → 104k | 24 → 15 | 2537 → 1785 |

Reviews failed before because read-only tasks couldn't see the diff at all. Claude Code
(haiku) and Codex were near the ceiling both ways (22/22, 28/30). Reading long pages in 16k
pieces brought web tasks from 269k input tokens to about 140k, at one more step. Callers, 3
jobs × 2 runs: with the new skill Claude Code passed 6 of 6 (4 with the old, which sent a
fix to a worktree and left the user's files broken) and wrote fuller task prompts (271 → 390
characters); Codex passed 6 of 6 with both.
