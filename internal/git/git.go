// Package git compares files and modes across write runs and manages isolated worktrees.
package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/arocomputer/ask/internal/home"
)

// git returns output and success, silently handling repositories without a HEAD.
// It turns off core.fsmonitor, so a write run cannot plant a command for ask's own git calls to run.
func git(dir string, args []string, input string) (string, bool) {
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "core.fsmonitor=false"}, args...)...)
	cmd.Stdin = strings.NewReader(input)
	if len(args) > 0 && args[0] != "worktree" && args[0] != "branch" {
		cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	}
	b, e := cmd.Output()
	return string(b), e == nil
}

// head resolves HEAD or returns an empty string for an unborn repository.
func head(root string) string {
	h, _ := git(root, []string{"rev-parse", "--verify", "-q", "HEAD"}, "")
	return home.Trim(h)
}

// dirtyPaths decodes porcelain paths, including both sides of renames and copies.
func dirtyPaths(root string) []string {
	out, _ := git(root, []string{"status", "--porcelain=v1", "-z", "--untracked-files=all"}, "")
	fields := strings.Split(out, "\x00")
	paths := []string{}
	for i := 0; i < len(fields); i++ {
		f := fields[i]
		if f == "" {
			continue
		}
		if len(f) >= 3 {
			paths = append(paths, f[3:])
		}
		if f[0] == 'R' || f[0] == 'C' {
			i++
			if i < len(fields) {
				paths = append(paths, fields[i])
			}
		}
	}
	return paths
}

// hashFiles fingerprints file mode and blob contents, including symlink targets.
func hashFiles(root string, paths []string) map[string]string {
	m := map[string]string{}
	for _, path := range paths {
		full := filepath.Join(root, path)
		info, err := os.Lstat(full)
		if err != nil || info.IsDir() {
			m[path] = ""
			continue
		}
		mode := "100644"
		var out string
		var ok bool
		if info.Mode()&os.ModeSymlink != 0 {
			mode = "120000"
			target, err := os.Readlink(full)
			if err == nil {
				out, ok = git(root, []string{"hash-object", "--stdin"}, target)
			}
		} else if info.Mode().IsRegular() {
			if info.Mode()&0111 != 0 {
				mode = "100755"
			}
			out, ok = git(root, []string{"hash-object", "--", path}, "")
		}
		if ok {
			m[path] = mode + ":" + home.Trim(out)
		} else {
			m[path] = ""
		}
	}
	return m
}

// hashAt reads starting tree modes and blob hashes without parsing path delimiters.
func hashAt(root, commit string, paths []string) map[string]string {
	m := map[string]string{}
	for _, path := range paths {
		m[path] = ""
		if commit == "" {
			continue
		}
		out, ok := git(root, []string{"ls-tree", "-z", commit, "--", path}, "")
		if !ok {
			continue
		}
		for _, entry := range strings.Split(out, "\x00") {
			meta, name, yes := strings.Cut(entry, "\t")
			bits := strings.Fields(meta)
			if yes && name == path && len(bits) == 3 && bits[1] == "blob" {
				m[path] = bits[0] + ":" + bits[2]
			}
		}
	}
	return m
}

// Snapshot holds HEAD and the hashes of files already dirty before a task.
type Snapshot struct {
	Root, Head string
	Files      map[string]string
	Paths      []string
}

// Take returns nil outside a git repository; otherwise it captures the current working state.
func Take(dir string) *Snapshot {
	root, ok := git(dir, []string{"rev-parse", "--show-toplevel"}, "")
	root = home.Trim(root)
	if !ok || root == "" {
		return nil
	}
	paths := dirtyPaths(root)
	return &Snapshot{root, head(root), hashFiles(root, paths), paths}
}

// Changes returns content and mode changes, plus commits made on top of the starting HEAD.
func Changes(before *Snapshot) ([]any, int) {
	h := head(before.Root)
	paths := []string{}
	seen := map[string]bool{}
	add := func(path string) {
		if path != "" && !seen[path] {
			paths = append(paths, path)
			seen[path] = true
		}
	}
	for _, p := range before.Paths {
		add(p)
	}
	for _, p := range dirtyPaths(before.Root) {
		add(p)
	}
	commits := 0
	if h != "" && before.Head != "" && h != before.Head {
		out, _ := git(before.Root, []string{"diff", "--name-only", "-z", before.Head, h}, "")
		for _, p := range strings.Split(out, "\x00") {
			add(p)
		}
		count, _ := git(before.Root, []string{"rev-list", "--count", before.Head + ".." + h}, "")
		commits, _ = strconv.Atoi(home.Trim(count))
	}
	clean := []string{}
	for _, p := range paths {
		if _, ok := before.Files[p]; !ok {
			clean = append(clean, p)
		}
	}
	start := hashAt(before.Root, before.Head, clean)
	for p, h := range before.Files {
		start[p] = h
	}
	end := hashFiles(before.Root, paths)
	sort.Strings(paths)
	files := []any{}
	for _, path := range paths {
		if start[path] != end[path] {
			change := "modified"
			if start[path] == "" {
				change = "added"
			} else if end[path] == "" {
				change = "deleted"
			}
			files = append(files, home.O("path", path, "change", change))
		}
	}
	return files, commits
}

// Worktree describes a task's branch, location and omitted source changes.
type Worktree struct {
	Path, Branch, Dir, Base string
	Dirty                   bool
}

// Add creates a worktree on the branches setting's branch (ask/NAME) from HEAD where the worktrees setting puts name, or
// name-2, name-3 and so on when another task already has that folder; it claims the folder
// atomically, so parallel tasks never share one. reuse is for follow-ups of a kept worktree: they
// continue the one at name, recreating it if removed.
func Add(p home.Paths, dir, name string, reuse bool) (*Worktree, error) {
	root, ok := git(dir, []string{"rev-parse", "--show-toplevel"}, "")
	root = home.Trim(root)
	if !ok || root == "" {
		return nil, fmt.Errorf("--worktree needs a git repository; %s is not in one", dir)
	}
	used := name
	path, e := p.Worktree(used)
	if e != nil {
		return nil, e
	}
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	e = os.Mkdir(path, 0700)
	for i := 2; os.IsExist(e) && !reuse; i++ {
		used = name + "-" + strconv.Itoa(i)
		if path, e = p.Worktree(used); e == nil {
			e = os.Mkdir(path, 0700)
		}
	}
	branch, e2 := p.Branch(used)
	if e2 != nil {
		return nil, e2
	}
	if e == nil {
		_, exists := git(root, []string{"rev-parse", "--verify", "-q", "refs/heads/" + branch}, "")
		args := []string{"worktree", "add", path, branch}
		if !exists {
			args = []string{"worktree", "add", "-b", branch, path, "HEAD"}
		}
		if _, ok := git(root, args, ""); !ok {
			os.Remove(path)
			return nil, fmt.Errorf("could not create a worktree for %s; does it have a commit?", root)
		}
	} else if !os.IsExist(e) {
		return nil, e
	}
	prefix, ok := git(dir, []string{"rev-parse", "--show-prefix"}, "")
	if !ok {
		return nil, fmt.Errorf("could not locate %s inside its repository", dir)
	}
	rel := strings.TrimSuffix(prefix, "\n")
	history, _ := git(path, []string{"reflog", "show", "--format=%H", branch}, "")
	entries := strings.Fields(history)
	base, _ := git(path, []string{"merge-base", "HEAD", head(root)}, "")
	base = home.Trim(base)
	if len(entries) > 0 {
		base = entries[len(entries)-1]
	}
	return &Worktree{Path: path, Branch: branch, Dir: filepath.Join(path, rel), Base: base, Dirty: len(dirtyPaths(root)) > 0}, nil
}

// Unchanged trusts git status and HEAD when deciding whether removal is safe.
func Unchanged(w *Worktree) bool {
	status, ok := git(w.Path, []string{"status", "--porcelain=v1", "-z", "--untracked-files=all"}, "")
	return ok && status == "" && head(w.Path) == w.Base && w.Base != ""
}

// Remove removes a proven unchanged worktree and its branch only when git accepts removal.
func Remove(w *Worktree) bool {
	root, _ := git(w.Path, []string{"rev-parse", "--git-common-dir"}, "")
	root = home.Trim(root)
	if _, ok := git(w.Path, []string{"worktree", "remove", w.Path}, ""); !ok {
		return false
	}
	if root != "" {
		git(filepath.Join(root, ".."), []string{"branch", "-D", w.Branch}, "")
	}
	return true
}

// Discard removes a worktree and its branch whatever they hold, for throwaway work such as a
// bench attempt; everything else keeps changed worktrees and uses Remove.
func Discard(w *Worktree) bool {
	root, _ := git(w.Path, []string{"rev-parse", "--git-common-dir"}, "")
	root = home.Trim(root)
	if _, ok := git(w.Path, []string{"worktree", "remove", "--force", w.Path}, ""); !ok {
		return false
	}
	if root != "" {
		git(filepath.Join(root, ".."), []string{"branch", "-D", w.Branch}, "")
	}
	return true
}

// Checkouts returns the main checkout and every worktree of the repository holding dir, as
// physical paths, or nil when dir is not in a git repository.
func Checkouts(dir string) []string {
	out, ok := git(dir, []string{"worktree", "list", "--porcelain", "-z"}, "")
	if !ok {
		return nil
	}
	paths := []string{}
	for _, record := range strings.Split(out, "\x00") {
		if path, found := strings.CutPrefix(record, "worktree "); found {
			if real, e := filepath.EvalSymlinks(path); e == nil {
				path = real
			}
			paths = append(paths, path)
		}
	}
	return paths
}

// Landed reports whether a kept worktree's branch needs nothing more, with why: it changed
// nothing since it started, or every file it changed already matches a default branch (origin's
// HEAD, main or master), as after a merge or a squash merge. Uncommitted changes never land.
func Landed(path, branch string) (bool, string) {
	status, ok := git(path, []string{"status", "--porcelain"}, "")
	if !ok {
		return false, "git cannot read it"
	}
	if home.Trim(status) != "" {
		return false, "uncommitted changes"
	}
	targets := []string{}
	if ref, ok := git(path, []string{"rev-parse", "--abbrev-ref", "origin/HEAD"}, ""); ok {
		targets = append(targets, home.Trim(ref))
	}
	for _, name := range []string{"main", "master"} {
		if _, ok := git(path, []string{"rev-parse", "--verify", "-q", "refs/heads/" + name}, ""); ok {
			targets = append(targets, name)
		}
	}
	for _, target := range targets {
		base, ok := git(path, []string{"merge-base", target, branch}, "")
		if !ok {
			continue
		}
		files, _ := git(path, []string{"diff", "--name-only", "-z", home.Trim(base), branch}, "")
		names := strings.Split(strings.TrimRight(files, "\x00"), "\x00")
		if files == "" {
			return true, "no changes"
		}
		if _, same := git(path, append([]string{"diff", "--quiet", target, branch, "--"}, names...), ""); same {
			return true, "merged into " + target
		}
	}
	if len(targets) == 0 {
		return false, "no main branch to compare with"
	}
	return false, "not merged into " + targets[0]
}
