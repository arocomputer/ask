# The sandbox

ask confines commands and built-in filesystem tools, not provider requests. The parent agent
holds credentials and talks to providers; filesystem tools run in separate credential-free
processes with bounded output and a two-minute timeout. Read-only tools receive no workspace
write grant. Fetch and search run in the parent with public-address checks.

## Enforcement

- **Linux:** system bubblewrap creates a read-only root, writable task/scratch mounts, read-only
  mounts over existing Git metadata, private PID/network namespaces and a private `/dev`.
  Inside that view, the bundled `sandybox` applies Landlock read/write grants and seccomp.
  An actual namespace probe must succeed; installation alone is insufficient. No privileged
  setup is performed by ask. Without these prerequisites, confined tools fail closed.
- **macOS:** Seatbelt starts with deny-default and grants system/toolchain/task reads explicitly.
  The root directory itself is readable because dyld needs it; this does not grant descendants.
  Paths are canonicalized to handle `/tmp` versus `/private/tmp`. Git metadata writes and
  removal of its ancestors are denied. A Seatbelt launch probe must succeed.
- Both platforms disable command networking, preserve only basic environment settings, and
  use private scratch HOME/TMPDIR. Before Landlock ABI 9, Unix sockets are disabled outright;
  process pools that require them should use one worker.

Git metadata protection covers regular, nested and linked repositories discovered at setup,
including configuration files included from within the workspace. Missing or symlinked writable
include paths, symlinked `.git` entries and hardlinked metadata files are refused. Staging and committing are
deliberately unavailable. Cleanup removes scratch only, never restores repository state.
This avoids the old cleanup race with concurrent tasks or user edits.

Source/npm builds use `src/files.ts` as the filesystem child entry point; compiled binaries
use `__tool`. The installation code and runtime are readable by that child. The child exposes
only read/list/grep/git/write/edit and an internal instruction loader; provider credentials are never passed to it. Shell commands
also require a sandbox even when tools are used through the library API.
Project instruction loading uses the same child boundary, rooted at the repository so parent
instructions remain available. The exported `instructions()` helper is asynchronous. Prompt
construction reads branch identity but never runs Git status or working-tree filters.

Claude Code and Codex run their own sandbox implementations. Extensions are trusted code in
the parent process and are not made safe by the built-in tool boundary.

## Limits and outstanding validation

This is not a VM and does not protect against kernel exploits. Files in granted task/system/
toolchain directories are readable; secrets inside the task folder remain accessible to shell.
File tools retain path checks, but these are not race-free capability-based opens: the OS
boundary, including its runtime/system read grants, is the security backstop. Narrowing those
reads further requires descriptor-relative operations or a dedicated minimal filesystem helper.

Concurrent host modification during policy construction, pre-existing
aliases, newly created repositories and Git operations outside the sandbox still require review.
Do not infer complete security or PR readiness from passing regression tests. Platform coverage
and decisions are tracked in [security.md](security.md).

There is no dormant command proxy: only fetch/search retain the public-address checks.

## References

- [Landlock](https://docs.kernel.org/userspace-api/landlock.html)
- [Bubblewrap](https://github.com/containers/bubblewrap)
- [Codex Linux implementation](https://github.com/openai/codex/blob/faeb379646bdbad016e11f7c9ca91113cad4bc9d/codex-rs/linux-sandbox/src/bwrap.rs)
- [Codex Seatbelt implementation](https://github.com/openai/codex/blob/faeb379646bdbad016e11f7c9ca91113cad4bc9d/codex-rs/sandboxing/src/seatbelt.rs)
