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

`bench/callers.ts` measures the other side: Claude Code, Codex and OpenCode given four fixture
jobs, three that request delegation and one that doesn't. None names ask. It grades the
outcome separately from the route: direct ask, via the hook, native subagents, mixed, or self.

| Arm | What the agent gets |
| --- | --- |
| `none` | ask on `PATH`, nothing else: the control |
| `skill` | ask's skill as a project skill, so only its description is in context until loaded |
| `deny` | the skill, with built-in subagents turned off |
| `hook` | no skill: a prototype in `bench/hook.ts` redirects native calls for Claude Code and OpenCode |

The agents run on your own sign-ins, with three changes: an ask skill you installed is hidden
(Claude Code's `skillOverrides`, Codex's `skills.config`, OpenCode's project skill and
permissions); your Claude Code user settings and Codex config aren't loaded
(`--setting-sources project,local`, `--ignore-user-config`); and built-in subagents are on unless
the arm turns them off. Claude Code gets the arm's skill or hook as a temporary plugin
(`--plugin-dir`). Claude Code and Codex don't save their sessions; OpenCode archives its sessions.
Ask uses a scratch home, your cached catalog and your OpenCode Go key (`auth.json` or
`OPENCODE_API_KEY`). The callers are Claude Code on Sonnet, Codex on its default model, and
OpenCode on `opencode-go/deepseek-v4.1-flash`; ask defaults to `opencode-go/glm-5.3`.

```sh
bun bench/callers.ts --ask . --label smoke --reps 1 --jobs parallel-questions   # 11 runs
bun bench/callers.ts --ask . --label must
bun bench/callers.ts --ask . --label soft --arms skill,deny --skill bench/soft.md
bun bench/callers.ts --compare must soft
```

Use a fresh label for each batch. `--drivers`, `--jobs` and `--arms` select subsets; `--lanes`
defaults to one to limit provider contention. The benchmark spends quota and runs real agents
with access to local tools; use it on the scratch fixtures, not as a sandbox for hostile work.
Answers and raw caller events stay in `bench/.runs/` and should not be shared without checking
their contents. The report separates caller errors from grading failures. Its usage columns
are caller-reported totals, including cached input where reported. They aren't peak context
size, end-to-end tokens, or a bill. Missing cost data is shown as `-`.

### Caller pilot, November 2026

Two repeats of the three explicit-delegation jobs. These are routing counts from the pilot,
not predictions for other models or more difficult tasks:

| Caller | Native/control | Current skill | Soft skill | Hook only |
| --- | --- | --- | --- | --- |
| Claude Code | Native 6/6 | Ask 6/6 | Native 6/6 | Redirected to ask 6/6 |
| Codex `exec` | Self 6/6 | Ask 6/6 | Ask 6/6 | No native call to intercept |

Claude Code and Codex passed all four fixture jobs in those runs, including the
non-delegation job. In the pinned Go rerun, OpenCode chose native subagents in 6/6 control
delegation runs, ask in 4/6 with the current skill, and ask in 6/6 with the skill and native
subagents denied. The softened skill wasn't rerun on the pinned model. Some hook traces
straddled a benchmark edit, so use the final-version smoke test instead: all three native
calls were redirected to ask and all three questions were answered correctly.

Don't pool the original metered OpenCode runs (which hit quota) with the pinned Go rerun,
which used a different model. Shared-provider rate limiting caused retries and extra calls
in several arms; don't use the pilot to rank latency or cost.

Keep the skill as the portable default: the stronger description changed Claude Code's
routing, and a hook cannot help when the caller never tries a native subagent. The Claude
Code and OpenCode hooks are benchmark prototypes only. An opt-in hook or a small MCP
interface could reduce shell round trips; MCP and Pi weren't benchmarked.

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
characters); Codex passed 6 of 6 with both. Those caller runs predate the arms: the jobs named
ask, the skill sat in the system prompt, and Claude Code had no Agent tool to choose instead.

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
