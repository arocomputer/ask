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

**What holds:** on these two models the forgiving runtime passed 84 of 84, used fewer turns and tokens than the
first version in both runs, and against direct tools took fewer tokens on all seven tasks and
fewer turns on six.
**What doesn't:** the size of the saving. The two forgiving-runtime runs are the same runtime
(the second adds only error-path changes) and their means differ by 1.2 turns and 14k tokens,
because two tasks have long tails: DeepSeek hunting for the symbol that doesn't exist took
30 turns in one run and 6 in another. Medians barely move. Read the means as "lower", not as
a percentage. On two other models there was no gain to see; that section is below.

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

### Two other models: no gain

The runtime was fixed against transcripts from DeepSeek and GLM, so the same seven tasks ran
twice each on two models it had not seen, OpenCode Go's MiniMax M3.1 Flash and MiMo V2.6 Flash,
28 runs an arm:

| Arm | Passed | Turns, mean · median | Input tokens, mean · median | Scripts spent on runtime mistakes |
| --- | ---: | ---: | ---: | ---: |
| Code Mode, first version | 21 | 10.4 · 8.5 | 116,895 · 37,993 | 65 of 356 (18%) |
| Code Mode, forgiving runtime | 21 | 11.3 · 8.0 | 125,119 · 33,424 | 34 of 412 (8%) |

The mistakes the runtime absorbs fell by half here too, and three provider errors went away
(MiMo had sent scripts with tool-call markup still attached, which the runtime now strips).
Neither showed up as passes or turns. Every failure in the forgiving arm was the 150-second
limit: MiMo timed out on lookups after 5 to 11 turns, which is the provider's speed, and MiniMax
kept gathering evidence it didn't need (twenty turns of blame, history and Python's sqlite3
documentation to review a two-file diff). On these models the turns go to wandering, not to
script errors, and a forgiving runtime doesn't change that.

MiniMax's diff review was the one cell that looked worse with the forgiving runtime (two
timeouts in two runs, against none before), so it ran six more times on each arm: the first
version passed 4 of 6 at 13.7 turns, the forgiving runtime 6 of 6 at 9.3. The two-run cell was
noise, which is also the caution for everything else in this section: 28 runs an arm on models
this slow against a 150-second limit can't separate a small effect from none.

### A real repository, four models

The tasks above are small fixtures. These six run on a private Go project (258 files, pinned
with `git archive`): two lookups that need several files, a symbol that doesn't exist, a
count over 33 JSON files, a review of a diff with three planted bugs, and a failing
`go test` to fix. Each ran three times on Claude Haiku 5.5, GPT-6 Luna, DeepSeek V4.1 Flash
and GLM-5.3-Flash through OpenCode Go, 72 runs an arm, 240 seconds a task. The tasks and
transcripts stay outside this repository because the source is private.

| Arm | Passed | Turns, mean · median | Input tokens, mean · median | Scripts spent on runtime mistakes |
| --- | ---: | ---: | ---: | ---: |
| Direct tools (`45eeae9`) | 67 | 7.4 · 5.5 | 81,158 · 33,493 | |
| Code Mode (`f457e5f`) | 67 | 6.1 · 6.0 | 40,644 · 32,132 | 34 of 365 (9.3%) |
| Code Mode (`6dd9abd`) | 70 | 5.9 · 5.0 | 42,944 · 29,017 | 10 of 356 (2.8%) |
| Code Mode (`ddf5071`) | 68 | 5.4 · 5.0 | 39,000 · 32,271 | 7 of 323 (2.2%) |

| Model, mean turns · input tokens | Direct tools | `f457e5f` | `6dd9abd` | `ddf5071` |
| --- | ---: | ---: | ---: | ---: |
| Claude Haiku 5.5 | 5.1 · 48k | 4.0 · 28k | 3.9 · 29k | 3.2 · 23k |
| GPT-6 Luna | 4.3 · 28k | 5.5 · 40k | 4.7 · 30k | 3.9 · 29k |
| DeepSeek V4.1 Flash | 14.4 · 216k | 8.7 · 67k | 8.8 · 79k | 8.7 · 68k |
| GLM-5.3-Flash | 5.8 · 33k | 6.1 · 28k | 6.1 · 34k | 5.9 · 35k |

Code Mode halves the mean input and passes as often. The gain in turns is DeepSeek's and
Claude's; GLM is level, and GPT-6 Luna, which already batches its direct calls in one turn,
started behind direct tools and ended level with them. The medians of the two interfaces are
close: most of the difference in means is DeepSeek's long direct-tool runs. Passes differ by
no more than three in 72, which these counts can't tell apart.

The first Code Mode run is what the second was built from. Its transcripts showed four more
things the runtime was costing:

- A `list` result was text, so `for (const f of files)` walked its characters and
  `files.length` counted them, and its paths were relative to the directory listed, not to
  where `read` resolves them. It is now the array of its paths, from the working directory.
- `return r.content` and `return r.matches` dropped the line numbers the answer needs. GPT-6
  Luna read six files that way and spent two more turns finding the lines again. A field
  returned whole now shows the result itself.
- `"handler\("` in a JavaScript string is `handler(`, an invalid pattern, and a
  `(?i)` anywhere but the start was one too. `grep` now takes the flag anywhere and searches
  for the text of a pattern it cannot compile, saying so.
- A script used a variable from an earlier script. The error now says scripts start fresh.

The count over 33 files is where a script should win, and it does: all five values were right
in 23 of 24 runs on the last two arms at 3.7 turns, against 9 of 12 at 4.3 with direct
tools, where the model adds by hand. The one miss printed all 33 files and counted by eye.
The pass counts above grade that task on its values; a third of the Code Mode answers
(8 of 24) also added prose to an answer asked for as JSON only, six of them DeepSeek's, which
did the same with direct tools.

**The review is where Code Mode may be behind.** GPT-6 Luna found all three planted bugs in 8
of 11 direct-tool reviews and 9 of 23 Code Mode reviews, missing the same one each time after
reading the same files. That is not a settled difference at these counts (p ≈ 0.14), and the
other three models found all three bugs in every review either way. Dropping the catalog's
review recipe did not explain it: over 24 reviews an arm, Luna passed 4 of 6 with the recipe
and 5 of 6 without, and the recipe saved the four models 0.8 turns and 13k tokens a review.

### Something that isn't there

Asked where a function that doesn't exist is defined, every model kept going for five to
eight turns after two searches had found nothing: other spellings, the file tree, git
history. The empty `grep` said "try a shorter pattern, another spelling, or a wider path",
which is advice to keep looking. Two changes were tried on that task, on the real repository
(24 runs an arm, with an ordinary lookup beside it as a check, another 24) and on this
suite's own version of it (16 runs an arm), on the four models above:

| Arm | Missing symbol, real repository | Missing symbol, this suite | Ordinary lookup |
| --- | ---: | ---: | ---: |
| `6dd9abd` | 7.9 turns · 41k tokens | 8.0 · 44k | 5.0 · 49k |
| An empty `grep` says how many files it searched | 6.1 · 27k | 8.1 · 38k | 4.9 · 48k |
| And the briefing says an empty whole-directory search is the answer | 5.1 · 21k | 4.7 · 20k | 4.6 · 46k |

Every run in every arm passed. The `grep` message alone helped where the name appears nowhere;
in this suite the name survives in git history, which the models went on to read, and only
the briefing line stopped that. Both shipped, as `ddf5071`.

A line that says finding nothing is an answer could make a model give up on something that
is there, so that commit ran every task again. On the real repository it is the last row of
the table above: 23 of 24 lookups passed, and the one that didn't was a provider reply with
no text. On this suite's seven tasks, DeepSeek and GLM passed 42 of 42 at 5.4 turns and
24,191 tokens, level with the best earlier run, and the symbol that isn't there took 8.0
turns against 12.5 and 7.5 in the two runs before. On MiniMax and MiMo it passed the same 21
of 28, every failure but one the 150-second limit, at 9.1 turns and 86,731 tokens against
10.4 and 116,895 for the first version: lower, on 28 runs, and still not a gain in passes.

### A requested format

The briefing lays out the final message (the answer, then the evidence) and, further down,
says to follow the caller's format. Asked for JSON only, DeepSeek gave the JSON and then the
evidence. With the exception moved into the layout's first line ("unless the task asks for a
particular format"), the count task on the real repository came back as JSON alone in 23 of
24 runs against 18 of 24, DeepSeek's in 6 of 6 against 1 of 6, with the values right in 23
of 24 either way. A task that asks for JSON without saying "only" still gets its evidence
from three models of four, with or without the change.

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
- Thirteen tasks on two repositories, six models, no web tasks. Each fix was found in one
  run's transcripts and measured on a later run of the same tasks, not on tasks held back
  from it. This is not a comparison with any other harness's Code Mode.

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
