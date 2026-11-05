// ask as a library. `handle` takes the same JSON requests as the command line; the loop,
// catalog and provider clients underneath are exported for hosts that run turns themselves.

export { handle, type Request, type Response, type Result, type Task } from "./protocol.ts"
export { home } from "./home.ts"
export { run, type Failure, type RunOptions, type RunResult } from "./loop.ts"
export { connect, find, load, source, type Catalog, type Model } from "./catalog.ts"
export { withRetries, ProviderError, type Message, type Provider, type Usage } from "./provider.ts"
export { tools, type Tool } from "./tools.ts"
export { instructions } from "./system.ts"
