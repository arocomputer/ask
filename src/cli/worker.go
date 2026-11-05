package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/arocomputer/ask/src/agent"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/hooks"
	"github.com/arocomputer/ask/src/process"
	"github.com/arocomputer/ask/src/runs"
	"github.com/arocomputer/ask/src/status"
)

// The private launch protocol admits either fresh prepared tasks or smart recovery of a
// saved run, never prepared tasks with a caller-chosen execution identity. Inherited pipes
// keep prompts out of argv and the environment. They close before agents start.
type launchRequest struct {
	Name          string
	Notes         []hooks.Note
	Tasks         []home.TaskRecord
	WorktreeLabel string // preparation's placeholder, replaced with the worker's fresh ID
	Recover       string // a pinned run directory, mutually exclusive with new tasks
	Selected      *int   // zero-based position, independent of numeric task IDs
	Jobs          int
	Hooks         bool
}

type launchReply struct {
	ID         string
	Error      string
	Usage      bool
	Diagnostic string // formatted status only; never agent output or lifecycle log content
}

// startWorker detaches from the terminal and the launcher's process group. Unlike agents,
// the worker has no Linux parent-death signal: returning from admission must leave it alive.
func startWorker(p home.Paths, launch launchRequest) (int, error) {
	requestR, requestW, err := os.Pipe()
	if err != nil {
		return 0, err
	}
	defer requestR.Close()
	defer requestW.Close()
	replyR, replyW, err := os.Pipe()
	if err != nil {
		return 0, err
	}
	defer replyR.Close()
	defer replyW.Close()
	cmd := exec.Command(p.Bin, "__ask_worker")
	cmd.Env = p.Env(nil)
	cmd.ExtraFiles = []*os.File{requestR, replyW}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	// Nil standard streams are /dev/null, not the caller's terminal or capture pipes.
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	requestR.Close()
	replyW.Close()
	accepted := false
	defer func() {
		if !accepted {
			// No retry: the worker may have crossed admission just as the caller lost its reply.
			_ = cmd.Process.Signal(syscall.SIGTERM)
			_ = cmd.Wait()
		}
	}()
	deadline := time.Now().Add(30 * time.Second)
	if err := requestW.SetWriteDeadline(deadline); err != nil {
		return 0, err
	}
	if err := replyR.SetReadDeadline(deadline); err != nil {
		return 0, err
	}
	if err := json.NewEncoder(requestW).Encode(launch); err != nil {
		return 0, fmt.Errorf("cannot send work to detached worker: %w", err)
	}
	requestW.Close()
	var reply launchReply
	decoder := json.NewDecoder(replyR)
	for {
		if err := decoder.Decode(&reply); err != nil {
			return 0, fmt.Errorf("worker readiness was not confirmed: %w; inspect ask runs before retrying", err)
		}
		if reply.Diagnostic == "" {
			break
		}
		fmt.Fprintln(os.Stderr, reply.Diagnostic)
		reply = launchReply{}
	}
	if reply.Error != "" {
		if reply.Usage {
			return 0, home.Usage("cannot start worker: %s", reply.Error)
		}
		return 0, fmt.Errorf("cannot start worker: %s", reply.Error)
	}
	if reply.ID == "" {
		return 0, fmt.Errorf("worker returned no run ID")
	}
	accepted = true
	_ = cmd.Process.Release()
	_, err = fmt.Fprintln(os.Stdout, reply.ID)
	return 0, err
}

// recoverWorker pins the saved directory, not a readable name that a follow-up could take
// over during launch. This also preserves explicit run paths outside the normal runs directory.
// Continue reopens and plans under its own lock before replying.
func recoverWorker(p home.Paths, r *runs.Run, jobs int, hooks bool, selected ...int) (int, error) {
	launch := launchRequest{Recover: r.Dir, Jobs: jobs, Hooks: hooks}
	if len(selected) != 0 {
		launch.Selected = &selected[0]
	}
	return startWorker(p, launch)
}

// runWorker is reachable only through the private pipe protocol. Fresh work always gets a
// worker-generated identity; existing runs can only enter the locked smart recovery path.
func runWorker() int {
	// Validate raw descriptors before os.NewFile or signal setup can allocate runtime pipes
	// at these numbers. A direct CLI invocation must fail, never read a runtime-owned pipe.
	for _, fd := range []int{3, 4} {
		var st syscall.Stat_t
		if err := syscall.Fstat(fd, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFIFO {
			fmt.Fprintln(os.Stderr, "ask: internal worker requires inherited launch pipes")
			return 2
		}
		syscall.CloseOnExec(fd)
	}
	// NewFile can apply deadlines to an inherited pipe only if it is nonblocking.
	if err := syscall.SetNonblock(4, true); err != nil {
		fmt.Fprintln(os.Stderr, "ask: cannot configure internal worker reply pipe")
		return 1
	}
	request := os.NewFile(3, "launch-request")
	reply := os.NewFile(4, "launch-reply")
	defer request.Close()
	defer reply.Close()
	process.Listen()
	signal.Ignore(syscall.SIGHUP)
	fail := func(err error) int {
		process.AwaitShutdown()
		var usage *home.UsageError
		_ = json.NewEncoder(reply).Encode(launchReply{Error: err.Error(), Usage: errors.As(err, &usage)})
		return 1
	}
	var launch launchRequest
	if err := json.NewDecoder(request).Decode(&launch); err != nil {
		return fail(err)
	}
	request.Close()
	if launch.Jobs < 1 || (len(launch.Tasks) == 0) == (launch.Recover == "") || launch.Recover == "" && launch.Selected != nil {
		return fail(fmt.Errorf("worker requires prepared tasks or a recovery reference, and positive jobs"))
	}
	p := home.New()
	fresh := launch.Recover == ""
	var r *runs.Run
	var log *os.File
	var admission sync.Mutex
	admitted := false
	// Signal shutdown exits without defers. Serialize creation and acknowledgment with
	// cleanup so neither a half-created record nor an acknowledged run can be deleted.
	process.OnStop(func() {
		admission.Lock()
		defer admission.Unlock()
		if fresh && r != nil && !admitted {
			_ = runs.DiscardUnadmitted(r)
		} else if admitted {
			_, _ = fmt.Fprintln(log, "stopped")
		}
	})
	defer process.OnStop(nil)
	var selected []int
	var err error
	admission.Lock()
	if fresh {
		tasks := make([]home.Object, len(launch.Tasks))
		id := runs.NewID()
		for i, t := range launch.Tasks {
			tasks[i], _ = home.ParsePayload(home.JSON(t, false))
			if launch.Name == "" && tasks[i].B("worktree") && !tasks[i].B("continues") {
				// Preparation could not know the worker's ID when the prompt supplied no name.
				tasks[i].Set("worktree", id+strings.TrimPrefix(tasks[i].S("worktree"), launch.WorktreeLabel))
			}
		}
		r, err = runs.Create(p, id, launch.Name, tasks)
	} else {
		r, _, err = runs.Open(p, launch.Recover)
		if err == nil && launch.Selected != nil {
			if *launch.Selected < 0 || *launch.Selected >= len(r.Tasks) {
				admission.Unlock()
				return fail(fmt.Errorf("invalid recovery position"))
			}
			selected = []int{*launch.Selected}
		}
	}
	if err != nil {
		admission.Unlock()
		return fail(err)
	}
	flags := os.O_CREATE | os.O_APPEND | os.O_WRONLY
	if fresh {
		flags |= os.O_EXCL
	}
	log, err = os.OpenFile(filepath.Join(r.Dir, "worker.log"), flags, 0600)
	if err != nil {
		if fresh {
			_ = runs.DiscardUnadmitted(r)
		}
		admission.Unlock()
		return fail(err)
	}
	admission.Unlock()
	defer log.Close()
	// Only constant lifecycle messages enter this log. Never copy agent output, hook notes,
	// prompts, environment, or arbitrary errors into it; results retain the normal contract.
	if err := reply.SetWriteDeadline(time.Now().Add(30 * time.Second)); err != nil {
		if fresh {
			_ = runs.DiscardUnadmitted(r)
		}
		return fail(err)
	}
	var reportError error
	report := func(e runs.Event) {
		admission.Lock()
		defer admission.Unlock()
		if !admitted && (e.Kind == "recovery" || e.Kind == "note") && reportError == nil {
			reportError = json.NewEncoder(reply).Encode(launchReply{Diagnostic: status.EventLine(r, e)})
		}
	}
	for _, note := range launch.Notes {
		report(runs.Event{Kind: "note", Note: note})
	}
	execute := runs.Execute
	if !fresh {
		execute = runs.Continue
	}
	results, err := execute(agent.New(p), r, launch.Jobs, launch.Hooks, report, func() error {
		admission.Lock()
		defer admission.Unlock()
		if process.Stopping() {
			return fmt.Errorf("ask was stopped")
		}
		if reportError != nil {
			return reportError
		}
		if _, err := fmt.Fprintln(log, "started"); err != nil {
			return err
		}
		if err := json.NewEncoder(reply).Encode(launchReply{ID: r.ID}); err != nil {
			return err
		}
		admitted = true
		return reply.Close()
	}, selected...)
	process.AwaitShutdown()
	if err != nil {
		if !admitted {
			if fresh {
				_ = runs.DiscardUnadmitted(r)
			}
			return fail(err)
		}
		_, _ = fmt.Fprintln(log, "recording failed; results may be incomplete")
		return 1
	}
	for i, result := range results {
		if (len(selected) == 0 || selected[0] == i) && !result.B("ok") {
			_, _ = fmt.Fprintln(log, "failed; see ask show")
			return 1
		}
	}
	_, _ = fmt.Fprintln(log, "finished")
	return 0
}
