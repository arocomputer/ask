package runs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/arocomputer/ask/src/find"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/process"
)

// load reads task-position results and refuses damaged results instead of silently rerunning them.
func load(dir string) (*Run, error) {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(filepath.Join(dir, "tasks.json"))
	var records []home.TaskRecord
	if err != nil || json.Unmarshal(b, &records) != nil || len(records) == 0 {
		return nil, home.Usage("%s is not a readable run", dir)
	}
	tasks := make([]home.Object, len(records))
	results := make([]home.Object, len(records))
	for i, t := range records {
		tasks[i], _ = home.ParsePayload(home.JSON(t, false))
	}
	path := filepath.Join(dir, "results.json")
	if b, err := os.ReadFile(path); err == nil {
		var saved []*home.ResultRecord
		if json.Unmarshal(b, &saved) != nil || saved == nil {
			return nil, home.Usage("%s is damaged; move it away to rerun every task", path)
		}
		for i := range tasks {
			if i < len(saved) && saved[i] != nil {
				results[i], _ = home.ParsePayload(home.JSON(saved[i], false))
			}
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	created, id, name := folder(filepath.Base(dir))
	return &Run{ID: id, Name: name, Dir: dir, Created: created, Tasks: tasks, Results: results}, nil
}

// Create writes prepared tasks once with an absolute run directory; name may be empty.
// Name selection and creation share a lock, including relabeling fresh worktrees when a
// suffix is needed. A single conversation's follow-up keeps its inherited name and worktree.
func Create(p home.Paths, id, name string, tasks []home.Object) (*Run, error) {
	if err := os.MkdirAll(p.Runs, 0700); err != nil {
		return nil, err
	}
	claim, err := os.OpenFile(filepath.Join(p.Home, ".run-create-lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	defer claim.Close()
	for {
		if process.Stopping() {
			return nil, fmt.Errorf("ask was stopped")
		}
		err := syscall.Flock(int(claim.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
			return nil, err
		}
		// Let a stopping worker finish its creation cleanup even while another launcher
		// holds the claim. A blocking flock would strand the signal handler.
		time.Sleep(10 * time.Millisecond)
	}
	for _, n := range find.List(p.Runs) {
		_, existingID, existingName := folder(n)
		if existingID == id || existingName == id {
			return nil, home.Usage("run ID %s is already claimed; retry", id)
		}
		if name != "" && existingID == name && len(tasks) == 1 && tasks[0].S("continues") == name {
			return nil, home.Usage("run name %s would shadow an existing ID", name)
		}
	}
	if name != "" && (len(tasks) != 1 || tasks[0].S("continues") != name) {
		chosen := Unique(p, name)
		if chosen != name {
			prepared := make([]home.Object, len(tasks))
			for i, task := range tasks {
				prepared[i] = task.Clone()
				if task.B("worktree") && !task.B("continues") && !task.B("reuse") {
					prepared[i].Set("worktree", chosen+strings.TrimPrefix(task.S("worktree"), name))
				}
			}
			tasks = prepared
		}
		name = chosen
	}
	stamp := time.Now().UTC().Format("20060102T150405.000")
	stamp = strings.ReplaceAll(stamp, ".", "")
	base := stamp + "-" + id
	if name != "" {
		base += "-" + name
	}
	dir := filepath.Join(p.Runs, base)
	if e := os.Mkdir(dir, 0700); e != nil {
		return nil, e
	}
	if e := home.WriteJSON(filepath.Join(dir, "tasks.json"), home.TaskRecords(tasks)); e != nil {
		_ = os.RemoveAll(dir)
		return nil, e
	}
	return load(dir)
}

// Open resolves RUN[/TASK] or a directory; index -1 selects all results of a batch.
func Open(p home.Paths, ref string) (*Run, int, error) {
	// A bare relative path must look like a run, rather than shadowing a readable
	// handle just because an unrelated directory with that name exists in cwd.
	info, statErr := os.Stat(filepath.Join(ref, "tasks.json"))
	if strings.ContainsRune(ref, filepath.Separator) && statErr == nil && !info.IsDir() || strings.HasPrefix(ref, ".") || filepath.IsAbs(ref) || strings.HasPrefix(ref, "~") {
		info, e := os.Stat(ref)
		if e != nil || !info.IsDir() {
			return nil, -1, home.Usage("no run at %s; see `ask runs`", ref)
		}
		dir, _ := filepath.Abs(ref)
		r, e := load(dir)
		if e != nil {
			return nil, -1, e
		}
		if len(r.Tasks) == 1 {
			return r, 0, nil
		}
		return r, -1, nil
	}
	id, part, has := strings.Cut(ref, "/")
	name := ""
	for _, n := range find.List(p.Runs) {
		_, runID, runName := folder(n)
		if n == id || runID == id {
			name = n
			break
		}
		if runName == id {
			name = n // folders sort oldest first, so the newest run with this name wins
		}
	}
	if id == "" || name == "" {
		return nil, -1, home.Usage("no run %s; see `ask runs`", id)
	}
	r, e := load(filepath.Join(p.Runs, name))
	if e != nil {
		return nil, -1, e
	}
	if !has {
		if len(r.Tasks) == 1 {
			return r, 0, nil
		}
		return r, -1, nil
	}
	matches := []int{}
	for i, t := range r.Tasks {
		if home.String(t.Get("id")) == part {
			matches = append(matches, i)
		}
	}
	if len(matches) > 1 {
		return nil, -1, home.Usage("run %s has %d tasks named %s; use their position, like %s/%d", id, len(matches), part, id, matches[0]+1)
	}
	if len(matches) == 1 {
		return r, matches[0], nil
	}
	if digits.MatchString(part) {
		n, e := strconv.Atoi(part)
		if e == nil && n >= 1 && n <= len(r.Tasks) {
			return r, n - 1, nil
		}
	}
	return nil, -1, home.Usage("run %s has no task %s", id, part)
}

var digits = regexp.MustCompile(`^\d+$`)

// Recent returns up to limit (every one when negative) readable runs newest first, only those keep
// accepts when it is not nil.
func Recent(p home.Paths, limit int, keep func(*Run) bool) []*Run {
	names := []string{}
	for _, name := range find.List(p.Runs) {
		if strings.Contains(name, "-") {
			names = append(names, name)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	out := []*Run{}
	for _, name := range names {
		if len(out) == limit {
			break
		}
		if r, e := load(filepath.Join(p.Runs, name)); e == nil && (keep == nil || keep(r)) {
			out = append(out, r)
		}
	}
	return out
}

// All returns every readable run, newest first.
func All(p home.Paths) []*Run { return Recent(p, -1, nil) }

// Delete removes a run's record folder.
func Delete(r *Run) error { return os.RemoveAll(r.Dir) }

// DiscardUnadmitted removes a fresh run only if no other execution owns it or has
// recorded work. The caller must prevent its own admission and task starts while this runs.
// Use the same Run passed to Execute. Recovery callers must never use it: their saved
// state predates this launch.
func DiscardUnadmitted(r *Run) error {
	r.lockMu.Lock()
	defer r.lockMu.Unlock()
	held, err := lock(r)
	if err != nil {
		return err
	}
	defer held.Close()
	current, err := load(r.Dir)
	if err != nil {
		return err
	}
	for i, result := range current.Results {
		if result != nil {
			return fmt.Errorf("run %s already has results", r.ID)
		}
		if _, err := os.Stat(recoveryPath(r, i)); !os.IsNotExist(err) {
			return fmt.Errorf("run %s already has recovery state", r.ID)
		}
	}
	if b, err := os.ReadFile(pendingPath(r)); err == nil {
		var pending pendingRecord
		if json.Unmarshal(b, &pending) != nil || pending.PID != os.Getpid() {
			return fmt.Errorf("run %s was admitted by another worker", r.ID)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return Delete(r)
}
