package packages

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	official "github.com/arocomputer/ask/packages"
	"github.com/arocomputer/ask/src/home"
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
// it beside the old one first; launchers under agents/ are executable, sidecars are data.
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
		if strings.HasPrefix(rel, "agents/") && !strings.HasSuffix(rel, ".environment.json") {
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
	return replaceBuiltin(dir, tmp)
}

// replaceBuiltin retains the old tree until the new tree is in place. A fixed backup name
// lets the next writer recover if this process exits between the two renames.
// The caller holds the package lock.
func replaceBuiltin(dir, tmp string) error {
	backup := filepath.Join(filepath.Dir(dir), "."+filepath.Base(dir)+".previous")
	hadOld := false
	if err := os.Rename(dir, backup); err == nil {
		hadOld = true
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(tmp, dir); err != nil {
		if hadOld {
			if restore := os.Rename(backup, dir); restore != nil {
				return fmt.Errorf("%w; previous installation remains at %s; restore failed: %v", err, backup, restore)
			}
		}
		return err
	}
	if err := os.RemoveAll(backup); err != nil {
		return fmt.Errorf("installed replacement, but could not remove backup %s: %w", backup, err)
	}
	return nil
}

// lockBuiltin serializes the check, recovery and replacement across ask processes. The lock
// file stays in place: unlinking it would let later writers lock a different inode.
func lockBuiltin(p home.Paths, name string) (*os.File, error) {
	dir := BuiltinDir(p, name)
	if err := os.MkdirAll(filepath.Dir(dir), 0755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(filepath.Dir(dir), "."+name+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// recoverBuiltin restores an interrupted replacement, or removes its backup after promotion.
func recoverBuiltin(dir string) error {
	backup := filepath.Join(filepath.Dir(dir), "."+filepath.Base(dir)+".previous")
	if _, err := os.Lstat(backup); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return err
	}
	if _, err := os.Lstat(dir); os.IsNotExist(err) {
		if err := os.Rename(backup, dir); err != nil {
			return fmt.Errorf("restore previous installation from %s: %w", backup, err)
		}
		return nil
	} else if err != nil {
		return err
	}
	return os.RemoveAll(backup)
}

// InstallBuiltin installs a built-in package, or brings an installed copy up to this build.
func InstallBuiltin(p home.Paths, name string) (string, error) {
	return installBuiltin(p, name, false)
}

func installBuiltin(p home.Paths, name string, onlyInstalled bool) (string, error) {
	if !Builtin(name) {
		return "", home.Usage("no official agent %q", name)
	}
	lock, err := lockBuiltin(p, name)
	if err != nil {
		return "", err
	}
	defer lock.Close()
	dir := BuiltinDir(p, name)
	if err := recoverBuiltin(dir); err != nil {
		return "", err
	}
	label, _ := filepath.Rel(p.Packages, dir)
	_, e := os.Stat(dir)
	if e != nil && !os.IsNotExist(e) {
		return "", e
	}
	existed := e == nil
	if !existed && onlyInstalled {
		return "", nil
	}
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

// Refresh brings installed built-ins up to this build and recovers interrupted replacements.
// Errors identify each package; callers may warn and continue using the previous installation.
func Refresh(p home.Paths) error {
	var failures []error
	for _, name := range Builtins() {
		dir := BuiltinDir(p, name)
		_, err := os.Lstat(dir)
		if os.IsNotExist(err) {
			_, err = os.Lstat(filepath.Join(filepath.Dir(dir), "."+name+".previous"))
			if os.IsNotExist(err) {
				continue
			}
		}
		if err == nil {
			_, err = installBuiltin(p, name, true)
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("refresh %s: %w", name, err))
		}
	}
	return errors.Join(failures...)
}
