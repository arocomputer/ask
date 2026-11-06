// ask as a library. `handle` takes the same JSON requests as the command line; the loop,
// catalog and provider clients underneath are exported for hosts that run turns themselves,
// and the types for people writing extensions.

export { handle, type Request, type Response, type Result, type Task } from "./sessions/protocol.ts"
export { home } from "./base/home.ts"
export { run, type Failure, type RunOptions, type RunResult } from "./agent/loop.ts"
export { connect, find, load, source, type Catalog, type Model } from "./providers/catalog.ts"
export { withRetries, ProviderError, type Message, type Provider, type Usage } from "./providers/stream.ts"
export { tools, type Tool } from "./agent/tools.ts"
export { search, web, type Engine, type Result as SearchResult } from "./agent/search.ts"
export { type Context, type Models, type Ask } from "./agent/context.ts"
export { instructions } from "./agent/system.ts"
export { type Extension, type Harness, type Outcome, type Run, type Settings, type Status } from "./harnesses/harness.ts"
