package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/process"
	"github.com/arocomputer/ask/internal/runs"
)

// The private launch protocol accepts prepared tasks, never a run ID or an existing run.
// Inherited pipes keep prompts out of argv and the environment. They close before agents start.
type launchRequest struct {
	Name  string
	Tasks []home.TaskRecord
	Hooks bool
}

type launchReply struct {
	ID    string
	Error string
}

// startWorker detaches from the terminal and the launcher's process group. Unlike agents,
// the worker has no Linux parent-death signal: returning from start must leave it alive.
func startWorker(p home.Paths, name string, tasks []home.Object, hooks bool) (int, error) {
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
	if err := json.NewEncoder(requestW).Encode(launchRequest{name, home.TaskRecords(tasks), hooks}); err != nil {
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

// runWorker is reachable only through the private pipe protocol. It always creates fresh work;
// neither a public flag nor inherited ASK_RUN can choose an execution's identity.
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
	if len(launch.Tasks) != 1 {
		return fail(fmt.Errorf("worker requires one prepared task"))
	}
	tasks := make([]home.Object, len(launch.Tasks))
	for i, t := range launch.Tasks {
		tasks[i], _ = home.ParsePayload(home.JSON(t, false))
	}
	p := home.New()
	id := runs.NewID()
	if launch.Name == "" && tasks[0].B("worktree") && !tasks[0].B("continues") {
		// Preparation could not know the worker's ID when the prompt supplied no name.
		tasks[0].Set("worktree", id)
	}
	r, err := runs.Create(p, id, launch.Name, tasks)
	if err != nil {
		return fail(err)
	}
	log, err := os.OpenFile(filepath.Join(r.Dir, "worker.log"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		_ = runs.Delete(r)
		return fail(err)
	}
	defer log.Close()
	// Only constant lifecycle messages enter this log. Never copy agent output, hook notes,
	// prompts, environment, or arbitrary errors into it; results retain the normal contract.
	process.OnStop(func() { _, _ = fmt.Fprintln(log, "stopped") })
	defer process.OnStop(nil)
	admitted := false
	results, err := runs.Execute(agent.New(p), r, 1, launch.Hooks, func(runs.Event) {}, func() error {
		if _, err := fmt.Fprintln(log, "started"); err != nil {
			return err
		}
		if err := json.NewEncoder(reply).Encode(launchReply{ID: r.ID}); err != nil {
			return err
		}
		admitted = true
		return reply.Close()
	})
	process.AwaitShutdown()
	if err != nil {
		if !admitted {
			_ = runs.Delete(r)
			return fail(err)
		}
		_, _ = fmt.Fprintln(log, "recording failed; results may be incomplete")
		return 1
	}
	if !results[0].B("ok") {
		_, _ = fmt.Fprintln(log, "failed; see ask show")
		return 1
	}
	_, _ = fmt.Fprintln(log, "finished")
	return 0
}
