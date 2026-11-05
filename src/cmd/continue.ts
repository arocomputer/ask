// ask continue ID PROMPT: give a finished session its next turn.

import { parseArgs } from "node:util"
import { resolve, type Home } from "../home.ts"
import { latest, now, open, save, status } from "../sessions.ts"
import { begin, block, started, stdin, timeout, Usage } from "./common.ts"
import { schema } from "./run.ts"

export const help = `Give a finished session its next prompt. It keeps the whole conversation.

USAGE
  ask continue <id> <prompt> [flags]

FLAGS
  -m, --model provider/model   Switch models for this turn (default: the last turn's)
  -w, --write                  Let this turn edit files and run commands
  -e, --effort level           Reasoning effort
      --timeout seconds        Stop after this long
      --schema json            A JSON Schema the answer must match
      --wait                   Block until it finishes and print the answer
      --json                   Print the result as JSON

EXAMPLES
  $ ask continue k3f9a2 "Now add a test for it"
`

export async function run(h: Home, argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      model: { type: "string", short: "m" },
      write: { type: "boolean", short: "w" },
      effort: { type: "string", short: "e" },
      timeout: { type: "string" },
      schema: { type: "string" },
      wait: { type: "boolean" },
      json: { type: "boolean" },
    },
  })
  const [id, ...words] = positionals
  if (!id) throw new Usage("give a session id and a prompt", 'ask continue k3f9a2 "Now add a test"')
  const s = open(h, id)
  let prompt = words.join(" ").trim()
  const piped = (await stdin()).trim()
  if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped
  if (!prompt) throw new Usage("give a prompt for the next turn", `ask continue ${s.id} "Now add a test"`)
  const state = status(s).state
  if (state === "running" || state === "retrying") throw new Usage(`${s.id} is still running`, `ask wait ${s.id}, or ask stop ${s.id}`)
  const last = latest(s)
  const { model } = await resolve(h, v.model ?? last.model)
  s.turns.push({
    prompt,
    model: `${model.provider}/${model.id}`,
    write: !!v.write,
    effort: v.effort ?? (v.model ? undefined : last.effort),
    schema: schema(v.schema),
    timeout: timeout(h, v.timeout),
    state: "running",
    started: now(),
  })
  save(s)
  begin(s, () => {
    s.turns.pop()
    save(s)
  })
  if (v.wait) return block(s, !!v.json)
  started(s, !!v.json)
  return 0
}
