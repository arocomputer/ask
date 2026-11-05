# Integration

The offline integration suite needs Go, Node.js and git. It runs with simulated CLIs in
temporary homes, without API keys, installed coding CLIs or a running agent.

```sh
./x integration               # every bundled harness
./x integration copilot       # Copilot only
./x integration pi            # Pi only
./x integration copilot pi    # Copilot and Pi, checked separately
./x check                     # includes integration
```

`./x integration` is the runner's only command; the old `baymax` and `node` commands have been
removed. Formatting, vet, shellcheck and architectural guards remain separate checks.

## What it protects

The runner executes package-specific adapter assertions and builds the real ask binary to test
installed packages in temporary homes against deterministic CLI/protocol simulators. This
checks the boundary between ask and its packaged agents, rather than only calling adapters
with hand-written environment variables. Failures and unknown package selections exit nonzero.

| Check | What it protects |
| --- | --- |
| Packaged harnesses | Installation, answers, usage, sessions, access/refusal and error propagation for every bundled adapter |
| Package lifecycle | Shipped resources and executable launchers, stale-package refresh, preservation of user overrides and safe removal |
| Environment policy | Declared defaults versus explicit restrictions, exact inheritance, provider auth paths, user overrides and visible limitations through installed adapters |
| Writing | Actual file changes in a disposable project, read/write propagation, follow-ups, batches and worktree isolation using a controlled agent |
| Shutdown | Timeouts and `ask stop` terminate the controlled agent and its descendants rather than leaving work running |
| Test plumbing | Bounded subprocesses, isolated environments and report parsing, with helper regression tests |

Selecting harness names limits the adapter and package lifecycle suites. Shared writing,
shutdown and helper checks still run: they protect ask itself, independent of which vendor CLI
was selected. Multiple names select separate harness suites, not running agent sessions.

The runner and shared test plumbing live in `src/test/integration/`. Harness-specific assertions and
simulators remain in `packages/NAME/test/`; integration profiles describe the small
amount of configuration needed to drive each simulator through ask. No harness-specific
production behavior goes into `src/`.

The runner deliberately disables Go module downloads while building; install the repository's Go
dependencies beforehand if the module cache is empty. No developer credentials are passed to
simulated harness processes. Test homes, project files and installed packages are temporary.

## Adding or changing a harness

1. Add focused adapter assertions beside its package, using the shared process and report
   helpers rather than copying a subprocess runner.
2. Base simulator output on upstream source, documented schemas or sanitized captured output;
   link the source and supported versions in the package README. Never include credentials or
   personal session data in fixtures.
3. Add the harness's integration profile so the runner can install and run it through ask. Keep
   access restrictions, model selection and unsupported capabilities explicit.
4. Run `./x integration NAME`, then `./x check` before proposing the change.

## Honest boundary

A pass means compatibility with the simulated contracts and behaviors covered by the tests.
It does **not** prove that today's installed vendor CLI, authentication or live provider works,
or that vendor permission enforcement is correct. That requires separate real-CLI verification.
The runner does not download CLIs, call providers or silently turn offline checks into paid tests.
Existing fixtures remain simulators, not independently captured upstream recordings.

The optional Claude check is separate from the offline suite:

```sh
ASK_TEST_CLAUDE_BIN=/absolute/path/to/claude node --test packages/claude/test/environment-cli.test.mjs
```

It runs the real executable in a disposable home against local HTTP API/MCP fixtures, using
only fake credentials. It verifies config-defined auth, project instructions, SessionStart hooks,
MCP connections and skill discovery. It never calls a real model. It is skipped without that
explicit executable override, and the integration runner does not inherit the override.

For opt-in local startup and complete fake-task timings, see
[Local latency](../../src/test/README.md#local-latency-opt-in). The integration suite checks behavior;
`ask bench` compares models using task durations, rather than timing a complete ask invocation.

docs  docs/contributing/integration.md
