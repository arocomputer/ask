// Build entry for the checked-in evaluator engine; not loaded by ask at runtime.
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core"
import release from "@jitl/quickjs-singlefile-cjs-release-sync"

export const engine = () => newQuickJSWASMModuleFromVariant(release)
