// Command ask hands tasks to local coding agents and records their answers.
package main

import (
	"os"
	"runtime/debug"

	"github.com/arocomputer/ask/internal/cli"
)

// version is injected by release linker flags; without them, a go install build reports the
// module version it was installed at, and any other build reports dev.
var version = "dev"

// main delegates the CLI and exits with its contract status.
func main() {
	if info, ok := debug.ReadBuildInfo(); ok && version == "dev" && info.Main.Version != "" && info.Main.Version != "(devel)" {
		version = info.Main.Version
	}
	os.Exit(cli.Main(os.Args[1:], version))
}
