package packages

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/arocomputer/ask/internal/home"
	official "github.com/arocomputer/ask/packages"
)

// stampFile records which build of a built-in package is installed.
const stampFile = ".ask-version"

// Builtin reports whether name is an official package built into ask, like claude.
func Builtin(name string) bool {
	if name == "" || strings.ContainsAny(name, "/.\\") {
		return false
	}
	info, e := fs.Stat(official.FS, name)
	return e == nil && info.IsDir()
}

// Builtins lists the official packages built into ask.
func Builtins() []string {
	entries, _ := fs.ReadDir(official.FS, ".")
	names := []string{}
	for _, d := range entries {
		if d.IsDir() {
			names = append(names, d.Name())
		}
	}
	return names
}

// BuiltinDir is where the built-in package name is installed: packages/ask/packages/NAME.
func BuiltinDir(p home.Paths, name string) string {
	return filepath.Join(p.Packages, "ask", "packages", name)
}

// stamp identifies a built-in package's content, so a copy from another ask build is rewritten.
func stamp(name string) string {
	h := sha256.New()
	fs.WalkDir(official.FS, name, func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := fs.ReadFile(official.FS, path)
			h.Write([]byte(path + "\x00"))
			h.Write(b)
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// current reports whether the installed copy of a built-in package is this build's.
func current(p home.Paths, name string) bool {
	b, e := os.ReadFile(filepath.Join(BuiltinDir(p, name), stampFile))
	return e == nil && strings.TrimSpace(string(b)) == stamp(name)
}

// writeBuiltin replaces the installed copy of a built-in package with this build's, assembling
// it beside the old one first; files under agents/ are executable.
func writeBuiltin(p home.Paths, name string) error {
	dir := BuiltinDir(p, name)
	if e := os.MkdirAll(filepath.Dir(dir), 0755); e != nil {
		return e
	}
	tmp, e := os.MkdirTemp(filepath.Dir(dir), "."+name+"-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(tmp)
	e = fs.WalkDir(official.FS, name, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(path, name), "/")
		target := filepath.Join(tmp, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		b, err := fs.ReadFile(official.FS, path)
		if err != nil {
			return err
		}
		mode := os.FileMode(0644)
		if strings.HasPrefix(rel, "agents/") {
			mode = 0755
		}
		return os.WriteFile(target, b, mode)
	})
	if e == nil {
		e = os.WriteFile(filepath.Join(tmp, stampFile), []byte(stamp(name)+"\n"), 0644)
	}
	if e != nil {
		return e
	}
	if e = os.RemoveAll(dir); e != nil {
		return e
	}
	return os.Rename(tmp, dir)
}

// InstallBuiltin installs a built-in package, or brings an installed copy up to this build.
func InstallBuiltin(p home.Paths, name string) (string, error) {
	dir := BuiltinDir(p, name)
	label, _ := filepath.Rel(p.Packages, dir)
	_, e := os.Stat(dir)
	existed := e == nil
	if existed && current(p, name) {
		return label + ": up to date", nil
	}
	if e := writeBuiltin(p, name); e != nil {
		return "", e
	}
	if existed {
		return label + ": updated", nil
	}
	return "installed " + label + ": " + Contents(dir), nil
}

// Refresh rewrites every installed built-in package that another ask build wrote, so official
// agents always match the ask that runs them. Errors leave the old copy in place.
func Refresh(p home.Paths) {
	for _, name := range Builtins() {
		if _, e := os.Stat(BuiltinDir(p, name)); e == nil && !current(p, name) {
			writeBuiltin(p, name)
		}
	}
}
