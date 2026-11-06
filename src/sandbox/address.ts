// Public-address checks for fetch/search. Resolve once and connect to the checked address,
// refusing local services and cloud metadata, including IPv4 embedded in IPv6.

import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

/** IPv4 ranges that aren't the public internet. */
const private4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]

function v4(address: string): number {
  return address.split(".").reduce((n, part) => n * 256 + Number(part), 0)
}

/** The 16 bytes of an IPv6 address. */
function v6(address: string): number[] {
  let text = address.split("%")[0]
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const n = v4(tail[1])
    text = text.slice(0, -tail[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head, rest] = text.split("::")
  const groups = (s?: string) => (s ? s.split(":").map((g) => parseInt(g, 16)) : [])
  const h = groups(head)
  const r = rest === undefined ? [] : groups(rest)
  const all = rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill(0), ...r]
  return all.flatMap((g) => [g >> 8, g & 0xff])
}

/** True when an address is anything but the public internet. */
export function blocked(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) {
    const n = v4(address)
    return private4.some(([base, bits]) => n >>> (32 - bits) === v4(base) >>> (32 - bits))
  }
  if (kind !== 6) return true
  const b = v6(address)
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0)
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return blocked(b.slice(12).join(".")) // IPv4-mapped
  if (zero(0, 15) && (b[15] === 0 || b[15] === 1)) return true // unspecified, loopback
  if ((b[0] & 0xfe) === 0xfc) return true // unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // link-local
  if (b[0] === 0xff) return true // multicast
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return blocked(b.slice(12).join(".")) // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return blocked(b.slice(2, 6).join(".")) // 6to4
  return false
}

/** A public address for `host`, or why there isn't one. Every address the name has must be public. */
export async function reach(host: string): Promise<{ address: string } | { refused: string }> {
  const bare = host.replace(/^\[|\]$/g, "")
  let addresses: string[]
  try {
    addresses = isIP(bare) ? [bare] : (await lookup(bare, { all: true })).map((a) => a.address)
  } catch {
    return { refused: `can't resolve ${host}` }
  }
  if (!addresses.length || addresses.some(blocked)) return { refused: `${host} is a private address; ask reaches only the public internet` }
  return { address: addresses[0] }
}
