// Bounded JSON lines between the evaluator and its broker. Neither side sends live objects.
import type { Readable, Writable } from "node:stream"

const frameLimit = 1024 * 1024
export const maxCalls = 32
export const outputLimit = 64 * 1024
/** Room for an error with the calls and console output that preceded it. */
export const errorLimit = 12 * 1024

/** Read complete frames without buffering an unbounded line from a child. */
export async function* frames(stream: Readable): AsyncGenerator<unknown> {
  let chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    for (let from = 0; from < chunk.length;) {
      const end = chunk.indexOf(10, from)
      const part = chunk.subarray(from, end < 0 ? chunk.length : end)
      if ((bytes += part.length) > frameLimit) throw new Error("Code Mode message too large")
      chunks.push(part)
      if (end < 0) break
      const line = Buffer.concat(chunks, bytes).toString("utf8")
      chunks = []
      bytes = 0
      from = end + 1
      yield JSON.parse(line)
    }
  }
  if (bytes) throw new Error("incomplete Code Mode message")
}

/** Write one complete frame; the caller owns the stream and its lifecycle. */
export function send(stream: Writable, frame: object): void {
  const line = JSON.stringify(frame)
  if (Buffer.byteLength(line) > frameLimit) throw new Error("Code Mode message too large")
  stream.write(line + "\n")
}

/** Object-shaped data accepted by both ends of the bridge. */
export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Keep a result within its transport/output budget even with multibyte text. */
export function bounded(text: string, limit: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= limit) return text
  return bytes.subarray(0, limit - 64).toString("utf8") + "\n[output truncated; return a smaller selection]"
}
