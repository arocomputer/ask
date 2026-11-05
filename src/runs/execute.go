package runs

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
	"time"

	"github.com/arocomputer/ask/src/agent"
	"github.com/arocomputer/ask/src/find"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/hooks"
	"github.com/arocomputer/ask/src/process"
	"github.com/arocomputer/ask/src/task"
)

// Alive tests process existence, treating permission errors as alive.
func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	e := syscall.Kill(pid, 0)
	return e == nil || e == syscall.EPERM
}

// Owner returns the pid holding a run's lock, asking the kernel without taking the lock,
// 0 when no other process holds it, or -1 when it is held by a process outside this PID
// namespace (a container or sandbox), which the kernel reports as pid 0.
func Owner(r *Run) int {
	f, err := os.Open(filepath.Join(r.Dir, "lock"))
	if err != nil {
		return 0
	}
	defer f.Close()
	held := syscall.Flock_t{Type: syscall.F_WRLCK}
	if syscall.FcntlFlock(f.Fd(), syscall.F_GETLK, &held) != nil || held.Type == syscall.F_UNLCK {
		return 0
	}
	if held.Pid <= 0 {
		return -1
	}
	return int(held.Pid)
}

// lock takes an exclusive kernel record lock for the complete execution of a run.
// The lock belongs to this process: closing any other descriptor of the file here would drop it.
func lock(r *Run) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(r.Dir, "lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.FcntlFlock(f.Fd(), syscall.F_SETLK, &syscall.Flock_t{Type: syscall.F_WRLCK}); err != nil {
		f.Close()
		pid := ""
		if owner := Owner(r); owner > 0 {
			pid = fmt.Sprintf(" (pid %d)", owner)
		}
		return nil, home.Usage("run %s is running%s; stop it with `ask stop %s`", r.Label(), pid, r.Label())
	}
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// Event is a task's start, live usage (in Result) or activity, hook note/follow-up, or final result.
type Event struct {
	Kind     string
	Activity string
	Index    int
	Started  task.Started
	Note     hooks.Note
	Result   home.Object
	Progress agent.Progress
}

// Execute runs unfinished tasks up to jobs at once and atomically saves each completed result.
// A nil result slice with an error means no task started; callers may discard a newly created run.
// ready acknowledges admission with pending work and all run/session/worktree locks held,
// before any task starts. Admission fails if no selected task needs execution.
func Execute(a *agent.Registry, r *Run, jobs int, enabled bool, report func(Event), ready func() error, selected ...int) ([]home.Object, error) {
	return execute(a, r, jobs, enabled, false, report, ready, selected...)
}

// Continue finishes unfinished tasks using saved conversations when safe, restarting otherwise.
// Blocked tasks and successful results stay untouched. Planning and reservations hold the run lock.
func Continue(a *agent.Registry, r *Run, jobs int, enabled bool, report func(Event), ready func() error, selected ...int) ([]home.Object, error) {
	return execute(a, r, jobs, enabled, true, report, ready, selected...)
}

func execute(a *agent.Registry, r *Run, jobs int, enabled, smart bool, report func(Event), ready func() error, selected ...int) ([]home.Object, error) {
	r.lockMu.Lock()
	owner, e := lock(r)
	r.lockMu.Unlock()
	if e != nil {
		return nil, e
	}
	defer func() {
		r.lockMu.Lock()
		defer r.lockMu.Unlock()
		owner.Close()
	}()
	// Another invocation may have finished after this run was opened but before we took the lock.
	current, e := load(r.Dir)
	if e != nil {
		return nil, e
	}
	r.Results = current.Results
	var h *hooks.Hooks
	if enabled {
		h = hooks.New(a.Paths)
	}
	ordered := !enabled || len(find.Find(a.Paths, "hooks")) == 0
	todo := []int{}
	tasks := append([]home.Object(nil), r.Tasks...)
	var blocked string
	for i, x := range r.Results {
		if !x.B("ok") && (len(selected) == 0 || selected[0] == i) {
			if smart {
				var why string
				tasks[i], why, _ = recoverTask(r, i, true)
				report(Event{Kind: "recovery", Index: i, Note: hooks.Note{Text: why}})
				if tasks[i] == nil {
					blocked = why
					continue
				}
			}
			todo = append(todo, i)
		}
	}
	// Detached admission must promise actual work. Recheck under the lock: another owner
	// may have completed the run since the launcher read it, or every failure may be blocked.
	if ready != nil && len(todo) == 0 {
		if blocked != "" {
			return nil, home.Usage("%s: %s", r.ID, blocked)
		}
		return nil, home.Usage("%s is complete; give a prompt to continue the conversation", r.ID)
	}
	planned := &Run{ID: r.ID, Name: r.Name, Tasks: tasks}
	release, e := lockContinuations(a.Paths, planned, todo)
	if e != nil {
		return nil, e
	}
	defer release()
	pending := make(map[int]bool, len(todo))
	for _, i := range todo {
		pending[i] = true
	}
	pendingFile := pendingPath(r)
	savePending := func() error {
		indices := make([]int, 0, len(pending))
		for i := range pending {
			indices = append(indices, i)
		}
		sort.Ints(indices)
		return home.WriteJSON(pendingFile, pendingRecord{PID: os.Getpid(), Tasks: indices})
	}
	if err := savePending(); err != nil {
		return nil, err
	}
	var failure error
	defer func() {
		if failure == nil && !process.Stopping() {
			_ = os.Remove(pendingFile)
		}
	}()
	if ready != nil {
		if err := ready(); err != nil {
			return nil, err
		}
	}
	if jobs > len(todo) {
		jobs = len(todo)
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	next := 0
	starts := make([]chan struct{}, len(todo)+1)
	for i := range starts {
		starts[i] = make(chan struct{})
	}
	close(starts[0])
	for w := 0; w < jobs; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				if next >= len(todo) || failure != nil {
					mu.Unlock()
					return
				}
				position := next
				i := todo[position]
				next++
				mu.Unlock()
				var start sync.Once
				release := func() { start.Do(func() { close(starts[position+1]) }) }
				if ordered {
					<-starts[position]
				}
				// Clear only the attempt about to start, preserving recovery metadata for
				// queued tasks if this execution is interrupted before reaching them.
				mu.Lock()
				err := os.Remove(recoveryPath(r, i))
				if err == nil || os.IsNotExist(err) {
					r.Results[i] = nil
					err = home.WriteJSON(filepath.Join(r.Dir, "results.json"), home.ResultRecords(r.Results))
				}
				if err != nil {
					failure = err
				}
				mu.Unlock()
				if err != nil {
					release()
					return
				}
				path := progressPath(r, i)
				_ = os.Remove(path)
				activity := ""
				saved := recoveryRecord{}
				var saveError error
				result := withHooks(a, h, tasks[i], Ref(r, i), eventsFile(r, i), func(e Event) {
					e.Index = i
					changed := e.Kind == "start"
					if e.Kind == "start" {
						saved = recoveryRecord{Task: &home.TaskRecords([]home.Object{e.Started.Task})[0], Dir: e.Started.Dir, Session: e.Started.Task.S("session")}
						if w := e.Started.Worktree; w != nil {
							saved.Worktree = &home.WorktreeRecord{Path: w.Path, Branch: w.Branch}
						}
					} else if e.Kind == "metadata" {
						if e.Progress.Session != "" && e.Progress.Session != saved.Session {
							changed = true
							saved.Session = e.Progress.Session
						}
						if blocker := automaticBlocker(e.Progress.Blocker); blocker != "" && blocker != saved.Blocker {
							changed = true
							saved.Blocker = blocker
						}
					}
					if changed && saveError == nil {
						saveError = home.WriteJSON(recoveryPath(r, i), saved)
						if saveError != nil {
							_ = os.Remove(recoveryPath(r, i))
							report(Event{Kind: "recovery", Index: i, Note: hooks.Note{Text: "could not save live session metadata; interrupted recovery may need a restart"}})
						}
					}
					if e.Kind == "metadata" {
						return
					}
					if e.Kind == "start" {
						activity = ""
						_ = os.Remove(path)
					} else if e.Kind == "activity" && activity != e.Activity {
						activity = e.Activity
						if activity == "" {
							_ = os.Remove(path)
						} else {
							_ = home.WriteJSON(path, progressRecord{PID: os.Getpid(), Activity: activity})
						}
					}
					if !process.Stopping() {
						report(e)
					}
					if e.Kind == "start" {
						release()
					}
				})
				_ = os.Remove(path)
				release()

				if process.Stopping() || result == nil {
					return
				}
				x := home.O("run", Ref(r, i))
				for key, val := range result {
					x.Set(key, val)
				}
				mu.Lock()
				r.Results[i] = x
				e := home.WriteJSON(filepath.Join(r.Dir, "results.json"), home.ResultRecords(r.Results))
				if e != nil {
					failure = e
				} else {
					_ = os.Remove(recoveryPath(r, i))
					delete(pending, i)
					e = savePending()
					if e != nil {
						failure = e
					}
				}
				mu.Unlock()
				if e != nil {
					return
				}
				report(Event{Kind: "done", Index: i, Result: x})
			}
		}()
	}
	wg.Wait()
	return r.Results, failure
}

// Stop sends SIGTERM to the live run owner and waits up to ten seconds for it to release the run;
// it returns false when nothing was running and an error when the owner outlives the wait or
// runs outside this PID namespace, where ask cannot signal it.
func Stop(r *Run) (bool, error) {
	pid := Owner(r)
	if pid == 0 {
		return false, nil
	}
	if pid < 0 {
		return false, fmt.Errorf("run %s is running outside this sandbox or container; stop it from there", r.Label())
	}
	if e := syscall.Kill(pid, syscall.SIGTERM); e != nil {
		return false, e
	}
	for i := 0; i < 200 && Owner(r) == pid; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if Owner(r) == pid {
		return false, fmt.Errorf("run %s did not stop within 10 seconds (pid %d)", r.Label(), pid)
	}
	return true, nil
}
