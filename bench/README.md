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

`bun bench/compact.ts provider/model` runs a small real-model compaction evaluation. It forces
an overflow and checks the continuation for the objective, constraint, decision and reason,
next file, blocker and interrupted action. It prints the answer, usage and elapsed time; inspect
the answer as well as the simple checks. This spends quota and is not run by `npm test`.
One isolated run on `opencode-go/glm-5.3` passed all six checks in 22.9 seconds (1,969 input,
2,049 output tokens, including 20 cached input). The answer also stated that the interrupted
write's outcome was unknown and should be checked. This single synthetic run is not a comparison
against uncompacted context or evidence of reliability across models and tasks.

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

## Sandbox and extraction follow-up

`bun bench/sandbox.ts --files 10000 --reps 10` creates disposable repositories with five nested
repositories and measures fresh policy discovery, environment preparation, a confined process,
and actual read/write tools. Each operation warms once, then reports p50/p95 in milliseconds.
It makes no model calls and does not cache metadata discovery.

November 6, 2026, Bun 1.4.4, 10,000 files / 1,000 directories, ten samples:

| Host | Write policy p50 | Read tool p50 | Write tool p50 |
| --- | ---: | ---: | ---: |
| Debian 13, Linux 6.12, x64 | 20.560 ms | 30.152 ms | 54.050 ms |
| macOS 27.2, arm64 | 85.291 ms | 40.583 ms | 126.563 ms |

These are two different machines, not an OS comparison or a statistical performance guarantee.
Keep fresh write-policy discovery: metadata created during a turn must be protected by the next
file tool. No caching optimization is justified by these small measurements alone.

`bun bench/extract.ts --model provider/model --helper provider/model --reps 3` spends model quota.
Four synthetic documents cover late facts, conflicting versions, missing values and embedded
instructions. It uses production text conversion and extraction, exact factual grading, and
reports latency and token usage including helper calls. `raw-paged` supplies all pages together:
it is a direct-text baseline, not a simulation of iterative fetching or network latency. Extraction
variants pass the extracted evidence to the main model. Variants run concurrently per fixture;
provider scheduling and the 700-token final-answer budget can affect results.

One run with `opencode-go/glm-5.3` and helper `opencode-go/glm-5.3-flash`, three repetitions:

| Variant | Correct | Median seconds | Total input + output tokens |
| --- | ---: | ---: | ---: |
| Direct text (all pages) | 12/12 | 1.594 | 39,779 |
| Same-model extraction | 9/12 | 4.186 | 45,101 |
| Smaller-helper extraction | 7/12 | 7.179 | 46,154 |

Failed answers reported incomplete extraction/generation. This run does not establish general
model quality or a benefit from helpers; keep raw fetching available. Tokens are cost proxies,
not billed dollars. This benchmark does not compare ask against native subagents.
