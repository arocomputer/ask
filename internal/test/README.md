# Tests

ask's behavior, tested from the outside: each test runs the real `ask` binary in a temporary home
and checks what a person or a script would see (stdout, stderr, exit codes, files on disk). No
test calls a model or the network. They need Go, git and a POSIX shell.

```sh
./x test                                                  # everything
./x test ./internal/test -run 'TestRuns'                  # one feature
./x test ./internal/test -run 'TestRuns/stop_ends_a_run'  # one behavior
```

## One file per feature

Each file holds one `TestX`, a list of subtests that read as plain sentences, and matches the
docs page for that feature.

| File | Covers | Docs |
| --- | --- | --- |
| `run_test.go` | Launching: IDs, `--wait`, prompts and stdin, the default model, `--json`, failures, timeouts, `-C`, `--schema` | usage.md |
| `harness_test.go` | The native loop: the tools and their limits, read-only, changes, events, cost, transcripts and turns, the project's instructions, the request shape, reasoning replay, credentials | usage.md, sessions.md |
| `sessions_test.go` | Scoping by parent and repository, origin, turns, `sessions`, waiting without IDs, `show`, `stop`, a dead worker | sessions.md |
| `worktree_test.go` | `--worktree`, the `worktree` key, later turns in the worktree, `clean` | usage.md, sessions.md |
| `extensions_test.go` | The harness contract; extension tools, notes and commands; broken manifests; `install`, `remove`, `extensions` | extensions.md |
| `config_test.go` | `config`, the home layout created only when used, `models.json`, `setup`, `help` and `version` | config.md, models.md, setup.md |
| `openai_test.go` | The fake OpenAI server | |
| `main_test.go` | `TestMain`, which builds ask and the fake harness once, and the helpers | |

A new behavior goes in its feature's file as one more `t.Run("what it does", ...)`. A new file is
for a new feature.

## The harness

`fresh(t)` gives a test its own `HOME` and `ASK_HOME`, a fake OpenAI endpoint as
`OPENAI_BASE_URL`, and the fake harness installed as the extension `fake`. From there `s.ask(args...)` runs ask,
`s.run(args, stdin, env)` adds input and environment, `s.launch(args...)` returns a session ID,
`s.record(id)` reads its `session.json` with the latest turn laid over it, `s.in(dir, args...)` runs in a directory, `s.repo()` makes a
committed repository, and `s.calls()` lists what the fake harness was called with.

## The fake provider

`openai_test.go` serves the OpenAI Responses API from the test process and scripts each model
turn from the prompt, one directive per line:

| Directive | The turn |
| --- | --- |
| `call NAME {json}` | Calls tool NAME; the next turn sees its output |
| `answer TEXT` | Answers TEXT |
| `fail CODE MESSAGE` | The API reports an error |
| `slow` | Takes two seconds |
| none | Answers `echo: ` plus the prompt's last line and any tool outputs |

Every turn reports usage of 100 input tokens (20 cached) and 10 output tokens, so cost tests can
check exact prices. `s.provider.requests()` returns every request body ask sent.

## The fake harness

`fake/main.go` speaks the harness contract with no model. It answers `fake: ` plus the prompt's
last line, reports usage of 10 in, 5 out, 2 cached and $0.01, and records every call. Environment
variables change what it does:

| Variable | Effect |
| --- | --- |
| `FAKE_ANSWER` | Answer with this text instead |
| `FAKE_FAIL`, `FAKE_HANG`, `FAKE_SLOW`, `FAKE_SPEND` | When the prompt contains the value: fail, hang, take 300ms, or report $3 spent and hang |
| `FAKE_WRITE=file=text` | Write a file in the working directory |
| `FAKE_COMMIT` | Commit everything |
| `FAKE_EXIT` | Exit with this code after answering |
| `FAKE_NOTE`, `FAKE_NO_USAGE` | Report a note, or no usage |
| `FAKE_IGNORE_TERM` | Ignore SIGTERM, so ask has to kill it |
