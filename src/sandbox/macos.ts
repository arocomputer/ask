// The macOS sandbox: runs commands with /usr/bin/sandbox-exec and a Seatbelt profile written
// from the policy. The profile denies everything, then allows what commands need: running
// programs, reading all but the home folder (plus what the policy re-allows inside it), writing
// only the policy's folders, Unix sockets only in the task's own folders, and network only to
// this machine, where ask's proxy and the task's own servers listen.

import { dirname } from "node:path"
import { homedir } from "node:os"
import type { Policy } from "./policy.ts"

/** A string as a Seatbelt literal. */
const q = (s: string) => JSON.stringify(s)

/** Every folder above `path`, so the way down to an allowed folder can be looked at. */
function ancestors(path: string): string[] {
  const out: string[] = []
  for (let d = dirname(path); d !== dirname(d); d = dirname(d)) out.push(d)
  return out
}

/** The Seatbelt profile for a policy. */
export function profile(p: Policy): string {
  const home = homedir()
  const inside = [p.dir, p.tmp, ...p.read, ...p.write].filter((x) => x === home || x.startsWith(home + "/"))
  const writable = p.write.filter((w) => !w.startsWith("/dev/"))
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-sem ipc-posix-shm)",
    "(allow pseudo-tty)",
    '(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.notification_center") (global-name "com.apple.dnssd.service"))',
    `(allow file-read* (require-all (subpath "/") (require-not (subpath ${q(home)}))))`,
    ...(inside.length
      ? [`(allow file-read* ${inside.map((x) => `(subpath ${q(x)})`).join(" ")})`, `(allow file-read-metadata ${[...new Set(inside.flatMap(ancestors))].map((x) => `(literal ${q(x)})`).join(" ")})`]
      : []),
    `(allow file-write* ${writable.map((x) => `(subpath ${q(x)})`).join(" ")})`,
    '(allow file-write-data file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))',
    `(allow network-bind network-inbound (local ip "localhost:*"))`,
    `(allow network-outbound (remote ip "localhost:*"))`,
    `(allow network-outbound (remote unix-socket ${writable.map((x) => `(subpath ${q(x)})`).join(" ")}))`,
  ].join("\n")
}

/** The command line that runs `argv` under `p`. */
export function wrap(p: Policy, argv: string[]): string[] {
  return ["/usr/bin/sandbox-exec", "-p", profile(p), "--", ...argv]
}
