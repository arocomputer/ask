// The child side of Code Mode. QuickJS runs only here, behind OS confinement; the host process
// owns the tools. No QuickJS handle or host function crosses the JSON-lines bridge.
import embedded from "./engine.cjs"
import { bounded, frames, maxCalls, object, outputLimit, send } from "./wire.ts"

const memory = 32 * 1024 * 1024
const cpu = 1500
const argsLimit = 64 * 1024

// Capture intrinsics before evaluating the snippet. The guest gets wrappers, never the bridge.
const bootstrap = `(bridge, names) => {
  const stringify = JSON.stringify
  const parse = JSON.parse
  const slice = Function.call.bind(String.prototype.slice)
  const invoke = async (name, args) => {
    const reply = await bridge(name, stringify(args))
    const text = slice(reply, 1)
    return reply[0] === "j" ? parse(text) : text
  }
  const tools = Object.create(null)
  for (const name of names) tools[name] = (args = {}) => invoke(name, args)
  Object.defineProperty(globalThis, "tools", { value: Object.freeze(tools) })
  Object.defineProperty(globalThis, "discover", { value: (args = {}) => invoke(null, args) })
  const string = String
  return [
    value => typeof value === "string" ? value : stringify(value) ?? "(no output)",
    error => string(error),
  ]
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
    send(process.stdout, { type: "error", error: bounded(error instanceof Error ? error.message : "Code Mode failed", 4096) })
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
  using formats = vm.unwrapResult(vm.callFunction(setup, vm.undefined, bridge, catalog))
  using serialize = vm.getProp(formats, 0)
  using describe = vm.getProp(formats, 1)

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

  try {
    using initial = tick(() => vm.evalCode(`(async () => {\n"use strict";\n${code}\n})()`, "execute.js"))
    check()
    if (initial.error) throw new Error(bounded(tick(() => format(initial.error!, describe)), 4096))
    const promise = initial.value
    for (;;) {
      using jobs = tick(() => runtime.executePendingJobs())
      check()
      if (jobs.error) throw new Error(bounded(tick(() => format(jobs.error!, describe)), 4096))
      const state = tick(() => vm.getPromiseState(promise))
      if (state.type === "rejected") {
        using error = state.error
        check()
        const text = tick(() => format(error, describe))
        check()
        throw new Error(bounded(text, 4096))
      }
      if (state.type === "fulfilled") {
        using value = state.value
        check()
        if (pending.size) throw new Error("Code Mode finished with pending tool calls; await all calls that matter")
        const text = tick(() => format(value, serialize))
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
      } else if (typeof response.output === "string") {
        using text = vm.newString((response.json === true ? "j" : "s") + response.output)
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
