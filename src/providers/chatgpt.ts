// Signing in with a ChatGPT plan, as OpenAI documents for open-source tools that run locally
// (developers.openai.com/siwc/token-sharing-open-source): OAuth with PKCE and dynamic client
// registration, no client secret, then Responses API requests billed to the user's plan.
//
// The sign-in listens on a 127.0.0.1 callback and, at the same time, takes the address the
// browser lands on pasted back, so it works from another device too (over SSH, a phone).
// The record lives in auth.json under "chatgpt"; the host's own id lives apart, in host.json,
// so copied credentials never overwrite it. Tokens are renewed under a lock every ask process
// shares, since refresh tokens rotate and a reused one is refused.

import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto"
import { mkdirSync, rmSync, statSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { readJSON, writeJSON, type Auth, type Home } from "../base/home.ts"

/** Where OpenAI's sign-in and API live; ASK_CHATGPT_ORIGIN points both elsewhere, for tests. */
function origins() {
  const test = process.env.ASK_CHATGPT_ORIGIN
  return { auth: test ?? "https://auth.openai.com", api: test ? `${test}/v1` : "https://api.openai.com/v1" }
}

export const api = () => origins().api
const issuer = "https://auth.openai.com"
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
const planScope = "chatgpt.tokens.use.direct"
export const usagePage = "https://chatgpt.com/settings/usage"

/** The saved sign-in. Tokens are gone after signing out; the client id stays for next time. */
export type Account = {
  client_id: string
  subject: string
  email?: string
  id_token?: string
  access_token?: string
  refresh_token?: string
  /** Milliseconds since the epoch. */
  expires_at?: number
  scopes?: string[]
}

export function account(h: Home): Account | undefined {
  const a = readJSON<Auth>(h.auth, {}).chatgpt as Account | undefined
  return a?.client_id ? a : undefined
}

function save(h: Home, a: Account | undefined) {
  const auth = readJSON<Auth>(h.auth, {})
  if (a) auth.chatgpt = a
  else delete auth.chatgpt
  writeJSON(h.auth, auth)
}

/** True when there is a sign-in whose tokens may be used for the plan. */
export function signedIn(h: Home): boolean {
  const a = account(h)
  return !!a?.refresh_token && !!a.scopes?.includes(planScope)
}

/** This machine's stable, opaque agent host id, made once. */
export function hostId(h: Home): string {
  const path = join(h.root, "host.json")
  const saved = readJSON<{ id?: string }>(path, {}).id
  if (saved) return saved
  const id = `urn:uuid:${randomUUID()}`
  writeJSON(path, { id })
  return id
}

/** True when ask runs away from the screen the user is looking at, so a browser can't open here. */
export function remote(env = process.env, platform = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return true
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY
}

const b64 = (b: Buffer) => b.toString("base64url")

/** A sign-in in progress: the address to open, and how to finish it. */
export type Attempt = {
  url: string
  /** Resolves when the browser comes back to the 127.0.0.1 callback. */
  callback: Promise<string>
  /** Finishes with the address the browser landed on, from the callback or pasted. */
  finish(address: string): Promise<Account>
  close(): void
}

/** A pasted callback can be corrected without replacing the active OAuth attempt. */
export class CallbackError extends Error {}

/** Starts a sign-in: listens on a loopback port and builds the authorization address. */
export async function begin(h: Home): Promise<Attempt> {
  const previous = account(h)
  const state = b64(randomBytes(24))
  const nonce = b64(randomBytes(24))
  const verifier = b64(randomBytes(48))
  let landed: (address: string) => void = () => {}
  const callback = new Promise<string>((ok) => (landed = ok))
  const server = await listen((path) => {
    const q = parse(path)
    if (q.get("state") !== state || (!q.get("code") && !q.get("error"))) return false
    landed(`http://127.0.0.1${path}`)
    return true
  })
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/callback`
  const params = new URLSearchParams({
    client_id: previous?.client_id ?? "dynamic_agent_client",
    ...(previous ? {} : { agent_name_hint: "ask" }),
    ext_agent_host_id: hostId(h),
    ...(previous?.id_token ? { id_token_hint: previous.id_token } : {}),
    ...(previous?.email ? { login_hint: previous.email } : {}),
    response_type: "code",
    redirect_uri: redirect,
    scope: scopes,
    resource: "https://api.openai.com/v1",
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: b64(createHash("sha256").update(verifier).digest()),
  })
  return {
    url: `${origins().auth}/api/accounts/authorize?${params}`,
    callback,
    close: () => server.close(),
    async finish(address) {
      const q = parse(address)
      if (!q.get("state")) throw new CallbackError("that address has no sign-in state; copy the full callback URL from the browser's address bar")
      if (q.get("state") !== state) throw new CallbackError("that callback does not match this login; this login is still active, so use its link above and paste the complete callback URL")
      if (q.get("error") === "access_denied") throw new Error("the sign-in was declined, so ask can't use your ChatGPT plan")
      if (q.get("error")) throw new Error(`the sign-in failed: ${q.get("error_description") ?? q.get("error")}`)
      const code = q.get("code")
      if (!code) throw new CallbackError("that address has no sign-in code; paste the whole address the browser landed on")
      const client = previous?.client_id ?? q.get("client_id")
      if (!client || client === "dynamic_agent_client") throw new Error("OpenAI didn't register ask; try signing in again")
      if (previous && q.get("client_id") && q.get("client_id") !== previous.client_id) throw new Error("the sign-in came back for a different registration; try again")
      const tokens = await token({ grant_type: "authorization_code", client_id: client, code, code_verifier: verifier, redirect_uri: redirect, resource: "https://api.openai.com/v1" })
      const claims = await checkIdToken(tokens.id_token, client, nonce)
      if (previous && previous.subject !== claims.sub) throw new Error("that is a different ChatGPT account; sign out first to switch accounts")
      const a: Account = {
        client_id: client,
        subject: claims.sub,
        email: typeof claims.email === "string" ? claims.email : undefined,
        id_token: tokens.id_token,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        scopes: String(tokens.scope ?? "").split(" ").filter(Boolean),
      }
      save(h, a)
      return a
    },
  }
}

/** Reads a callback address, or just its query, into parameters. */
function parse(address: string): URLSearchParams {
  const text = address.trim().split("#", 1)[0]
  const at = text.indexOf("?")
  return new URLSearchParams(at >= 0 ? text.slice(at + 1) : text)
}

/**
 * Listens on 127.0.0.1, port 1455 if free, answering /auth/callback with a page to close. The
 * listener never keeps ask running by itself, so an abandoned sign-in can't hold it open.
 */
function listen(onCallback: (path: string) => boolean): Promise<Server> {
  const server = createServer((req, res) => {
    if (!req.url?.startsWith("/auth/callback")) {
      res.writeHead(404).end()
      return
    }
    if (!onCallback(req.url)) {
      res.writeHead(400).end("This callback does not match the active login. Return to ask and use its login link.")
      return
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<p>Callback received. You can close this tab and return to ask to check the sign-in result.</p>")
  })
  return new Promise<Server>((ok, fail) => {
    server.once("error", () => {
      server.removeAllListeners("error")
      server.once("error", fail)
      server.listen(0, "127.0.0.1", () => ok(server))
    })
    server.listen(1455, "127.0.0.1", () => ok(server))
  }).then((s) => (s.unref(), s))
}

type Tokens = { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string }

/** Posts a form to the token endpoint and returns its tokens, or throws its error code. */
async function token(form: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${origins().auth}/api/accounts/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(`OpenAI refused the ${form.grant_type === "refresh_token" ? "renewal" : "sign-in"}: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`)
    ;(err as Error & { code?: string }).code = body.error
    throw err
  }
  return body
}

/** Verifies an ID token's RS256 signature against OpenAI's keys, and its issuer, audience, expiry and nonce. */
async function checkIdToken(jwt: string | undefined, client: string, nonce: string): Promise<Record<string, unknown> & { sub: string }> {
  const parts = jwt?.split(".") ?? []
  if (parts.length !== 3) throw new Error("OpenAI's answer had no ID token")
  const [head, payload, sig] = parts
  const header = JSON.parse(Buffer.from(head, "base64url").toString())
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString())
  if (header.alg !== "RS256") throw new Error("the ID token isn't signed as expected")
  const { keys } = await (await fetch(`${origins().auth}/.well-known/jwks.json`, { signal: AbortSignal.timeout(30_000) })).json()
  const jwk = (keys as { kid?: string }[]).find((k) => k.kid === header.kid)
  if (!jwk) throw new Error("the ID token is signed with a key OpenAI doesn't publish")
  const good = verify("RSA-SHA256", Buffer.from(`${head}.${payload}`), createPublicKey({ key: jwk as never, format: "jwk" }), Buffer.from(sig, "base64url"))
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!good || claims.iss !== issuer || !audience.includes(client) || claims.nonce !== nonce || !(claims.exp * 1000 > Date.now()) || typeof claims.sub !== "string")
    throw new Error("the ID token didn't check out; try signing in again")
  return claims
}

const lockStale = 30_000

/**
 * A current access token, renewed when it expires within five minutes or `renew` says the
 * last one was refused. Renewal holds a lock shared by every ask process and reads the record
 * again inside it, so a rotated refresh token is never used twice.
 */
export async function access(h: Home, renew = false): Promise<string> {
  const fresh = (a: Account | undefined) => !!a?.access_token && (a.expires_at ?? 0) - Date.now() > 5 * 60_000
  const before = account(h)
  if (!before?.refresh_token) throw new Error("not signed in to ChatGPT; run ask settings to sign in")
  if (!renew && fresh(before)) return before.access_token!
  const lock = join(h.root, "chatgpt.lock")
  for (const end = Date.now() + 60_000; ; ) {
    try {
      mkdirSync(lock)
      break
    } catch {
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
      if (age > lockStale) rmSync(lock, { recursive: true, force: true })
      else if (Date.now() > end) throw new Error("another ask process is stuck renewing the ChatGPT sign-in")
      else await new Promise((ok) => setTimeout(ok, 100))
    }
  }
  try {
    const now = account(h)!
    if (now.access_token && now.access_token !== before.access_token && fresh(now)) return now.access_token
    if (!renew && fresh(now)) return now.access_token!
    let tokens: Tokens
    try {
      tokens = await token({ grant_type: "refresh_token", client_id: now.client_id, refresh_token: now.refresh_token!, resource: "https://api.openai.com/v1" })
    } catch (err) {
      const code = (err as { code?: string }).code ?? ""
      if (/invalid_grant|invalid_refresh_token|token_expired|refresh_token_(expired|invalidated|reused)/.test(code)) {
        save(h, { ...now, access_token: undefined, refresh_token: undefined, expires_at: undefined })
        throw new Error("the ChatGPT sign-in has ended; run ask settings to sign in again")
      }
      throw err
    }
    const next: Account = {
      ...now,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? now.refresh_token,
      id_token: tokens.id_token ?? now.id_token,
      expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes: tokens.scope ? tokens.scope.split(" ") : now.scopes,
    }
    save(h, next)
    return next.access_token!
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/**
 * Signs out: revokes the renewable session with OpenAI, then forgets the tokens, keeping the
 * client id for the next sign-in. Resolves false when OpenAI couldn't confirm the revocation.
 */
export async function signOut(h: Home): Promise<boolean> {
  const a = account(h)
  if (!a) return true
  let revoked = !a.refresh_token
  for (let attempt = 0; !revoked && attempt < 3; attempt++) {
    try {
      const res = await fetch(`${origins().auth}/api/accounts/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: a.refresh_token!, token_type_hint: "refresh_token", client_id: a.client_id }),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) revoked = true
      else if (res.status < 500) break
    } catch {}
    if (!revoked) await new Promise((ok) => setTimeout(ok, 500 * 2 ** attempt))
  }
  save(h, { client_id: a.client_id, subject: a.subject, email: a.email, id_token: a.id_token })
  return revoked
}

/** A model the account may use, as OpenAI lists it for this sign-in. */
export type PlanModel = { slug: string; name: string }

/** The account's models, from the cache when it is under a day old, else fetched and cached. */
export async function models(h: Home, refresh = false): Promise<PlanModel[]> {
  const path = join(h.root, "cache", "chatgpt.json")
  const cached = readJSON<{ at?: number; models?: PlanModel[] }>(path, {})
  if (!refresh && cached.models && Date.now() - (cached.at ?? 0) < 86_400_000) return cached.models
  try {
    const res = await fetch(`${api()}/models`, { headers: { authorization: `Bearer ${await access(h)}` }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    const list: PlanModel[] = (body.models ?? [])
      .filter((m: { visibility?: string }) => m.visibility === "list")
      .map((m: { slug: string; display_name?: string }) => ({ slug: m.slug, name: m.display_name ?? m.slug }))
    writeJSON(path, { at: Date.now(), models: list })
    return list
  } catch (err) {
    if (cached.models) return cached.models
    throw new Error(`cannot list your ChatGPT models: ${(err as Error).message}`)
  }
}
