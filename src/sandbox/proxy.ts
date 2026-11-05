// The proxy a sandboxed command reaches the web through: an HTTP proxy on 127.0.0.1 that takes
// CONNECT (for HTTPS and anything tunnelled) and plain requests, and refuses any destination
// that isn't a public address. It resolves each host itself and connects to the address it
// checked, so a name that points somewhere private, or changes between lookups, can't get
// through. Cloud metadata (169.254.169.254), this machine and the local network are private.

import { lookup } from "node:dns/promises"
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http"
import { connect, isIP, type AddressInfo, type Socket } from "node:net"

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

function refuse(res: ServerResponse | Socket, why: string) {
  if ("writeHead" in res) {
    res.writeHead(403, { "content-type": "text/plain" }).end(`${why}\n`)
  } else res.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${why}\n`)
}

export type Proxy = { port: number; close(): Promise<void> }

/** Starts the proxy on a free port of 127.0.0.1. */
export async function start(): Promise<Proxy> {
  const sockets = new Set<Socket>()
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL
    try {
      url = new URL(req.url ?? "")
    } catch {
      return refuse(res, "the proxy takes absolute URLs")
    }
    if (url.protocol !== "http:") return refuse(res, "the proxy forwards http: URLs; use CONNECT for others")
    const target = await reach(url.hostname)
    if ("refused" in target) return refuse(res, target.refused)
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: url.host }
    delete headers["proxy-connection"]
    delete headers["proxy-authorization"]
    const out = request({ host: target.address, port: url.port || 80, method: req.method, path: url.pathname + url.search, headers }, (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers)
      upstream.pipe(res)
    })
    out.on("error", (err) => (res.headersSent ? res.destroy() : refuse(res, `can't reach ${url.host}: ${err.message}`)))
    req.pipe(out)
  })
  server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client)
    client.on("close", () => sockets.delete(client))
    client.on("error", () => {})
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "")
    if (!m) return refuse(client, "CONNECT takes host:port")
    const target = await reach(m[1])
    if ("refused" in target) return refuse(client, target.refused)
    const upstream = connect(Number(m[2]), target.address, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    sockets.add(upstream)
    upstream.on("close", () => (sockets.delete(upstream), client.destroy()))
    upstream.on("error", () => client.destroy())
  })
  server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))))
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((ok) => {
        for (const s of sockets) s.destroy()
        server.close(() => ok())
      }),
  }
}
