// Package packages installs and updates plain git repositories; no package code runs at install.
package packages

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/arocomputer/ask/internal/find"
	"github.com/arocomputer/ask/internal/home"
)

// git disables interactive prompts and reports the last stderr line on failure.
func git(args []string, dir string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	b, e := cmd.Output()
	if e != nil {
		why := home.Trim(stderr.String())
		if why == "" {
			why = e.Error()
		}
		bits := strings.Split(why, "\n")
		return "", fmt.Errorf("%s", bits[len(bits)-1])
	}
	return string(b), nil
}

var shorthand = regexp.MustCompile(`^\w[\w-]*/[\w.-]+$`)

// bare is a source without a slash or dot, which names a built-in package, like claude.
var bare = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

var sourcePattern = regexp.MustCompile(`^(?:[a-z][a-z0-9+.-]*://(?:[^@/]+@)?|[\w.-]+@)?([\w.-]+)[/:]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$`)

// Locate resolves an official agent name, GitHub shorthand, a git URL or a local path to its
// installation directory. A bare NAME always means a package built into ask, with no URL, and
// OWNER/REPO always means GitHub, whatever folders are here; any other source that exists on
// disk, like ./tools, is a local repository.
// A URL's host, owner and repository become the directory's three names, so none may be
// empty, "." or "..", or start with "-", and the directory always stays inside packages.
func Locate(p home.Paths, source string) (string, string, error) {
	if bare.MatchString(source) {
		if !Builtin(source) {
			return "", "", home.Usage("no official agent %q; ask installs %s by name, and other packages as OWNER/REPO, a git URL or ./path", source, strings.Join(Builtins(), ", "))
		}
		return "", BuiltinDir(p, source), nil
	}
	if shorthand.MatchString(source) {
		source = "https://github.com/" + source
	} else if _, e := os.Stat(source); e == nil {
		path, _ := filepath.Abs(source)
		name := strings.TrimSuffix(filepath.Base(path), ".git")
		if name == "" || name == "." || name == ".." {
			return "", "", home.Usage("cannot install %s: its folder name leaves no package name", source)
		}
		return path, filepath.Join(p.Packages, "local", filepath.Base(filepath.Dir(path)), name), nil
	}
	m := sourcePattern.FindStringSubmatch(source)
	if m == nil || strings.HasPrefix(source, "-") {
		return "", "", home.Usage("cannot tell where %s lives; give OWNER/REPO or a git URL", source)
	}
	for _, part := range m[1:] {
		if part == "." || part == ".." || strings.HasPrefix(part, "-") {
			return "", "", home.Usage("cannot tell where %s lives; give OWNER/REPO or a git URL", source)
		}
	}
	return source, filepath.Join(p.Packages, m[1], m[2], m[3]), nil
}

// Contents describes directory entries, including nonexecutables, just as the existing CLI does.
func Contents(dir string) string {
	parts := []string{}
	for _, kind := range []string{"agents", "hooks", "commands"} {
		names := find.List(filepath.Join(dir, kind))
		if len(names) > 0 {
			parts = append(parts, kind+": "+strings.Join(names, ", "))
		}
	}
	if len(parts) == 0 {
		return "nothing ask uses"
	}
	return strings.Join(parts, " · ")
}

// Installed returns packages in path order as name and directory pairs.
func Installed(p home.Paths) []find.Executable {
	all := []find.Executable{}
	for _, dir := range find.PackageDirs(p) {
		name, _ := filepath.Rel(p.Packages, dir)
		all = append(all, find.Executable{Name: name, Path: dir})
	}
	return all
}

// Update pulls fast-forward only and reports whether HEAD changed; a built-in package is
// brought up to this ask's build instead.
func Update(p home.Paths, dir string) (string, error) {
	if filepath.Dir(dir) == filepath.Dir(BuiltinDir(p, "x")) && Builtin(filepath.Base(dir)) {
		return InstallBuiltin(p, filepath.Base(dir))
	}
	before, e := git([]string{"rev-parse", "HEAD"}, dir)
	if e != nil {
		return "", e
	}
	if _, e = git([]string{"pull", "--quiet", "--ff-only"}, dir); e != nil {
		return "", e
	}
	after, e := git([]string{"rev-parse", "HEAD"}, dir)
	if e != nil {
		return "", e
	}
	name, _ := filepath.Rel(p.Packages, dir)
	status := "updated"
	if home.Trim(before) == home.Trim(after) {
		status = "up to date"
	}
	return name + ": " + status, nil
}

// Install clones a package, or updates the installation in its place when that came from the
// same source; a different source there is a usage error, since only one fits.
func Install(p home.Paths, source string) (string, error) {
	url, dir, e := Locate(p, source)
	if e != nil {
		return "", e
	}
	if url == "" {
		return InstallBuiltin(p, source)
	}
	if _, e := os.Stat(dir); e == nil {
		origin, _ := git([]string{"config", "--get", "remote.origin.url"}, dir)
		if plain(origin) != plain(url) {
			name, _ := filepath.Rel(p.Packages, dir)
			return "", home.Usage("%s is installed from %s; remove it first", name, home.Trim(origin))
		}
		return Update(p, dir)
	}
	if e = os.MkdirAll(filepath.Dir(dir), 0777); e != nil {
		return "", e
	}
	if _, e = git([]string{"clone", "--quiet", "--", url, dir}, ""); e != nil {
		return "", e
	}
	name, _ := filepath.Rel(p.Packages, dir)
	return "installed " + name + ": " + Contents(dir), nil
}

// plain drops what may differ between two spellings of one source: spaces, a trailing "/" or ".git".
func plain(source string) string {
	return strings.TrimSuffix(strings.TrimSuffix(home.Trim(source), "/"), ".git")
}

// Remove removes exactly one full or suffix-matched package, rejecting ambiguous names.
func Remove(p home.Paths, name string) (string, error) {
	matches := []find.Executable{}
	for _, x := range Installed(p) {
		if x.Name == name || strings.HasSuffix(x.Name, "/"+name) {
			matches = append(matches, x)
		}
	}
	if len(matches) != 1 {
		if len(matches) == 0 {
			return "", home.Usage("no package %s; see `ask packages`", name)
		}
		names := []string{}
		for _, x := range matches {
			names = append(names, x.Name)
		}
		return "", home.Usage("%s matches %s; name one in full", name, strings.Join(names, " and "))
	}
	if e := os.RemoveAll(matches[0].Path); e != nil {
		return "", e
	}
	return "removed " + matches[0].Name, nil
}
