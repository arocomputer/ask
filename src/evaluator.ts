// Source/npm entry point for Code Mode. A compiled release uses cli's __execute instead.
import { main } from "./sandbox/evaluate.ts"

await main()
