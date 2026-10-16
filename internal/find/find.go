// Package find discovers local and packaged executables; local names always win.
package find

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"syscall"

	"github.com/arocomputer/ask/internal/home"
)

// Name is the accepted agent, hook and command name pattern.
var Name = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

// List returns sorted directory entry names, or an empty list for unreadable directories.
func List(dir string) []string {
	entries, e := os.ReadDir(dir)
	names := []string{}
	if e == nil {
		for _, d := range entries {
			names = append(names, d.Name())
		}
	}
	return names
}

// PackageDirs returns all three-level package folders in path order.
func PackageDirs(p home.Paths) []string {
	dirs := []string{}
	for _, host := range List(p.Packages) {
		for _, owner := range List(filepath.Join(p.Packages, host)) {
			for _, repo := range List(filepath.Join(p.Packages, host, owner)) {
				dirs = append(dirs, filepath.Join(p.Packages, host, owner, repo))
			}
		}
	}
	return dirs
}

// Executable is a discovered name and its path.
type Executable struct{ Name, Path string }

// Find returns executables in discovery order, ignoring invalid names and duplicates.
func Find(p home.Paths, kind string) []Executable {
	dirs := []string{filepath.Join(p.Home, kind)}
	for _, dir := range PackageDirs(p) {
		dirs = append(dirs, filepath.Join(dir, kind))
	}
	found := []Executable{}
	seen := map[string]bool{}
	for _, dir := range dirs {
		for _, name := range List(dir) {
			path := filepath.Join(dir, name)
			info, e := os.Stat(path)
			if Name.MatchString(name) && !seen[name] && e == nil && info.Mode().IsRegular() && syscall.Access(path, 1) == nil {
				seen[name] = true
				found = append(found, Executable{name, path})
			}
		}
	}
	return found
}

// Sorted returns executables ordered by name, as agents and hooks require.
func Sorted(p home.Paths, kind string) []Executable {
	all := Find(p, kind)
	sort.Slice(all, func(i, j int) bool { return all[i].Name < all[j].Name })
	return all
}

// Path finds the first executable with a given name, or the empty string.
func Path(p home.Paths, kind, name string) string {
	for _, x := range Find(p, kind) {
		if x.Name == name {
			return x.Path
		}
	}
	return ""
}
