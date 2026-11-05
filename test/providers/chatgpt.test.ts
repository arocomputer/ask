import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash, createSign, generateKeyPairSync } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { access, begin, remote, signedIn, signOut } from "../../src/providers/chatgpt.ts"
import { home, readJSON, type Auth } from "../../src/base/home.ts"
import { catalog, credential } from "../../src/sessions/models.ts"
import { connect, find } from "../../src/providers/catalog.ts"
import { run } from "../../src/agent/loop.ts"

/**
 * A stand-in for OpenAI's sign-in and API: it signs ID tokens with its own key, checks PKCE
 * and the redirect address, rotates refresh tokens (refusing one used twice), and counts what
 * it was asked.
 */
async function openai(opts: { nonce?: string; refuseFirstToken?: boolean; forge?: boolean } = {}) {
  const { publicKey, privateKey: own } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const privateKey = opts.forge ? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey : own
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }
  const seen = { refreshes: 0, revoked: [] as string[], responses: [] as any[], auth: [] as string[] }
  let pending: { challenge: string; redirect: string; nonce: string } | undefined
  let refresh = "r0"
  let accessToken = "a0"
  const sign = (claims: object) => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")
    const body = `${enc({ alg: "RS256", kid: "k1" })}.${enc(claims)}`
    return `${body}.${createSign("RSA-SHA256").update(body).sign(privateKey).toString("base64url")}`
  }
  const tokens = () => ({
    access_token: accessToken,
    refresh_token: refresh,
    expires_in: 3600,
    scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
    id_token: sign({ iss: "https://auth.openai.com", aud: "oaiapp_1", sub: "user-1", email: "u@example.com", nonce: opts.nonce ?? pending?.nonce, exp: Math.floor(Date.now() / 1000) + 3600 }),
  })
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    const json = (status: number, v: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v))
    const url = new URL(req.url!, "http://x")
    if (url.pathname === "/.well-known/jwks.json") return json(200, { keys: [jwk] })
    if (url.pathname === "/api/accounts/oauth/token") {
      const f = new URLSearchParams(body)
      if (f.get("grant_type") === "authorization_code") {
        const ok = f.get("client_id") === "oaiapp_1" && f.get("code") === "c1" && pending && createHash("sha256").update(f.get("code_verifier")!).digest("base64url") === pending.challenge && f.get("redirect_uri") === pending.redirect
        return ok ? json(200, tokens()) : json(400, { error: "invalid_grant" })
      }
      seen.refreshes++
      if (f.get("refresh_token") !== refresh) return json(400, { error: "refresh_token_reused" })
      refresh = `r${seen.refreshes}`
      accessToken = `a${seen.refreshes}`
      return json(200, tokens())
    }
    if (url.pathname === "/api/accounts/oauth/revoke") {
      seen.revoked.push(new URLSearchParams(body).get("token")!)
      return res.writeHead(200).end()
    }
    if (url.pathname === "/v1/models")
      return json(200, { models: [{ slug: "gpt-plan", display_name: "GPT Plan", visibility: "list" }, { slug: "hidden", display_name: "Hidden", visibility: "hide" }] })
    if (url.pathname === "/v1/responses") {
      seen.responses.push(JSON.parse(body))
      seen.auth.push(String(req.headers.authorization))
      if (opts.refuseFirstToken && req.headers.authorization === "Bearer a0") return json(401, { error: { message: "expired" } })
      const call = seen.responses.length === 1 && !opts.refuseFirstToken
      res.writeHead(200, { "content-type": "text/event-stream" })
      const item = call ? { type: "function_call", call_id: "c", namespace: "ask", name: "ask.list", arguments: "{}" } : { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }
      res.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`)
      return res.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: {} } })}\n\n`)
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.ASK_CHATGPT_ORIGIN = origin
  return {
    origin,
    seen,
    /** Records what the authorization address asked for, as OpenAI would. */
    authorize(url: string) {
      const q = new URL(url).searchParams
      pending = { challenge: q.get("code_challenge")!, redirect: q.get("redirect_uri")!, nonce: q.get("nonce")! }
      return q
    },
    close: () => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))),
  }
}

/** A home whose models.dev cache is empty and fresh, so nothing reaches the network. */
const fresh = () => {
  const h = home(mkdtempSync(join(tmpdir(), "ask-chatgpt-")))
  mkdirSync(join(h.root, "cache"))
  writeFileSync(h.catalog, "{}")
  return h
}
const servers: { close(): Promise<void> }[] = []
after(() => Promise.all(servers.map((s) => s.close())))

/** Signs in a home by pasting the address the browser would land on. */
async function signedInHome(opts?: Parameters<typeof openai>[0]) {
  const o = await openai(opts)
  servers.push(o)
  const h = fresh()
  const attempt = await begin(h)
  const q = o.authorize(attempt.url)
  try {
    await attempt.finish(`${q.get("redirect_uri")}?code=c1&state=${q.get("state")}&client_id=oaiapp_1`)
  } finally {
    attempt.close()
  }
  return { h, o }
}

describe("chatgpt", () => {
  test("a sign-in pasted from another device saves a checked account for this host", async () => {
    const o = await openai()
    servers.push(o)
    const h = fresh()
    const attempt = await begin(h)
    try {
      const q = o.authorize(attempt.url)
      assert.deepEqual([q.get("client_id"), q.get("agent_name_hint"), q.get("code_challenge_method"), q.get("resource")], ["dynamic_agent_client", "ask", "S256", "https://api.openai.com/v1"])
      assert.equal(q.get("scope"), "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct")
      assert.match(q.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
      const host = JSON.parse(readFileSync(join(h.root, "host.json"), "utf8")).id
      assert.match(host, /^urn:uuid:[0-9a-f-]{36}$/)
      assert.equal(q.get("ext_agent_host_id"), host)
      await attempt.finish(`${q.get("redirect_uri")}?code=c1&state=${q.get("state")}&client_id=oaiapp_1`)
    } finally {
      attempt.close()
    }
    const saved = readJSON<Auth>(h.auth, {}).chatgpt as Record<string, unknown>
    assert.deepEqual([saved.client_id, saved.subject, saved.email, saved.refresh_token], ["oaiapp_1", "user-1", "u@example.com", "r0"])
    assert.ok(signedIn(h))
  })

  test("the browser's return to ask's callback finishes the sign-in by itself", async () => {
    const o = await openai()
    servers.push(o)
    const h = fresh()
    const attempt = await begin(h)
    try {
      const q = o.authorize(attempt.url)
      const page = await fetch(`${q.get("redirect_uri")}?code=c1&state=${q.get("state")}&client_id=oaiapp_1`)
      assert.match(await page.text(), /You can close this tab/)
      await attempt.finish(await attempt.callback)
    } finally {
      attempt.close()
    }
    assert.ok(signedIn(h))
  })

  test("an ID token with the wrong nonce is refused, and nothing is saved", async () => {
    const o = await openai({ nonce: "someone else's" })
    servers.push(o)
    const h = fresh()
    const attempt = await begin(h)
    try {
      const q = o.authorize(attempt.url)
      await assert.rejects(attempt.finish(`${q.get("redirect_uri")}?code=c1&state=${q.get("state")}&client_id=oaiapp_1`), /didn't check out/)
    } finally {
      attempt.close()
    }
    assert.ok(!signedIn(h))
  })

  test("an ID token signed with a key OpenAI didn't publish is refused", async () => {
    const o = await openai({ forge: true })
    servers.push(o)
    const h = fresh()
    const attempt = await begin(h)
    try {
      const q = o.authorize(attempt.url)
      await assert.rejects(attempt.finish(`${q.get("redirect_uri")}?code=c1&state=${q.get("state")}&client_id=oaiapp_1`), /didn't check out/)
    } finally {
      attempt.close()
    }
    assert.ok(!signedIn(h))
  })

  test("an address from another sign-in is refused", async () => {
    const o = await openai()
    servers.push(o)
    const attempt = await begin(fresh())
    try {
      const q = o.authorize(attempt.url)
      await assert.rejects(attempt.finish(`${q.get("redirect_uri")}?code=c1&state=forged&client_id=oaiapp_1`), /another sign-in/)
    } finally {
      attempt.close()
    }
  })

  test("processes renewing at once refresh the rotating token only once", async () => {
    const { h, o } = await signedInHome()
    const auth = JSON.parse(readFileSync(h.auth, "utf8"))
    auth.chatgpt.expires_at = Date.now() - 1000
    writeFileSync(h.auth, JSON.stringify(auth))
    const script = `import { access } from ${JSON.stringify(join(import.meta.dirname, "..", "..", "src", "providers", "chatgpt.ts"))}; import { home } from ${JSON.stringify(join(import.meta.dirname, "..", "..", "src", "base", "home.ts"))}; process.stdout.write(await access(home(${JSON.stringify(h.root)})))`
    const runOne = () =>
      new Promise<string>((done, fail) =>
        execFile(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ASK_CHATGPT_ORIGIN: o.origin } }, (err, out, stderr) => (err ? fail(new Error(stderr)) : done(out))),
      )
    const tokens = await Promise.all([runOne(), runOne(), runOne()])
    assert.deepEqual(tokens, ["a1", "a1", "a1"])
    assert.equal(o.seen.refreshes, 1)
  })

  test("a token the API refuses is renewed and the request sent once more", async () => {
    const { h, o } = await signedInHome({ refuseFirstToken: true })
    const c = await catalog(h)
    const m = find(c, "chatgpt/gpt-plan")
    const r = await run({ provider: connect(m, credential(h, "chatgpt", [])!.key), model: m.id, dir: h.root, prompt: "Hi" })
    assert.equal(r.answer, "done")
    assert.deepEqual(o.seen.auth, ["Bearer a0", "Bearer a1"])
  })

  test("plan requests offer the tools in a namespace, and its calls come back by their own names", async () => {
    const { h, o } = await signedInHome()
    mkdirSync(join(h.root, "work"))
    const m = find(await catalog(h), "chatgpt/gpt-plan")
    const r = await run({ provider: connect(m, credential(h, "chatgpt", [])!.key), model: m.id, dir: join(h.root, "work"), prompt: "List" })
    assert.equal(r.answer, "done")
    const tools = o.seen.responses[0].tools
    assert.deepEqual([tools.length, tools[0].type, tools[0].name, tools[0].tools.map((t: any) => t.name)], [1, "namespace", "ask", ["read", "list", "grep", "fetch"]])
    assert.equal(o.seen.responses[0].store, false)
    assert.equal((r.messages[2] as { name: string }).name, "list")
  })

  test("signing out revokes the renewable session and keeps the registration", async () => {
    const { h, o } = await signedInHome()
    assert.equal(await signOut(h), true)
    assert.deepEqual(o.seen.revoked, ["r0"])
    const saved = readJSON<Auth>(h.auth, {}).chatgpt as Record<string, unknown>
    assert.deepEqual([saved.client_id, saved.refresh_token, saved.access_token], ["oaiapp_1", undefined, undefined])
    assert.ok(!signedIn(h))
    await assert.rejects(access(h), /not signed in/)
  })

  test("ask knows when it runs away from the user's screen", () => {
    assert.equal(remote({ SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, "darwin"), true)
    assert.equal(remote({}, "linux"), true)
    assert.equal(remote({ DISPLAY: ":0" }, "linux"), false)
    assert.equal(remote({}, "darwin"), false)
  })

  test("the catalog offers the models the account lists", async () => {
    const { h } = await signedInHome()
    const c = await catalog(h)
    assert.deepEqual(Object.keys(c.chatgpt.models), ["gpt-plan"])
    assert.equal(find(c, "chatgpt/gpt-plan").protocol, "responses")
  })
})
