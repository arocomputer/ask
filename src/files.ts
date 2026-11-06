// Source/npm entry point for confined filesystem tools; compiled releases use cli's __tool.
import { toolMain } from "./agent/tools.ts"

let input = ""
for await (const chunk of process.stdin) input += chunk
process.stdout.write(await toolMain(process.argv[2], input))
