# Benchmarks

```sh
bun bench/run.ts list
bun bench/run.ts plan callers --reps 1 --jobs parallel-questions    # 9 cases, no model calls
bun bench/run.ts run callers --label baseline --reps 1 --jobs parallel-questions --live
bun bench/run.ts run callers --label candidate --ask ../candidate --reps 1 --jobs parallel-questions --live
bun bench/run.ts compare callers baseline candidate
```

| Suite | What it measures | Suite options |
| --- | --- | --- |
| `subagents` | Ask's own loop on pinned repo tasks: locating, reviewing, fixing and finding evidence | `--models provider/model,...`, `--tasks id,...` |
| `callers` | Whether Claude Code, Codex and OpenCode choose ask, native delegation or neither; also grades the answer | `--arms none,skill,deny`, `--drivers claude,codex,opencode`, `--jobs id,...`, `--skill FILE`, `--opencode free\|go` |
| `compaction` | Which task-critical facts survive a forced context overflow | `--model provider/model` |
| `extraction` | Exact answers from raw text, same-model extraction and a separate helper model | `--model provider/model`, `--helper provider/model` |
| `sandbox` | Local policy, process and file-tool overhead; no network or model calls | `--files N` (also measures a 100-file fixture) |

`--reps` repeats cases; `--parallel` defaults to one to limit provider contention. Sandbox
and compaction run their measurements serially. Live suites require `--live`, spend
quota, and are not run by `npm test`. `--ask` defaults to the checkout hosting the
runner. Commit the code under test before running: the runner copies the committed
`src/`, `native/` and `package.json` to scratch, including when you test another checkout.

## Files and isolation

- `suites/` contains the runners; `fixtures/` holds shared repository tasks, graders,
  and the alternative skill. `reports/` contains dated results that are worth keeping.
- `list`, `plan`, and `compare` make no writes or network calls. `run` writes disposable
  copies, profiles and repos, and saves `manifest.json` and `results.jsonl` under
  `.runs/SUITE/LABEL/`. Use a fresh label for each run. Fix jobs write only to their
  scratch repos. Do not use these runners as a sandbox for untrusted tasks or checkouts.
- Live runs seed scratch profiles from available ask, Claude Code and Codex credential
  files, not from personal settings or sessions. Scratch profiles cannot renew your
  sign-in: start with fresh access tokens or API keys. Keychain-only sign-ins may
  not work in scratch. OpenCode uses a standalone
  instance with scratch state. Its Go caller and ask worker use the Go key available to ask.
- Results include answers and should be kept private. For caller diagnostics, opt into
  raw events with `--traces`; don't share raw events without checking their contents.

## Reading results

The manifest records the tested revision, a hash of the suite and fixture/grader code,
model selections, workload, repetition count, concurrency and host runtime. The suite
hash does not include the tested ask revision, which is expected to vary. Exact model
IDs can still point to updated weights upstream. `compare` reads saved grades, flags incompatible or incomplete
runs, and never calls a model or regrades an answer.

Caller presets use Claude Haiku 5.5, Codex on GPT-6 Luna, and DeepSeek V4.1 Flash Free in
OpenCode. DeepSeek Flash is a practical free coding default, not a claim that it wins
every task. Free OpenCode models are only available through OpenCode itself. If free
usage runs out, start a separately labeled batch with `--opencode go` for DeepSeek V4.1
Flash on Go. There is no automatic paid fallback or mixing of models within a batch.
Ask's worker and the `subagents` suite default to that Go model. To measure GPT-6 Luna
directly, set `--models chatgpt/gpt-6-luna` (ChatGPT plan) or `--models openai/gpt-6-luna`
(metered API key). Check current availability before scheduling large runs.

Rows report errors separately from grading failures. Errored cases do not contribute
to usage or timing averages. In caller runs, `none` exposes no
ask integration beyond `PATH`, `skill` adds the skill, and `deny` adds the skill and
turns native subagents off. Caller token counters are not peak context or total tokens
including delegated work. Sandbox reports warmed p50/p95 timings, not quality grades.

Older flat JSONL files in `.runs/` are left in place, but are not used for manifest-backed
comparisons. See the [caller pilot](reports/2026-11-callers.md) and the
[earlier loop and tool measurements](reports/2026-11-loop.md).
