// Command ask hands a task to a subagent and records what it did.
package main

import (
	"os"
	"runtime/debug"

	"github.com/arocomputer/ask/internal/cmd/root"
)

// version is injected by release linker flags; without them, a go install build reports the
// module version it was installed at, and any other build reports dev.
var version = "dev"

func main() {
	if info, ok := debug.ReadBuildInfo(); ok && version == "dev" && info.Main.Version != "" && info.Main.Version != "(devel)" {
		version = info.Main.Version
	}
	os.Exit(root.Main(os.Args[1:], version))
}
