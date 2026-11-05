// Package packages holds the official agent packages, built into ask: each folder here
// is a package that ask install NAME writes to ~/.ask/packages/ask/packages/NAME.
// ./x integration runs their adapter tests and real-ask integration checks with simulated CLIs.
package packages

import "embed"

// FS holds what an installed package needs: its agents, the code they run and its README.
//
//go:embed */agents */lib */README.md
var FS embed.FS
