// The child side of Code Mode. QuickJS runs only here, behind OS confinement; the host process
// owns the tools. No QuickJS handle or host function crosses the JSON-lines bridge.
import embedded from "./engine.cjs"
import { bounded, errorLimit, frames, maxCalls, object, outputLimit, send } from "./wire.ts"

const memory = 32 * 1024 * 1024
const cpu = 1500
const argsLimit = 64 * 1024

// The guest's side of the bridge, evaluated before the script. It is forgiving on purpose, since
// every script error costs a model turn: results read as text and carry fields, console output
// is kept, a script that returns nothing shows what its calls returned, and errors say where.
// Nothing here is a security boundary; the broker checks every call.
const bootstrap = String.raw`(bridge, names, source) => {
  const stringify = JSON.stringify
  const parse = JSON.parse
  const logs = []
  const calls = []
  const hidden = (value) => ({ value, writable: true, configurable: true })

  // A tool result prints as its text, works where a string does, and has the tool's fields.
  const proto = {}
  for (const name of Object.getOwnPropertyNames(String.prototype)) {
    const method = String.prototype[name]
    if (typeof method === "function" && name !== "constructor")
      Object.defineProperty(proto, name, hidden(function (...args) { return method.apply(this.text, args) }))
  }
  Object.defineProperty(proto, "length", { get() { return this.text.length } })
  for (const name of ["toString", "valueOf", "toJSON", Symbol.toPrimitive])
    Object.defineProperty(proto, name, hidden(function () { return this.text }))
  Object.defineProperty(proto, Symbol.iterator, hidden(function () { return this.text[Symbol.iterator]() }))
  const isResult = (value) => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === proto
  const result = (text, data) => {
    const r = Object.create(proto)
    for (const key of data ? Object.keys(data) : [])
      if (key !== "text") Object.defineProperty(r, key, { value: data[key], enumerable: true, writable: true, configurable: true })
    return Object.defineProperty(r, "text", { value: text })
  }

  const label = (name, args) => {
    for (const key of ["path", "command", "pattern", "query", "url", ""])
      if (typeof args[key] === "string") return name + " " + (args[key].length > 60 ? args[key].slice(0, 60) + "…" : args[key])
    return name
  }
  const plain = (key, value) => {
    if (!(value instanceof RegExp)) return value
    const flags = value.flags.replace(/[^ims]/g, "")
    return (flags ? "(?" + flags + ")" : "") + value.source
  }
  const invoke = async (name, args) => {
    // A bare value, as in tools.read("a.txt"), goes to the broker under "" to be matched to
    // the tool's one required parameter.
    if (typeof args === "string" || typeof args === "number" || isResult(args)) args = { "": isResult(args) ? args.text : args }
    if (args === null || typeof args !== "object" || Array.isArray(args))
      throw new TypeError("tools." + name + " takes one object of named arguments, like tools." + name + "({ ... })")
    const call = { label: label(name, args) }
    calls.push(call)
    try {
      const reply = parse(await bridge(name, stringify(args, plain)))
      call.text = reply.t
      return result(reply.t, reply.d)
    } catch (error) {
      call.error = error && error.message || String(error)
      throw new Error("tools." + name + ": " + call.error)
    }
  }
  const table = Object.create(null)
  for (const name of names) table[name] = (args = {}) => invoke(name, args)
  const tools = new Proxy(Object.freeze(table), {
    get(target, key) {
      if (typeof key !== "string" || key in target || key === "then" || key === "toJSON") return target[key]
      return () => { throw new Error("no tool named " + stringify(key) + "; the tools are " + (names.join(", ") || "(none)")) }
    },
  })
  Object.defineProperty(globalThis, "tools", { value: tools })
  Object.defineProperty(globalThis, "discover", { value: async (args = {}) => parse(await bridge(null, stringify(args))).v })

  const show = (value) => {
    if (typeof value === "string") return value
    if (isResult(value)) return value.text
    if (value instanceof Error) return String(value)
    try { return stringify(value) ?? String(value) }
    catch { return String(value) }
  }
  // Text inside JSON is escaped and hard to read or copy exactly, so results and multi-line
  // strings held in an object or array come out as labeled blocks instead.
  const render = (value) => {
    if (value !== null && typeof value === "object" && !isResult(value)) {
      const entries = (Array.isArray(value) ? value.map((v, i) => ["[" + i + "]", v]) : Object.entries(value)).map(([key, v]) => {
        const text = show(v)
        return [key, text, (typeof v === "string" || isResult(v)) && text.trim().includes("\n")]
      })
      if (entries.some(([, , long]) => long))
        return entries.map(([key, text, long]) => long ? "=== " + key + " ===\n" + text : key + ": " + text.trim()).join("\n")
    }
    return show(value)
  }
  const print = (...args) => { logs.push(args.length === 1 ? render(args[0]) : args.map(show).join(" ")) }
  Object.defineProperty(globalThis, "console", { value: Object.freeze({ log: print, info: print, warn: print, error: print, debug: print }) })
  // Output functions models carry over from other runtimes; a script's own names shadow them.
  for (const name of ["print", "text"]) Object.defineProperty(globalThis, name, hidden(print))

  const clip = (text, max) => text.length > max ? text.slice(0, max) + "\n[" + (text.length - max) + " more characters]" : text
  const finish = (value) => {
    const parts = logs.slice()
    if (value !== undefined && typeof value !== "function") parts.push(render(value))
    if (parts.length) return parts.join("\n") || "(empty)"
    if (!calls.length) return "(no output: the script returned nothing; end with \`return value\` or use console.log)"
    const each = calls.length === 1 ? Infinity : Math.max(400, Math.floor(16000 / calls.length))
    return "(nothing returned, so here is what each call returned; \`return\` a value to choose the output)\n" +
      calls.map((c) => "=== " + c.label + " ===\n" + (c.error === undefined ? clip(c.text ?? "(unfinished)", each) : "failed: " + c.error)).join("\n")
  }
  const lines = source.split("\n")
  const fail = (error) => {
    const known = error instanceof Error
    let message = known ? (error.name === "Error" ? "" : error.name + ": ") + error.message : show(error)
    const at = known && typeof error.stack === "string" ? /execute\.js:(\d+)/.exec(error.stack) : null
    const line = at ? Number(at[1]) - 1 : 0
    if (line >= 1 && line <= lines.length) message += " (line " + line + ": " + lines[line - 1].trim().slice(0, 120) + ")"
    if (/^ReferenceError: '?(require|process|fetch|fs|setTimeout|setInterval|Bun|Deno|window|document)\b/.test(message) || (/^SyntaxError/.test(message) && /^\s*(import|export)\b/m.test(source)))
      message += "\nScripts have no modules, timers or direct file or network access; use tools.* for those."
    const done = calls.filter((c) => c.text !== undefined).map((c) => c.label)
    if (done.length) message += "\nCalls that completed before the error: " + done.slice(0, 12).join("; ") + (done.length > 12 ? "; …" : "")
    if (logs.length) message += "\nOutput before the error:\n" + clip(logs.join("\n"), 6000)
    return message
  }
  // A final expression that is just a tool call, as in "await tools.a(); await tools.b()", was
  // written to see every call, not only the last one.
  const last = (value) => finish(isResult(value) && calls.length > 1 ? undefined : value)
  return [finish, fail, last]
}`

/** Evaluate one script from stdin, pump only its pending tool results, and report one outcome. */
export async function main(): Promise<void> {
  const input = frames(process.stdin)
  try {
    const start = (await input.next()).value
    if (!object(start) || typeof start.code !== "string" || !Array.isArray(start.names) || !start.names.every((s) => typeof s === "string"))
      throw new Error("invalid Code Mode start message")
    const result = await evaluate(start.code, start.names, async () => (await input.next()).value)
    send(process.stdout, { type: "done", output: result })
  } catch (error) {
    send(process.stdout, { type: "error", error: bounded(error instanceof Error ? error.message : "Code Mode failed", errorLimit) })
  } finally {
    // The broker closes the pipe after the terminal frame; don't wait for further input.
    process.stdin.destroy()
  }
}

/** Keep the guest heap and cumulative execution time bounded, including promise continuations. */
async function evaluate(code: string, names: string[], next: () => Promise<unknown>): Promise<string> {
  const quickjs = await embedded.engine()
  using runtime = quickjs.newRuntime()
  runtime.setMemoryLimit(memory)
  runtime.setMaxStackSize(512 * 1024)
  let remaining = cpu
  let deadline = Infinity
  let expired = false
  runtime.setInterruptHandler(() => expired ||= performance.now() >= deadline)
  using vm = runtime.newContext()
  const pending = new Map<number, ReturnType<typeof vm.newPromise>>()
  const outgoing: object[] = []
  let total = 0
  let exceeded = false
  let finalizing = false
  using bridge = vm.newFunction("tool", (name, args) => {
    if (finalizing) throw new Error("tool calls are not allowed while serializing a Code Mode result")
    if (++total > maxCalls) {
      exceeded = true
      throw new Error(`Code Mode allows at most ${maxCalls} nested calls`)
    }
    if (vm.typeof(args) !== "string") throw new Error("tool arguments must be a JSON object")
    const text = vm.getString(args)
    if (Buffer.byteLength(text) > argsLimit) throw new Error("nested tool arguments exceed 64 KiB")
    const parsed: unknown = JSON.parse(text)
    if (!object(parsed)) throw new Error("tool arguments must be a JSON object")
    const promise = vm.newPromise()
    pending.set(total, promise)
    outgoing.push({ type: "call", id: total, name: vm.typeof(name) === "string" ? vm.getString(name) : null, args: parsed })
    return promise.handle
  })
  using setup = vm.unwrapResult(vm.evalCode(bootstrap))
  using catalog = vm.unwrapResult(vm.evalCode(JSON.stringify(names)))
  using source = vm.newString(code)
  using formats = vm.unwrapResult(vm.callFunction(setup, vm.undefined, bridge, catalog, source))
  using serialize = vm.getProp(formats, 0)
  using describe = vm.getProp(formats, 1)
  using implicit = vm.getProp(formats, 2)

  /** Run guest code only inside its time budget; waiting for a tool does not spend CPU time. */
  function tick<T>(fn: () => T): T {
    const start = performance.now()
    deadline = start + remaining
    try { return fn() }
    finally { remaining -= performance.now() - start }
  }

  /** Check limits after transferring ownership of any handles returned by the guest. */
  function check() {
    if (expired || remaining <= 0) throw new Error("Code Mode CPU time limit exceeded")
    if (exceeded) throw new Error(`Code Mode allows at most ${maxCalls} nested calls`)
  }

  /** Format values inside the guest, under the same CPU and memory limits. */
  function format(handle: typeof vm.undefined, formatter: typeof serialize): string {
    finalizing = true
    const value = vm.callFunction(formatter, vm.undefined, handle)
    if (value.error) {
      value.error.dispose()
      throw new Error("Code Mode could not serialize the result")
    }
    return value.value.consume((s) => vm.getString(s))
  }

  /**
   * The script with its final expression statement returned, the way a REPL shows the last
   * value: models that write `rows.map(...).join("\n")` as the last line mean it as the result.
   * Only compiling decides where that statement starts, so nothing is guessed from the text:
   * the shortest tail whose head compiles alone is the last statement, and it is returned only
   * if it compiles as an expression. Lines keep their numbers.
   */
  function completed(script: string): string {
    const compiles = (body: string) => {
      const compiled = vm.evalCode(`(async () => {\n${body}\n})`, "execute.js", { compileOnly: true })
      const ok = !compiled.error
      ;(compiled.error ?? compiled.value).dispose()
      return ok
    }
    const text = script.replace(/[\s;]+$/, "")
    for (let at = text.length - 1, tries = 0; at >= -1 && tries < 48; at--) {
      if (at >= 0 && text[at] !== "\n" && text[at] !== ";") continue
      const head = text.slice(0, at + 1)
      const tail = text.slice(at + 1)
      // A line that opens with an operator or bracket continues the statement before it.
      if (!tail.trim() || (at >= 0 && text[at] === "\n" && /^\s*[-+*/%.,(\[?:&|=<>`]/.test(tail))) continue
      tries++
      if (!compiles(head)) continue
      const returned = `${head}return (${tail}\n)`
      return compiles(returned) ? returned : script
    }
    return script
  }

  let serializer = serialize
  try {
    const body = tick(() => completed(code))
    if (body !== code) serializer = implicit
    check()
    // One wrapper line precedes the script, which the guest subtracts from error positions.
    using initial = tick(() => vm.evalCode(`(async () => {\n${body}\n})()`, "execute.js"))
    check()
    if (initial.error) throw new Error(bounded(tick(() => format(initial.error!, describe)), errorLimit))
    const promise = initial.value
    for (;;) {
      using jobs = tick(() => runtime.executePendingJobs())
      check()
      if (jobs.error) throw new Error(bounded(tick(() => format(jobs.error!, describe)), errorLimit))
      const state = tick(() => vm.getPromiseState(promise))
      if (state.type === "rejected") {
        using error = state.error
        check()
        const text = tick(() => format(error, describe))
        check()
        throw new Error(bounded(text, errorLimit))
      }
      if (state.type === "fulfilled") {
        using value = state.value
        check()
        if (pending.size) throw new Error("Code Mode finished with pending tool calls; await all calls that matter")
        const text = tick(() => format(value, serializer))
        check()
        return bounded(text, outputLimit)
      }
      check()
      if (!pending.size) throw new Error("Code Mode is waiting for a promise that cannot resolve")
      for (const call of outgoing.splice(0)) send(process.stdout, call)
      const response = await next()
      if (!object(response) || response.type !== "result" || typeof response.id !== "number")
        throw new Error("invalid Code Mode tool result")
      const waiting = pending.get(response.id)
      if (!waiting) throw new Error("unexpected Code Mode tool result")
      pending.delete(response.id)
      using deferred = waiting
      if (typeof response.error === "string") {
        using err = vm.newError(response.error)
        deferred.reject(err)
      } else if ("value" in response || typeof response.output === "string") {
        // t/d: a tool result's text and fields; v: a plain value, as discover returns.
        using text = vm.newString(JSON.stringify("value" in response ? { v: response.value } : { t: response.output, d: object(response.data) ? response.data : undefined }))
        deferred.resolve(text)
      } else throw new Error("invalid Code Mode result value")
    }
  } catch (err) {
    check()
    throw err
  } finally {
    for (const promise of pending.values()) promise.dispose()
  }
}
