# TypeScript rewrite: decisions and merge evidence

This replaces the implementation plan. Historical experiments and the Go implementation remain
in Git history. The current interfaces are `ask help`, `ask help requests` and the user docs.

## Decisions

- **One engine, no runtime dependencies.** TypeScript using Node built-ins, tested under Node 24+
  and Bun. npm ships emitted JavaScript/declarations; releases ship Bun-compiled executables.
- **Persistent conversations.** Records and original transcripts are retained; compaction writes
  a separate checkpoint. Interrupted calls are marked interrupted rather than silently repeated.
  Usage and write-task baselines survive worker restarts. Completion is not a transaction across
  tool side effects and transcript writes: after a crash, inspect interrupted effects before retrying.
- **Atomic transitions.** Continue, stop and restart claim a turn generation before changing it,
  re-read the record, and reject a competing transition. Live owners retain claims; abandoned
  claims use immutable retry slots. Worker identity requires the `__worker FOLDER` argument tail.
  JSON files are flushed before atomic replacement. This is not a replicated/durable database.
- **Provider/model is the public identifier.** Each model resolves its own key, endpoint and
  protocol. `ASK_MODEL_SMALL=provider/model` explicitly selects a helper; omission reuses the turn
  model. No silent cheapest-model routing or borrowing another model's credentials.
- **Two shipped harnesses.** Claude Code and Codex run their installed, unmodified CLIs with their
  own sign-ins. ask never imports their credentials. Extensions use the same harness interface;
  they are trusted executable code, not confined plugins.
- **One sandbox switch.** Enabled by default, config-only `"sandbox": false` disables confinement.
  No permission tier UI, request override or daemon. Read/write tool selection is separate.
  `ask.sandbox` is the bundled Linux Landlock/seccomp helper. macOS uses system Seatbelt.
- **System bubblewrap for this release.** Resolve and probe the exact executable used. Bundling
  a pinned bubblewrap adds distribution-policy, update and license responsibilities; it does not
  supply missing kernel namespaces. It is not bundled or advertised as zero-setup Linux support.
- **Git protection at execution time.** No snapshot restoration of metadata. Built-in confined
  tasks cannot stage or commit. Bookkeeping hashes raw files and does not run hooks or filters.
- **Preserve existing work.** Read-only `ask legacy` exposes Go-era records and native transcripts.
  Retired spending/isolation settings stop new tasks until deliberately migrated. No automatic
  conversion, extension execution or cleanup. [Migration](../migration.md) documents the deliberate
  replacement of main's #82 cleanup with unconditional retention and manual Git cleanup.

## Review and verification

Independent API-model reviews completed on the pre-merge branch. Findings led to fixes for
transition races, worker identity checks, crash baselines, lifecycle cleanup, partial batch results,
hard-link file aliases, and file flushing. Reviews are evidence, not a security certification.
The focused regressions and full Node/Bun suites exercise those behaviors without real providers.

Linux x86_64 and macOS arm64 are the tested hosts. Release packaging also cross-builds both
architectures on both systems. Executing a cross-built binary still requires its target host.
See the PR's final validation record for the exact checked commit and counts.

The compaction fixture (`bench/compact.ts`) passed all six task-fact checks in independent runs:

| Model | Seconds | Input tokens | Output tokens | Cached tokens |
| --- | ---: | ---: | ---: | ---: |
| `opencode-go/glm-5.3` | 15.041 | 1956 | 1551 | 20 |
| `opencode-go/gpt-6-luna` | 7.415 | 1654 | 529 | 0 |

These are two single runs, not a statistical benchmark or proof of superiority over native
subagents. Real review runs also completed through persistent sessions, including a follow-up.

## Explicit follow-up work

- Wider OS coverage: older macOS, other Linux distributions, WSL and newer Landlock socket ABIs.
- Live ChatGPT plan-route sign-in/tool-call compatibility; current tests use a fake OpenAI server.
- Question-focused helper/fetch quality and cost experiments, and comparative delegation benchmarks.
  Do not change default model routing or advertise performance gains without that evidence.
- Measure repeated policy discovery in large workspaces before caching it; caching may miss newly
  created metadata. A daemon would add lifecycle and authentication complexity without evidence.
- Descriptor-relative file-tool paths could narrow the interface further. Today the OS policy is
  the enforced boundary; path checks and environment-file names are additional guards, not an
  adversarial-filesystem isolation guarantee. See [security](security.md) for the threat model.
