# Baymax

Baymax is ask's mascot and integration doctor. He needs Go, Node.js and git, not API keys,
installed coding CLIs or a running agent.

```sh
./x baymax                    # every bundled harness
./x baymax copilot            # Copilot only
./x baymax pi                 # Pi only
./x baymax copilot pi         # Copilot and Pi, checked separately
./x check                     # includes Baymax
```

`./x node` is a compatibility alias for Baymax. The old package-test loop is replaced, not
another independent definition of green. Formatting, vet, shellcheck and architectural guards
remain separate checks.

## What it protects

Baymax runs the package-specific adapter assertions and builds the real ask binary to test
installed packages in temporary homes against deterministic CLI/protocol simulators. This
checks the boundary between ask and its packaged agents, rather than only calling adapters
with hand-written environment variables. Failures and unknown package selections exit nonzero.

| Check | What it protects |
| --- | --- |
| Packaged harnesses | Installation, answers, usage, sessions, access/refusal and error propagation for every bundled adapter |
| Package lifecycle | Shipped resources and executable launchers, stale-package refresh, preservation of user overrides and safe removal |
| Writing | Actual file changes in a disposable project, read/write propagation, follow-ups, batches and worktree isolation using a controlled agent |
| Shutdown | Timeouts and `ask stop` terminate the controlled agent and its descendants rather than leaving work running |
| Test plumbing | Bounded subprocesses, isolated environments and report parsing, with helper regression tests |

Selecting harness names limits the adapter and package lifecycle suites. Shared writing,
shutdown and helper checks still run: they protect ask itself, independent of which vendor CLI
was selected. Multiple names select separate harness suites, not running agent sessions.

The runner and shared test plumbing live in `test/baymax/`. Harness-specific assertions and
simulators remain in `packages/NAME/test/`; Baymax's integration profiles describe the small
amount of configuration needed to drive each simulator through ask. No harness-specific
production behavior goes into `internal/`.

Baymax deliberately disables Go module downloads while building; install the repository's Go
dependencies beforehand if the module cache is empty. No developer credentials are passed to
simulated harness processes. Test homes, project files and installed packages are temporary.

## Adding or changing a harness

1. Add focused adapter assertions beside its package, using Baymax's shared process and report
   helpers rather than copying a subprocess runner.
2. Base simulator output on upstream source, documented schemas or sanitized captured output;
   link the source and supported versions in the package README. Never include credentials or
   personal session data in fixtures.
3. Add the harness's integration profile so Baymax can install and run it through ask. Keep
   access restrictions, model selection and unsupported capabilities explicit.
4. Run `./x baymax NAME`, then `./x check` before proposing the change.

## Honest boundary

A pass means compatibility with the simulated contracts and behaviors covered by the tests.
It does **not** prove that today's installed vendor CLI, authentication or live provider works,
or that vendor permission enforcement is correct. That requires separate real-CLI verification.
Baymax does not download CLIs, call providers or silently turn offline checks into paid tests.
Existing fixtures remain simulators, not independently captured upstream recordings.

For opt-in local startup and complete fake-task timings, see
[Local latency](../../test/README.md#local-latency-opt-in). Baymax checks behavior;
`ask bench` compares models using task durations, rather than timing a complete ask invocation.

docs  docs/contributing/baymax.md
