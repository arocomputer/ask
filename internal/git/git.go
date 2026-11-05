// Package git reports what a write session changed and manages the worktrees write sessions work in.
package git

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/arocomputer/ask/internal/config"
)

// git returns output and success, silently handling repositories without a HEAD.
// It turns off core.fsmonitor, so a write session cannot plant a command for ask's own git calls to run.
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
	return config.Trim(h)
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
			m[path] = mode + ":" + config.Trim(out)
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

// Snapshot holds HEAD and the hashes of files already dirty before a turn.
type Snapshot struct {
	Root, Head string
	Files      map[string]string
	Paths      []string
}

// Take returns nil outside a git repository; otherwise it captures the current working state.
func Take(dir string) *Snapshot {
	root, ok := git(dir, []string{"rev-parse", "--show-toplevel"}, "")
	root = config.Trim(root)
	if !ok || root == "" {
		return nil
	}
	paths := dirtyPaths(root)
	return &Snapshot{root, head(root), hashFiles(root, paths), paths}
}

// Change is a file a turn added, modified or deleted.
type Change struct {
	Path   string `json:"path"`
	Change string `json:"change"`
}

// Changes returns content and mode changes since the snapshot, plus commits made on top of
// the starting HEAD. Files already dirty before the turn count only if the turn changed them again.
func Changes(before *Snapshot) ([]Change, int) {
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
		commits, _ = strconv.Atoi(config.Trim(count))
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
	files := []Change{}
	for _, path := range paths {
		if start[path] != end[path] {
			change := "modified"
			if start[path] == "" {
				change = "added"
			} else if end[path] == "" {
				change = "deleted"
			}
			files = append(files, Change{path, change})
		}
	}
	return files, commits
}

// Worktree describes a session's branch and checkout. Dir is where the session works: the caller's
// subdirectory, inside the worktree. Base is the commit the branch started from.
type Worktree struct {
	Path, Branch, Dir, Base string
}

// Add creates a worktree for a new run named name from HEAD, on the configured branch, where
// the worktrees setting puts it, or name-2, name-3 and so on when another run has that folder;
// the folder is claimed atomically, so parallel runs never share one. kept is for follow-ups:
// they reuse its exact path and branch, recreating it if removed.
func Add(p config.Paths, dir, name string, kept *Worktree) (*Worktree, error) {
	root, ok := git(dir, []string{"rev-parse", "--show-toplevel"}, "")
	root = config.Trim(root)
	if !ok || root == "" {
		return nil, fmt.Errorf("--worktree needs a git repository; %s is not in one", dir)
	}
	main := Root(dir)
	used := name
	var path, branch string
	var e error
	if kept != nil {
		path, branch = kept.Path, kept.Branch
	} else {
		path, e = p.Worktree(main, used)
		if e != nil {
			return nil, e
		}
	}
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	e = os.Mkdir(path, 0700)
	for i := 2; os.IsExist(e) && kept == nil; i++ {
		used = name + "-" + strconv.Itoa(i)
		if path, e = p.Worktree(main, used); e == nil {
			e = os.Mkdir(path, 0700)
		}
	}
	if kept == nil {
		var err error
		branch, err = p.Branch(used)
		if err != nil {
			return nil, err
		}
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
	} else if err := Check(dir, &Worktree{Path: path, Branch: branch}); err != nil {
		// Never treat an arbitrary existing directory (or a replacement worktree) as ours.
		return nil, err
	}
	prefix, ok := git(dir, []string{"rev-parse", "--show-prefix"}, "")
	if !ok {
		return nil, fmt.Errorf("could not locate %s inside its repository", dir)
	}
	rel := strings.TrimSuffix(prefix, "\n")
	history, _ := git(path, []string{"reflog", "show", "--format=%H", branch}, "")
	entries := strings.Fields(history)
	base, _ := git(path, []string{"merge-base", "HEAD", head(root)}, "")
	base = config.Trim(base)
	if len(entries) > 0 {
		base = entries[len(entries)-1]
	}
	return &Worktree{Path: path, Branch: branch, Dir: filepath.Join(path, rel), Base: base}, nil
}

// Root returns the main checkout of the repository holding dir, even when dir is inside a
// linked worktree; "" outside a repository.
func Root(dir string) string {
	top, ok := git(dir, []string{"rev-parse", "--show-toplevel"}, "")
	if !ok {
		return ""
	}
	common, ok := git(dir, []string{"rev-parse", "--path-format=absolute", "--git-common-dir"}, "")
	if c := config.Trim(common); ok && filepath.Base(c) == ".git" {
		return filepath.Dir(c)
	}
	return config.Trim(top)
}

// Unchanged trusts git status and HEAD when deciding whether removal is safe.
func Unchanged(w *Worktree) bool {
	status, ok := git(w.Path, []string{"status", "--porcelain=v1", "-z", "--untracked-files=all"}, "")
	return ok && status == "" && head(w.Path) == w.Base && w.Base != ""
}

// Remove removes a worktree and its branch only when git accepts removal.
func Remove(path, branch string) bool {
	root, _ := git(path, []string{"rev-parse", "--git-common-dir"}, "")
	root = config.Trim(root)
	if _, ok := git(path, []string{"worktree", "remove", path}, ""); !ok {
		return false
	}
	if root != "" {
		git(filepath.Join(root, ".."), []string{"branch", "-D", branch}, "")
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

// targets returns the branches Landed considers primary: origin's default, then main or master.
func targets(path string) []string {
	out := []string{}
	if ref, ok := git(path, []string{"rev-parse", "--abbrev-ref", "origin/HEAD"}, ""); ok {
		out = append(out, config.Trim(ref))
	}
	for _, name := range []string{"main", "master"} {
		if _, ok := git(path, []string{"rev-parse", "--verify", "-q", "refs/heads/" + name}, ""); ok {
			out = append(out, name)
		}
	}
	return out
}

// patchID returns a diff's stable patch id, or "".
func patchID(path, diff string) string {
	out, ok := git(path, []string{"patch-id", "--stable"}, diff)
	if !ok {
		return ""
	}
	if fields := strings.Fields(out); len(fields) > 0 {
		return fields[0]
	}
	return ""
}

// Contained returns another local or remote branch that already contains branch, if any.
func Contained(path, branch string) (string, bool) {
	upstream, _ := git(path, []string{"rev-parse", "--abbrev-ref", branch + "@{upstream}"}, "")
	upstream = config.Trim(upstream)
	out, ok := git(path, []string{"for-each-ref", "--contains", branch, "--format=%(refname:short)", "refs/heads", "refs/remotes"}, "")
	if !ok {
		return "", false
	}
	for _, ref := range strings.Split(config.Trim(out), "\n") {
		ref = config.Trim(ref)
		if ref == "" || ref == branch || ref == upstream || strings.HasSuffix(ref, "/"+branch) {
			continue
		}
		return ref, true
	}
	return "", false
}

// LikelyLanded reports whether every file branch changed already has the branch's final blob in
// a primary branch's history. It is advisory: a reworked merge can look like this without being
// the same commit. Renames and partial rewrites stay not landed.
func LikelyLanded(path, branch string) (bool, string) {
	for _, target := range targets(path) {
		base, ok := git(path, []string{"merge-base", target, branch}, "")
		if !ok {
			continue
		}
		base = config.Trim(base)
		files, _ := git(path, []string{"diff", "--name-only", "-z", base, branch}, "")
		names := strings.Split(strings.TrimRight(files, "\x00"), "\x00")
		if files == "" {
			return true, "no changes"
		}
		all := true
		for _, file := range names {
			if file == "" {
				continue
			}
			blob, exists := git(path, []string{"rev-parse", branch + ":" + file}, "")
			if !exists {
				// The branch deleted the file; the target must not have it.
				if _, there := git(path, []string{"rev-parse", target + ":" + file}, ""); there {
					all = false
					break
				}
				continue
			}
			blob = config.Trim(blob)
			if current, ok := git(path, []string{"rev-parse", target + ":" + file}, ""); ok && config.Trim(current) == blob {
				continue
			}
			commits, _ := git(path, []string{"rev-list", base + ".." + target, "--", file}, "")
			found := false
			for _, commit := range strings.Fields(commits) {
				if at, ok := git(path, []string{"rev-parse", commit + ":" + file}, ""); ok && config.Trim(at) == blob {
					found = true
					break
				}
			}
			if !found {
				all = false
				break
			}
		}
		if all {
			return true, "likely landed in " + target
		}
	}
	return false, ""
}

// Locked reports whether path is a git-locked worktree, and its lock reason.
func Locked(path string) (bool, string) {
	out, ok := git(path, []string{"worktree", "list", "--porcelain"}, "")
	if !ok {
		return false, ""
	}
	seen, reason := "", ""
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "worktree "):
			seen, reason = strings.TrimPrefix(line, "worktree "), ""
		case line == "locked":
			reason = "locked"
		case strings.HasPrefix(line, "locked "):
			reason = strings.TrimPrefix(line, "locked ")
		case line == "":
			if seen == path {
				return reason != "", reason
			}
			seen, reason = "", ""
		}
	}
	return false, ""
}

// Nested reports whether path contains another registered worktree.
func Nested(path string) bool {
	real, e := filepath.EvalSymlinks(path)
	if e == nil {
		path = real
	}
	prefix := path + string(filepath.Separator)
	for _, checkout := range Checkouts(path) {
		if checkout != path && strings.HasPrefix(checkout, prefix) {
			return true
		}
	}
	return false
}

// DirtyCounts returns tracked and untracked entries in path's status.
func DirtyCounts(path string) (tracked, untracked int, ok bool) {
	out, ok := git(path, []string{"status", "--porcelain"}, "")
	if !ok {
		return 0, 0, false
	}
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "??") {
			untracked++
		} else {
			tracked++
		}
	}
	return tracked, untracked, true
}

// RemoveWorktreeOnly removes a worktree and leaves its branch reachable elsewhere.
func RemoveWorktreeOnly(path string) bool {
	_, ok := git(path, []string{"worktree", "remove", path}, "")
	return ok
}

// Landed reports whether a kept worktree's branch needs nothing more, with why: it changed
// nothing, every commit is already upstream, or its changed files match a default branch
// (origin's HEAD, main or master). Uncommitted changes never land.
func Landed(path, branch string) (bool, string) {
	status, ok := git(path, []string{"status", "--porcelain"}, "")
	if !ok {
		return false, "git cannot read it"
	}
	if config.Trim(status) != "" {
		return false, "uncommitted changes"
	}
	ts := targets(path)
	for _, target := range ts {
		base, ok := git(path, []string{"merge-base", target, branch}, "")
		if !ok {
			continue
		}
		base = config.Trim(base)
		files, _ := git(path, []string{"diff", "--name-only", "-z", base, branch}, "")
		names := strings.Split(strings.TrimRight(files, "\x00"), "\x00")
		if files == "" {
			return true, "no changes"
		}
		// A deleted remote branch is usually a merged pull request: every commit's patch is
		// already upstream even when later commits changed the same files.
		if cherry, ok := git(path, []string{"cherry", target, branch}, ""); ok {
			plus := false
			for _, line := range strings.Split(config.Trim(cherry), "\n") {
				if strings.HasPrefix(line, "+") {
					plus = true
					break
				}
			}
			if !plus {
				return true, "merged into " + target
			}
		}
		// A multi-commit branch can be squash-merged as one commit. Its combined patch-id is
		// stable across later edits to the same files.
		if ahead, e := strconv.Atoi(config.Trim(mustGit(path, []string{"rev-list", "--count", base + ".." + branch}))); e == nil && ahead > 1 {
			if diff, ok := git(path, []string{"diff", base, branch}, ""); ok {
				want := patchID(path, diff)
				if want != "" {
					commits, _ := git(path, []string{"rev-list", base + ".." + target}, "")
					for _, commit := range strings.Fields(commits) {
						if _, ok := git(path, []string{"rev-parse", "--verify", "-q", commit + "^"}, ""); !ok {
							continue
						}
						diff, ok := git(path, []string{"diff", commit + "^", commit}, "")
						if ok && patchID(path, diff) == want {
							return true, "merged into " + target
						}
					}
				}
			}
		}
		if _, same := git(path, append([]string{"diff", "--quiet", target, branch, "--"}, names...), ""); same {
			return true, "merged into " + target
		}
	}
	if len(ts) == 0 {
		return false, "no main branch to compare with"
	}
	return false, "not merged into " + ts[0]
}

// mustGit returns git output or "", for counts that only feed a condition.
func mustGit(dir string, args []string) string {
	out, _ := git(dir, args, "")
	return out
}

// Check verifies an existing worktree's repository and branch without recreating it.
func Check(dir string, kept *Worktree) error {
	top, ok := git(kept.Path, []string{"rev-parse", "--show-toplevel"}, "")
	actual, _ := git(kept.Path, []string{"symbolic-ref", "--quiet", "--short", "HEAD"}, "")
	real, err := filepath.EvalSymlinks(kept.Path)
	if !ok || err != nil || config.Trim(top) != real || Root(kept.Path) != Root(dir) || config.Trim(actual) != kept.Branch {
		return fmt.Errorf("kept worktree %s is no longer on branch %s in %s", kept.Path, kept.Branch, Root(dir))
	}
	return nil
}
