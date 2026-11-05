package extension

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/arocomputer/ask/extensions"
	"github.com/arocomputer/ask/internal/config"
)

// installed is the file ask writes into a folder it installed: where it came from and, for a
// built-in, the ask version that wrote it. A folder without it is yours, and install never
// replaces it.
const installed = ".installed"

// Builtin lists the extensions built into ask, by folder name.
func Builtin() []string {
	entries, _ := fs.ReadDir(extensions.FS, ".")
	names := []string{}
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names
}

// IsBuiltin reports whether ask ships an extension by that name.
func IsBuiltin(name string) bool {
	for _, b := range Builtin() {
		if b == name {
			return true
		}
	}
	return false
}

var repoName = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// Install adds an extension from a source: a built-in name (claude, codex), a local folder,
// or a git repository (owner/repo on GitHub, or any URL git can clone). It returns the name
// it was installed under: the folder's or repository's own name.
func Install(p config.Paths, source, version string) (string, error) {
	if err := os.MkdirAll(p.Extensions, 0755); err != nil {
		return "", err
	}
	// Stage beside the destination, so the final rename never crosses filesystems.
	tmp, err := os.MkdirTemp(p.Extensions, ".install-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	stage := filepath.Join(tmp, "x")
	name, origin := "", source
	switch {
	case IsBuiltin(source):
		name, origin = source, "builtin"
		if err := copyFS(extensions.FS, source, stage); err != nil {
			return "", err
		}
	case strings.Contains(source, "://") || strings.HasSuffix(source, ".git") || repoName.MatchString(source) && !exists(source):
		url := source
		if repoName.MatchString(source) {
			url = "https://github.com/" + source
		}
		name = strings.TrimSuffix(filepath.Base(strings.TrimSuffix(url, "/")), ".git")
		cmd := exec.Command("git", "clone", "--quiet", "--depth", "1", url, stage)
		if out, err := cmd.CombinedOutput(); err != nil {
			return "", errors.New("cannot clone " + url + ": " + config.Trim(string(out)))
		}
		_ = os.RemoveAll(filepath.Join(stage, ".git"))
	default:
		dir, err := filepath.Abs(source)
		if err != nil {
			return "", err
		}
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			return "", config.Usage("%s is not a built-in extension (%s), a folder or a git repository", source, strings.Join(Builtin(), ", "))
		}
		name, origin = filepath.Base(dir), dir
		if err := copyFS(os.DirFS(dir), ".", stage); err != nil {
			return "", err
		}
	}
	stamp := origin + "\n"
	if origin == "builtin" {
		stamp = "builtin " + version + "\n"
	}
	if err := os.WriteFile(filepath.Join(stage, installed), []byte(stamp), 0644); err != nil {
		return "", err
	}
	markExecutable(stage)
	if e := Load(stage); e.Err != nil {
		return "", errors.New(source + ": " + e.Err.Error())
	}
	dest := filepath.Join(p.Extensions, name)
	if _, err := os.Stat(dest); err == nil {
		if _, err := os.Stat(filepath.Join(dest, installed)); err != nil {
			return "", config.Usage("%s is your own extension; ask remove %s first to replace it", dest, name)
		}
	}
	_ = os.RemoveAll(dest)
	if err := os.Rename(stage, dest); err != nil {
		return "", err
	}
	return name, nil
}

// markExecutable makes every command the manifest names executable: files embedded in the
// binary lose their mode, and a downloaded tree may have lost it too.
func markExecutable(dir string) {
	e := Extension{Dir: dir}
	b, err := os.ReadFile(filepath.Join(dir, "extension.json"))
	if err != nil || json.Unmarshal(b, &e.Manifest) != nil {
		return
	}
	paths := []string{}
	if e.Harness != nil {
		paths = append(paths, e.Harness.Command)
	}
	for _, t := range e.Tools {
		paths = append(paths, t.Command)
	}
	for _, c := range e.Commands {
		paths = append(paths, c)
	}
	for _, rel := range paths {
		if full, err := e.file(rel); err == nil {
			_ = os.Chmod(full, 0755)
		}
	}
}

// Remove deletes an installed extension, yours or ask's.
func Remove(p config.Paths, name string) error {
	if name == "" || strings.ContainsAny(name, "/\\") || strings.HasPrefix(name, ".") {
		return config.Usage("ask remove takes an extension's name; see ask extensions")
	}
	dest := filepath.Join(p.Extensions, name)
	if _, err := os.Stat(dest); err != nil {
		return config.Usage("no extension %s; see ask extensions", name)
	}
	return os.RemoveAll(dest)
}

// Refresh reinstalls a built-in extension written by another ask version, so an installed
// copy always matches the binary that runs it. Your own folders are left alone.
func Refresh(p config.Paths, version string) {
	for _, name := range Builtin() {
		b, err := os.ReadFile(filepath.Join(p.Extensions, name, installed))
		if err != nil || !strings.HasPrefix(string(b), "builtin ") || config.Trim(strings.TrimPrefix(string(b), "builtin ")) == version {
			continue
		}
		_, _ = Install(p, name, version)
	}
}

// Source says where an installed extension came from: "builtin", a path or URL, or "" for yours.
func Source(e Extension) string {
	b, err := os.ReadFile(filepath.Join(e.Dir, installed))
	if err != nil {
		return ""
	}
	s := config.Trim(string(b))
	if strings.HasPrefix(s, "builtin ") {
		return "builtin"
	}
	return s
}

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

// copyFS copies a tree, keeping executables executable and leaving out tests and git data.
func copyFS(src fs.FS, root, dest string) error {
	return fs.WalkDir(src, root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(strings.TrimPrefix(path, root), "/")
		if d.IsDir() && (d.Name() == ".git" || d.Name() == "test" && rel == "test") {
			return fs.SkipDir
		}
		target := filepath.Join(dest, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		b, err := fs.ReadFile(src, path)
		if err != nil {
			return err
		}
		mode := os.FileMode(0644)
		if info, err := d.Info(); err == nil && info.Mode()&0111 != 0 {
			mode = 0755
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		return os.WriteFile(target, b, mode)
	})
}
