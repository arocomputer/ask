// ask stop ID...: stop running sessions.

import type { Home } from "../home.ts"
import { latest, now, open, save, status, unlock, worker } from "../sessions.ts"
import { style } from "../term.ts"
import { Usage } from "./common.ts"

export const help = `Stop running sessions. A stopped session can be continued.

USAGE
  ask stop <id>...
`

export async function run(h: Home, argv: string[]): Promise<number> {
  if (!argv.length) throw new Usage("give the session ids to stop", "ask stop k3f9a2")
  const st = style()
  let code = 0
  for (const id of argv) {
    const s = open(h, id)
    const pid = worker(s)
    if (!pid) {
      process.stdout.write(`${st.gray("-")} ${st.cyan(s.id)} wasn't running ${st.gray(`(${status(s).state})`)}\n`)
      continue
    }
    process.kill(pid, "SIGTERM")
    let gone = await until(() => !worker(s), 10_000)
    if (!gone) {
      process.kill(pid, "SIGKILL")
      gone = await until(() => !worker(s), 2_000)
    }
    const t = latest(open(h, id))
    if (t.state === "running" || t.state === "retrying") {
      const fresh = open(h, id)
      Object.assign(latest(fresh), { state: "stopped", finished: now() })
      save(fresh)
      unlock(fresh)
    }
    if (gone) process.stdout.write(`${st.green("✓")} Stopped ${st.cyan(s.id)}\n`)
    else {
      process.stderr.write(`${st.red("X")} ${s.id} did not stop (pid ${pid})\n`)
      code = 1
    }
  }
  return code
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await new Promise((ok) => setTimeout(ok, 50))
  }
  return test()
}
