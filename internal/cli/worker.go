package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/process"
	"github.com/arocomputer/ask/internal/runs"
)

// The private launch protocol admits either fresh prepared tasks or smart recovery of a
// saved run, never prepared tasks with a caller-chosen execution identity. Inherited pipes
// keep prompts out of argv and the environment. They close before agents start.
type launchRequest struct {
	Name          string
	Tasks         []home.TaskRecord
	WorktreeLabel string // preparation's placeholder, replaced with the worker's fresh ID
	Recover       string // a pinned run directory, mutually exclusive with new tasks
	Selected      *int   // zero-based position, independent of numeric task IDs
	Jobs          int
	Hooks         bool
}

type launchReply struct {
	ID    string
	Error string
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
	if err := json.NewDecoder(replyR).Decode(&reply); err != nil {
		return 0, fmt.Errorf("worker readiness was not confirmed: %w; inspect ask runs before retrying", err)
	}
	if reply.Error != "" {
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
	request := os.NewFile(3, "launch-request")
	reply := os.NewFile(4, "launch-reply")
	defer request.Close()
	defer reply.Close()
	process.Listen()
	signal.Ignore(syscall.SIGHUP)
	fail := func(err error) int {
		_ = json.NewEncoder(reply).Encode(launchReply{Error: err.Error()})
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
	var selected []int
	var err error
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
				return fail(fmt.Errorf("invalid recovery position"))
			}
			selected = []int{*launch.Selected}
		}
	}
	if err != nil {
		return fail(err)
	}
	flags := os.O_CREATE | os.O_APPEND | os.O_WRONLY
	if fresh {
		flags |= os.O_EXCL
	}
	log, err := os.OpenFile(filepath.Join(r.Dir, "worker.log"), flags, 0600)
	if err != nil {
		if fresh {
			_ = runs.Delete(r)
		}
		return fail(err)
	}
	defer log.Close()
	// Only constant lifecycle messages enter this log. Never copy agent output, hook notes,
	// prompts, environment, or arbitrary errors into it; results retain the normal contract.
	defer process.OnStop(nil)
	admitted := false
	execute := runs.Execute
	if !fresh {
		execute = runs.Continue
	}
	results, err := execute(agent.New(p), r, launch.Jobs, launch.Hooks, func(runs.Event) {}, func() error {
		if _, err := fmt.Fprintln(log, "started"); err != nil {
			return err
		}
		// Unadmitted recovery contenders must not write "stopped" into the owner's log.
		process.OnStop(func() { _, _ = fmt.Fprintln(log, "stopped") })
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
				_ = runs.Delete(r)
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
