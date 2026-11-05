# The sandbox

How ask confines the commands a subagent runs, why it is built this way, and what it can't do.
Researched November 2026; the sources are at the end.

## What it protects against

A subagent that goes wrong: a prompt injection from a web page, a dependency or the repository
itself, or a model that makes a destructive mistake. Not someone with a kernel exploit; that
needs a virtual machine, which is too heavy for a command-line tool. The sandbox must stop:

1. **Damage outside the task.** Writing, deleting or planting files anywhere but the task's
   folder and its own temp folder, including git hooks and config that run later, outside it.
2. **Theft of secrets.** SSH and cloud credentials, API keys, browser profiles, the keyring, and
   agents that hold keys (ssh-agent, gpg-agent).
3. **Reaching what it shouldn't.** Cloud metadata (169.254.169.254 hands out credentials), the
   local network, services on localhost, the Docker socket (root by another name).
4. **Interfering with other programs.** Signalling them, tracing them, reading their memory or
   environment.

It must not make commands slow, and it must not need anything installed.

## What there is to build on

| Tier | Examples | Stops | Cost |
| --- | --- | --- | --- |
| Virtual machine | Firecracker, Apple containers | Kernel exploits too | KVM or a hypervisor, an image, seconds to start |
| User-space kernel | gVisor | Most kernel exploits | Linux only, overhead, some programs misbehave |
| Namespaces | bubblewrap, Docker, nsjail | A misbehaving program | User namespaces, which Ubuntu 24.04 restricts with AppArmor |
| Self-restriction | Landlock and seccomp, Seatbelt | A misbehaving program | Nothing; microseconds |

- **Landlock** is part of the Linux kernel since 5.13. Any unprivileged process can restrict
  itself and everything it starts, irreversibly, to an allowlist: which folders it may read or
  write (v1), TCP ports it may connect to (v4, Linux 6.7), no signals to or abstract sockets of
  processes outside (v6, 6.12), and no connections to Unix sockets created outside (v9, 7.1).
  It needs no namespaces, so AppArmor doesn't interfere. It can't make a path inside an allowed
  folder narrower, and it can't hide anything; what isn't allowed fails with EACCES.
- **seccomp** filters system calls by number and plain arguments, never by path. Chrome OS's
  guidance is Landlock plus seccomp: each covers what the other can't.
- **Seatbelt** is macOS's own sandbox; Safari and Apple's services run in it. `sandbox-exec`
  applies a profile to any command. Apple has called that command deprecated since 2016 and
  offers nothing else for command-line tools, so Chrome, Claude Code and Codex all use it.
  Profiles can allow and deny by path, including Unix socket paths and network addresses.
- **bubblewrap** builds a private filesystem view out of namespaces: it can hide paths and mount
  subfolders read-only. Ubuntu 24.04 lets only `/usr/bin/bwrap` create user namespaces, so a
  bundled copy fails there, and on some setups the system copy does too.

## What others do

| | Claude Code (sandbox-runtime) | Codex |
| --- | --- | --- |
| Linux | bubblewrap and socat, installed by the user | bubblewrap (system, else bundled) and seccomp; dropped Landlock |
| macOS | Seatbelt | Seatbelt |
| Network | Its own namespace; all traffic through a proxy with a domain allowlist | Off, or through a managed proxy |
| Reads | Everywhere by default; paths denied by configuration | Allowlist profiles |
| `.git` | Writable except hooks and config | Read-only |
| Unix sockets | Allowed unless an optional filter is installed | Blocked in proxy mode, which breaks Python 3.14's process pools (codex#24943, open) |

Codex dropped Landlock because, before v9, it can't stop a command connecting to a Unix socket
it can name; that is the one real gap. Both route the network through a proxy, because it's
the only way to allow the internet and refuse private addresses.

## What ask does

The same policy everywhere, enforced as far as the system allows:

| | Read-only task | Write task |
| --- | --- | --- |
| Read | The task's folder, the system (`/usr`, `/etc`, ...), the toolchains on PATH | Same |
| Write | Nothing | The task's folder and a private temp folder |
| Home folder, `/run/user` | Unreachable | Unreachable |
| Network | None | Web (ports 80 and 443) only through ask's proxy, public addresses only; other ports direct |
| Unix sockets made elsewhere | Refused | Refused |
| Other processes | Untouchable | Untouchable |
| Environment | No API keys, agent sockets or session bus | Same |

ask's own read-only tasks run no commands at all; the table matters for write tasks and for
what Claude Code and Codex are told.

- **Linux:** `sandybox`, a small C program ask ships (`native/sandybox.c`), applies Landlock at
  the best version the kernel has, a seccomp filter, and `no_new_privs`, then runs the command.
  It costs about a millisecond per command.
  - Before Landlock v9, seccomp refuses to create Unix sockets at all (socket pairs stay
    allowed). Python 3.14's process pools fail with PermissionError there; ask's instructions
    tell the model to use one worker. On macOS and Linux 7.1+ only outside sockets are refused.
  - Before v4 (Linux 6.7), seccomp refuses internet sockets, so commands have no network; the
    `fetch` tool still works, since it runs in ask's process.
  - Before v1 (no Landlock), write tasks are refused.
  - Landlock can't make `.git/hooks` and `.git/config` read-only inside a writable folder, so ask
    snapshots them before a write turn and puts them back after, reporting any change.
- **macOS:** the same policy as a Seatbelt profile, run with `/usr/bin/sandbox-exec`.
- **The proxy** runs in ask's worker. Commands find it through `HTTP_PROXY` and `HTTPS_PROXY`.
  It resolves each host itself and connects to that address only if it is public, so a name
  that resolves to a private address, or changes between lookups, can't reach one.
- **Why ports, not "only the proxy":** Landlock limits TCP by port, not address. Allowing only
  the proxy's port would break every test suite that starts a server and connects to it. So
  commands may connect to any port except 80 and 443: web traffic, cloud metadata included
  (it answers on port 80), must go through the proxy, while servers a command starts, and
  databases it uses, still work. What this leaves open is non-web ports on the local network.
  On macOS, Seatbelt can do better and does: outbound only to this machine.
- **Cost:** Landlock takes one rule per allowed port, about 65,000; setting them up costs about
  25 ms per command on a 2026 machine. The rest is microseconds. If that ever matters, one
  sandboxed process per turn could start every command, paying it once.
- **The `fetch` tool** runs in ask's process, not the sandbox, with the same public-address
  check on every host and redirect, so read-only tasks can read documentation. **`search`**
  runs there too and reads only the search engines' result pages, through the same check.
- **Claude Code and Codex** get their own sandboxes, set as close to this as they allow: no
  home folder, no secrets, no network for their commands (neither proxy filters by address
  yet). Claude Code's sandbox needs bubblewrap and socat on Linux; without them its write tasks
  are refused, with what to install. Codex brings its own.

## Sources

- Landlock: docs.kernel.org/userspace-api/landlock.html, man7.org/linux/man-pages/man7/landlock.7.html, landlock.io/news
- Chrome OS sandboxing guide: chromium.org/chromium-os/developer-library/guides/development/sandboxing
- Claude Code: code.claude.com/docs/en/sandboxing, github.com/anthropic-experimental/sandbox-runtime, anthropic.com/engineering/claude-code-sandboxing
- Codex: github.com/openai/codex (codex-rs/linux-sandbox, issues #215, #14919, #24943), developers.openai.com/codex/permissions
- Ubuntu's user namespace restriction: discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007
- Python 3.14's forkserver default: github.com/python/cpython/pull/101556
