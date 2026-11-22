# Code Mode evaluation — November 2026

## Where it stands

Seven tasks (two lookups, a symbol that doesn't exist, two fixes, a diff review and an
eight-file JSON join), three times each on two models, OpenCode Go's DeepSeek V4.1 Flash and
GLM-5.3-Flash: 42 runs an arm. Linux x64, Bun 1.4.5, 150 seconds a task, four tasks at a time,
one arm after another.

| Arm | Runs | Passed | Turns, mean · median | Input tokens, mean · median | Seconds, mean · median |
| --- | ---: | ---: | ---: | ---: | ---: |
| Direct tools (`45eeae9`) | 42 | 38 | 10.6 · 7.0 | 89,783 · 19,676 | 39.0 · 23.4 |
| Code Mode, first version (`9d26897`) | 42 | 40 | 7.6 · 5.5 | 39,530 · 16,739 | 26.0 · 18.6 |
| Code Mode, forgiving runtime, first run | 42 | 42 | 5.3 · 4.5 | 21,707 · 14,205 | 18.3 · 12.7 |
| Code Mode, forgiving runtime, second run | 42 | 42 | 6.5 · 5.0 | 35,983 · 14,966 | 24.0 · 13.4 |

**What holds:** the forgiving runtime passed 84 of 84, used fewer turns and tokens than the
first version in both runs, and against direct tools took fewer tokens on all seven tasks and
fewer turns on six.
**What doesn't:** the size of the saving. The two forgiving-runtime runs are the same runtime
(the second adds only error-path changes) and their means differ by 1.2 turns and 14k tokens,
because two tasks have long tails: DeepSeek hunting for the symbol that doesn't exist took
30 turns in one run and 6 in another. Medians barely move. Read the means as "lower", not as
a percentage.

By task, mean turns and mean input tokens, the two forgiving runs pooled:

| Task | Direct tools | First version | Forgiving runtime (12 runs) |
| --- | ---: | ---: | ---: |
| compose-rollout | 28.2 · 294k (2 of 6 passed) | 5.2 · 27k | 4.0 · 18k |
| discipline-missing | 12.3 · 125k | 15.0 · 101k (5 of 6) | 10.0 · 64k |
| locate-retries | 9.7 · 114k | 11.7 · 86k | 7.2 · 53k |
| locate-resume | 5.2 · 51k | 5.2 · 27k (5 of 6) | 5.9 · 38k |
| fix-tests | 8.0 · 20k | 6.2 · 13k | 4.9 · 10k |
| fix-feature | 6.7 · 16k | 6.5 · 15k | 5.8 · 13k |
| review-diff | 4.2 · 8k | 3.7 · 7k | 3.5 · 6k |

### What the transcripts showed

The steadier measure is what each script was spent on. In the first version, about one script
in six (50 of 284) went to something the runtime could have absorbed or explained:

| In 284 scripts | Count | Example |
| --- | ---: | --- |
| A field read from a result that was plain text | 20 | `return a.text`, `g.matches.map(...)`, `{ diff: d.stdout }` → `undefined`, `{}` or a TypeError |
| Nothing returned | 13 | `await tools.edit({ ... })` → `(no output)` |
| A tool refused the call | 13 | `git ls-files`; a RegExp passed as `pattern` |
| `console.log` | 3 | `ReferenceError: 'console' is not defined` |
| Other script error | 1 | |

Results were text unless a call passed `format: "json"`, and the catalog described the JSON
shape, so models read fields that weren't there. In a preliminary run, one lookup spent six
of its sixteen turns on that. The runtime now takes the script as the model writes it: every
result reads as text and carries the fields, `console.log` works, a script that returns
nothing shows what its calls returned, and errors name the line or the signature. The same
count in the two forgiving runs was 11 of 181 and 19 of 229 (6% and 8%), most of them git
subcommands the tool doesn't run: `git grep`, `ls-files`, `branch`, `ls-tree`, `tag`.
Once the catalog said console.log works, two scripts in three used it.

A third forgiving run tried catalog wording that steers models to return results whole
rather than their fields. It passed 41 of 42 at 6.8 turns and 32,542 tokens, inside the spread
of the two runs above, and answers cited `path:line` just as often either way, so the wording
stayed as first written.

HOLDOUT

### How to read this

- The runs came from a copy of the `subagents` runner that keeps whole transcripts. The suite's
  `--traces` now records each script and the start of its result, which is what this needed.
- The suite pins its "ask" tasks to commit `d3cd456`, which is on no branch, so those tasks
  only prepare from a clone that still has the object. That predates this work and needs a
  pin that a fresh clone can reach.
- compose-rollout's grader took `"F"` for service `f` as wrong. It now compares the letter
  without case, and every arm above was regraded from its saved answers the same way.
- Most input tokens were served from the provider's cache. Seconds depend on the provider's
  load and on timeouts (three direct-tool runs hit the 150-second limit).
- Two inexpensive models, three repetitions, seven tasks, no web tasks. The problems were found
  on these two models; the holdout above is the check that the fix isn't particular to them.
  This is not a comparison with any other harness's Code Mode.

## Earlier runs

These were one or two runs a case. Their reading that routine tasks cost more in Code Mode
(69% more input tokens over six cases) did not hold at 42 runs an arm, above.

### First comparison

Linux x64, Bun 1.4.5, same fixtures and graders for each arm. Direct tools ran from
`45eeae9`. The Code Mode arms used structured reads, then added compact tool signatures,
a one-call example, and clearer guidance for short and structured answers. Each arm ran
four fixed cases once on each of OpenCode Go's DeepSeek V4.1 Flash and GLM-5.3-Flash.
Arms ran separately with two concurrent jobs and a 90-second deadline per task.

| Result | Direct tools | Code Mode + structured reads | Tuned Code Mode |
| --- | ---: | ---: | ---: |
| Passed (of 8 started) | 6 | 7 | 8 |
| Wrong answers | 1 | 1 | 0 |
| Timeouts | 1 | 0 | 0 |
| Eight-file JSON join: passes | 0/2 | 1/2 | 2/2 |
| Six matched routine passes: mean model turns | 4.00 | 5.33 | 6.33 |
| Six matched routine passes: mean input tokens | 7,886 | 12,640 | 13,363 |
| Six matched routine passes: mean elapsed seconds | 9.60 | 13.30 | 17.34 |

The join is a read-only task: find each service's active revision in eight JSON histories
and aggregate the counts. Tuned Code Mode solved it in 4–5 model turns, 17.8–34.3k input
tokens, and 12.5–13.9 seconds. Direct tools used 10–11 turns and 59.6–61.5k reported input
tokens; one timed out and the other named the wrong service. The grader checked the three
JSON fields even when the answer added prose, and required the service identifier to match.

Both versions passed the routine prompt-injection, edit, and diff-review checks on both
models. **This is a quality gain on composition, not a general speedup.** On those six
routine cases tuned Code Mode used 69% more input tokens and took 81% longer on average.
One repetition per case is too small to establish a general pass-rate or performance change.
The next comparison should repeat the matched cases and inspect why small edits and reviews
take extra model turns before treating the routine overhead as acceptable.

Reproduce each arm from an exact committed checkout (omit `--ask` for the current checkout):

```sh
bun bench/run.ts run subagents --label NAME --ask CHECKOUT \
  --models opencode-go/deepseek-v4.1-flash,opencode-go/glm-5.3-flash \
  --tasks compose-rollout,discipline-injection,fix-dates,review-diff \
  --timeout 90 --reps 1 --parallel 2 --live
bun bench/run.ts compare subagents BASELINE CANDIDATE
```

### Traced review rerun

Two review repetitions per model using the same fixture (four reviews per arm). Both arms
passed all four. The earlier large review slowdown did not reproduce:

| Mean per review | Direct tools | Tuned Code Mode | With review recipe |
| --- | ---: | ---: | ---: |
| Model turns | 5.50 | 5.75 | 4.75 |
| Input tokens | 10,561 | 11,182 | 9,599 |
| Cached input tokens | 7,856 | 8,410 | 6,144 |
| Output tokens | 1,449 | 1,160 | 1,010 |
| Elapsed seconds | 16.84 | 14.24 | 13.75 |

The local action traces showed repeat `git status`, overlapping diffs, and history lookups
after the changed code was visible. Some direct-tool runs did similar work. In a local
probe, 14 warm confined evaluator launches with a single mock tool took 66 ms median on
this host. The probe does not include real file tools, but points at choosing fewer model
turns before optimizing the evaluator.

The review recipe tells the model to start with the requested diff and inspect only what a
finding still needs. It also passed all four reviews. Nested `git status` calls dropped from
seven to four. Mean input fell 14% versus tuned Code Mode, but the improvement came from
GLM; DeepSeek used more input in this sample. Cached token counts differed across runs, so
lower total input here does not establish lower billed cost. This is still one review fixture,
not a comparison with OpenCode or proof of a general improvement.

As a check on showing the recipe everywhere, a separate two-model run on the JSON join and
date fix passed 3/4 with the global recipe versus 4/4 without it. The miss was an uppercase
service ID in the join answer, not a wrong tally, and one repetition cannot attribute it to
the recipe. The candidate therefore includes the recipe only for likely diff reviews
with Git enabled. This keeps the exact evaluated recipe for reviews and the original prompt
for those two other tasks.

### First pilot

One `subagents` run per arm on Linux x64 with Bun 1.4.5 and
`opencode-go/deepseek-v4.1-flash`. The baseline was `45eeae9`; the candidate used
Code Mode as the only tool interface, with the same pinned repositories and graders.
Both runs hit a five-minute wall cap and were incomplete (four baseline rows and ten
candidate rows, all passed). Compare only the cases that completed in both arms:
`locate-proxies`, `locate-resume`, `locate-retries`, and `locate-sandbox`.

| Matched cases | Direct tools | Code Mode |
| --- | ---: | ---: |
| Passed | 4/4 | 4/4 |
| Mean model turns | 9.5 | 10 |
| Mean input tokens | 177,963 | 134,852 |
| Mean output tokens | 4,815 | 3,361 |
| Mean elapsed seconds | 98.25 | 70.71 |

This is an early signal for token use, not a release-grade performance comparison: one model,
one run, only locating tasks in the overlap, completion bias from the deadline, and overlapping
runs that could contend for the provider. It says nothing about write or web-task performance.
Before release, rerun both arms independently with enough time to finish and more than one model.

### Discovery footprint

A separate local check with 50 synthetic extension tools and the eight built-in write-task tools
reduced the initial catalog from 50,082 bytes with every definition inline to 7,872 bytes with
discovery. That measures prompt bytes only: it does not count later discovery queries, infer token
counts, or show how much discovery improves task performance.
