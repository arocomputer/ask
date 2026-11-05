// Package extensions holds the two extensions ask ships, Claude Code and Codex as external
// harnesses, built into the binary: each folder is an extension.json, a launcher, its scripts
// and a README, which ask install NAME writes to ~/.ask/agent/extensions/NAME. They are
// optional; ask's own harness needs neither.
package extensions

import "embed"

// FS holds what an installed extension needs. Tests and fixtures stay out of the binary.
//
//go:embed claude/extension.json claude/claude claude/*.mjs claude/README.md codex/extension.json codex/codex codex/*.mjs codex/README.md
var FS embed.FS
