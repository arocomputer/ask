# Security boundary and review record

This records the enforced boundary, review findings and limits of the TypeScript rewrite.
The sandbox is defense in depth for task execution, not isolation from a malicious host account.

## Threat model

The credential-bearing parent talks to providers. Untrusted task commands and filesystem tools
run in filtered child processes under the configured OS policy. The boundary is the policy's
read/write grants, not just the task directory: required system/toolchain paths are also readable.
Fetch/search are separate parent capabilities with public-address checks. Extensions, harness
configuration and the invoking user's host processes are trusted. A hostile same-user process
can alter binaries, configuration and policy inputs before launch; this is not a multi-tenant VM.

Config-only `"sandbox": false` explicitly removes this OS boundary. It is recorded per turn.
Environment filtering remains, but account-readable files and network access are then available.

## Decisions

- **Confine filesystem tools in child processes.** Implemented the existing OS boundary around
  read/list/grep/git/write/edit, with no workspace write grant for read-only tools. This removes
  filesystem execution from the credential-bearing parent without another native file protocol.
  File reads now reject non-regular files and hard-link aliases using the opened descriptor,
  and use `O_NOFOLLOW` on the final component. A `realpath` check followed by a separate open
  has a race. On Linux, investigate `openat2` with a pinned root descriptor and
  `RESOLVE_BENEATH` plus `RESOLVE_NO_MAGICLINKS`; `O_NOFOLLOW` alone covers only the final
  component. On macOS, investigate descriptor-relative `openat` with `O_RESOLVE_BENEATH` and
  `O_NOFOLLOW_ANY`, including availability on every supported release. Do not fall back silently
  to a weaker check. Reads, edits, creates, enumeration and rename operations need their own
  contracts; opening one file safely does not secure every filesystem operation.
- **Protect Git metadata at execution time, not by restoring a snapshot afterward.** Implemented
  bubblewrap read-only mounts on Linux and Seatbelt denials on macOS, including linked/nested
  repositories. Removed snapshot restoration. Concurrent-user-change, linked-worktree-config,
  ancestor-rename and hardlink regressions pass. Landlock
  grants filesystem rights through ancestor rules, so a writable workspace cannot be made
  read-only at `.git` by adding a narrower rule. Bubblewrap can layer a read-only bind mount over
  a writable workspace and isolate networking, but it is a policy-building tool, not a complete
  policy. It also requires working user namespaces. Validate the exact mounts, nested and linked
  worktrees, Git configuration includes, sockets and setup failures; refuse write tasks where the
  required boundary cannot be established. Built-in file tools need the same protection.
- **Keep command networking off** until a proxy-only boundary is enforced. `fetch` and `search`
  remain available through ask's public-address checks. This prevents tests that require local
  TCP servers from running inside the current sandbox.
- **Do not run Git filters or hooks in ask's bookkeeping.** Change snapshots hash raw file bytes
  and ask's Git calls disable hooks and fsmonitor. Worktree creation refuses configured external
  checkout filters and conditional includes before creating a checkout. Concurrent host changes
  during this inspection still need auditing; the check is not a frozen configuration snapshot.

## Verification in this pass

- On `mini` (macOS 27.2, arm64), replaced the original overly broad read policy with explicit
  grants and canonical paths. Diagnosed dyld's root-directory read using sandbox denial logs;
  a literal root grant fixes startup without granting descendants. Both Node and Bun passed
  145 tests, with one harness prerequisite test skipped. Mac testing also exposed directory-order
  assumptions, different denial errors and the exact Xcode selection path needed by Apple's Git.
  On Linux 6.12 (x86_64), Node and Bun passed all 146 tests. The final containment correction
  for names beginning with `..` passed the focused sandbox suite on both platforms and runtimes.
  The Claude Code and Codex harnesses run their own policies; that is a separate boundary.
- Compiled binaries performed confined reads through a fake provider on Linux and macOS; an
  installed npm tarball did the same on Linux. Existing checkout build outputs were preserved.
- Earlier independent reviews timed out. Subsequent reviews with `opencode-go/gpt-6-luna` and
  `opencode-go/glm-5.3` completed and found concrete issues: lifecycle cleanup, hard-link aliases,
  stop/restart/continue races, lost pre-crash change baselines, worker identity and persistence.
  Fixes have focused regressions. Reviewer suggestions to recursively delete partial worktrees
  were deliberately rejected: retain partial data and report its path for manual recovery.

## Remaining validation

- Reproduce concurrent symlink and directory replacement attacks for every file tool.
- Expand crash/concurrency tests beyond the covered linked/nested repositories, included
  configuration, metadata aliases and concurrent user edits. Check installation/toolchain aliases.
- Verify older supported macOS releases, other Linux distributions and WSL. Prerequisites are
  documented, but two tested hosts are not a full compatibility matrix.
- Audit all Git invocations, including worktree creation and harness operations, for hooks,
  filters, configuration and inherited environment.

## Codex comparison

At commit `faeb379646bdbad016e11f7c9ca91113cad4bc9d`, Codex uses bubblewrap and seccomp on Linux,
and Seatbelt on macOS. Its Linux policy layers writable roots over read-only mounts, then protects
metadata paths; its macOS policy excludes protected paths from writable roots and handles ancestor
renames. Both implementations have substantial machinery for aliases, nested paths, sockets and
failure handling. Reuse the design principles and test cases, not a small subset of flags presented
as equivalent protection. Copying source code also requires compliance with Codex's Apache-2.0
license.

## Sources

- [Linux openat2(2)](https://man7.org/linux/man-pages/man2/openat2.2.html)
- [Linux Landlock documentation](https://docs.kernel.org/userspace-api/landlock.html)
- [Bubblewrap upstream README and limitations](https://github.com/containers/bubblewrap/blob/main/README.md)
- [Apple XNU fcntl.h](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h)
- [Apple: Race Conditions and Secure File Operations](https://developer.apple.com/library/archive/documentation/Security/Conceptual/SecureCodingGuide/Articles/RaceConditions.html)
- [Codex Linux sandbox](https://github.com/openai/codex/blob/faeb379646bdbad016e11f7c9ca91113cad4bc9d/codex-rs/linux-sandbox/src/bwrap.rs)
- [Codex macOS sandbox](https://github.com/openai/codex/blob/faeb379646bdbad016e11f7c9ca91113cad4bc9d/codex-rs/sandboxing/src/seatbelt.rs)
