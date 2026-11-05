// Command ask hands a task to a subagent and records what it did.
package main

import (
	"os"
	"regexp"
	"runtime/debug"

	"github.com/arocomputer/ask/internal/cmd/root"
)

// version is injected by release linker flags; without them, a go install build reports the
// tag it was installed at, and any other build, including one Go stamps with a pseudo-version
// from the checkout, reports dev.
var version = "dev"

var pseudo = regexp.MustCompile(`-(0\.)?\d{14}-[0-9a-f]{12}(\+dirty)?$`)

func main() {
	if info, ok := debug.ReadBuildInfo(); ok && version == "dev" {
		if v := info.Main.Version; v != "" && v != "(devel)" && !pseudo.MatchString(v) {
			version = v
		}
	}
	os.Exit(root.Main(os.Args[1:], version))
}
