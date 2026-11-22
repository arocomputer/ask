# Code Mode evaluation — November 2026

## PR comparison

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

## Earlier pilot

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

## Discovery footprint

A separate local check with 50 synthetic extension tools and the eight built-in write-task tools
reduced the initial catalog from 50,082 bytes with every definition inline to 7,872 bytes with
discovery. That measures prompt bytes only: it does not count later discovery queries, infer token
counts, or show how much discovery improves task performance.
