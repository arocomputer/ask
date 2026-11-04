# Tests

ask's behavior, tested from the outside: each test runs the real `ask` binary in a temporary home
against a fake agent, and checks what a person or a script would see (stdout, stderr, exit codes,
files on disk). No test calls a model or the network.

The documented review-command test uses `jq` and skips when it is not installed; the other
Go tests need only Go, git and a POSIX shell.

```sh
./x test                                    # everything, including internal/ unit tests
./x test ./test -run 'TestRuns'             # one feature
./x test ./test -run 'TestRuns/stop_stops'  # one behavior
./x baymax                               # packaged harnesses, offline through real ask
./x baymax copilot                        # Copilot only
./x baymax copilot pi                     # Copilot and Pi, checked separately
```

## Local latency (opt-in)

With Go and dependencies already cached, run offline from the repository root:

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off ./x test ./test -run '^$' \
  -bench '^BenchmarkLatency$' -benchtime=10x -count=5
```

Each row reports mean wall time in `ns/op` (divide by 1,000,000 for milliseconds) over ten
sequential invocations; `-count=5` repeats each measurement five times. `startup` runs `ask help`
through exit without an agent. `task` runs `ask --model fake:small --read --timeout 10 hello`
through the real task lifecycle: agent discovery/startup, prompt and report exchange, fake call
logging, answer/status output and saved run results. Both include process launch, pipe capture
of stdout/stderr and waiting for exit. Completion and the saved answer are checked afterward.

`TestMain` builds ask and the existing fake once, before timing. Temporary home/agent setup,
run/log reset between invocations, validation and cleanup are untimed. Each task starts with no
saved runs, in a disposable directory outside git. No user settings, hooks, live models or
network are used; update checks are disabled. The task is representative of ask's read-only
execution path, not model reasoning or coding work. Git/worktrees and interactive terminal
rendering are not measured. OS caches are not flushed, and filesystem writes are not forced to
durable storage. Compare repeated runs on the same machine under similar load; these are local
observations with no latency pass/fail threshold. Normal tests and `./x check` do not run them.

## One file per feature

Packaged harness checks are owned by [Baymax](../docs/contributing/baymax.md), in
`test/baymax/`. It replaces the old `./x node` package loop (now an alias), shares adapter-test
process/report plumbing, and tests installed packages through the real binary using simulators.
It requires no vendor CLIs, credentials or running agents. Harness-specific assertions and
fake CLI protocols stay in `packages/NAME/test/`.

Each file holds one `TestX`, a list of subtests that read as plain sentences, and matches the
docs page for that feature.

| File | Covers | Docs |
| --- | --- | --- |
| `run_test.go` | One task: options, prompts, answers, `--json`, `--schema`, timeouts, signals | usage.md |
| `batch_test.go` | `ask batch`: task files, defaults, parallel results, `--resume` | batches.md |
| `bench_test.go` | `ask bench`: every task on every model, checks, worktrees, the report | bench.md |
| `latency_test.go` | Opt-in local startup and fake-task end-to-end timings | this page |
| `runs_test.go` | Saved runs: `runs`, `show`, `wait`, `stop`, `clean`, locks, private state | runs.md |
| `names_test.go` | Run names: from the prompt, taken over by follow-ups, name hooks | runs.md |
| `followups_test.go` | `-c`: which session, model and access a follow-up gets | runs.md |
| `git_test.go` | What write runs report from git, and `--worktree` | usage.md |
| `environment_test.go` | Agent inheritance, adapter declarations, integration refusals and hook preservation | environment.md |
| `agents_test.go` | The agent contract: stdin, environment, schema files, reports | agents.md |
| `models_test.go` | `models.json`, model roles and discovery, models on and off, cost limits | models.md |
| `hooks_test.go` | Task and result hooks: order, refusals, follow-ups, failing open | hooks.md |
| `commands_test.go` | Your own `ask NAME` commands and the documented large-diff review example | commands.md |
| `packages_test.go` | `ask install` (including package updates), `remove`; official agents; refused sources | packages.md |
| `setup_test.go` | `ask setup`: its report, exit status and flags | setup.md |
| `settings_test.go` | `settings.json` and `ask settings`: review, save, bad values | settings.md |
| `title_test.go` | `ask title` and the host hook | hosts.md |
| `help_test.go` | `ask help`, help aliases, command pages, one-line errors, suggestions | usage.md |
| `docs_test.go` | `ask docs`, and that every help footer names a real page | |
| `update_test.go` | `ask update`, against a local stand-in for GitHub releases | install.md |
| `compat_test.go` | Released run records and the contract version | compatibility.md |
| `main_test.go` | `TestMain`, which builds ask and the fake once for tests and benchmarks, and the helpers | |

A new behavior goes in its feature's file as one more `t.Run("what it does", ...)`. A new file is
for a new feature.

## The harness

`fresh(t)` gives a test its own `HOME` and `ASK_HOME` with the fake agent installed as `fake`.
From there:

- `s.ask(args...)` runs ask; `s.run(args, stdin, env)` adds input and environment; `s.start`
  returns the running process for signal tests.
- `s.calls()` lists what the fake was called with (stdin, cwd, model, access, session);
  `s.runFile` and `s.latest` read the saved run.
- `s.repo()` makes a committed git repository; `s.localAgent`, `s.script` and `s.hook` install
  shell agents, commands and hooks.
- `eq`, `match`, `obj`, `objects` and `runID` check output.

## The fake agent

`fake/main.go` speaks the agent contract with no model. It answers `fake: ` plus the prompt's last
line, reports usage of 10 in, 5 out and $0.01, and records every call when `FAKE_LOG` is set (the
harness sets it). Environment variables change what it does:

| Variable | Effect |
| --- | --- |
| `FAKE_ANSWER` | Answer with this text instead |
| `FAKE_FAIL`, `FAKE_HANG`, `FAKE_SLOW`, `FAKE_SPEND` | When the prompt contains the value: fail, hang, take 300ms, or report $3 spent and hang |
| `FAKE_WRITE=file=text` | Write a file in the working directory |
| `FAKE_COMMIT` | Commit everything |
| `FAKE_EXIT` | Exit with this code after answering |
| `FAKE_NOTE`, `FAKE_NO_USAGE` | Report a note, or no usage |
| `FAKE_IGNORE_TERM` | Ignore SIGTERM, so ask has to kill it |

## Fixtures

`fixtures/run-*` are run records written by released versions of ask. `compat_test.go` checks the
current ask can still show, list and continue them. They are never rewritten: a release that
changes the record format adds a new one.
