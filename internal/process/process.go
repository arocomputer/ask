// Package process runs agents and hooks in process groups, with bounded shutdown.
// SIGINT and SIGTERM stop all groups and exit 130; no new process starts afterwards.
package process

import (
	"io"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"

	"github.com/arocomputer/ask/internal/home"
)

var shutdown struct {
	sync.Mutex
	cleanup func()
}

// OnStop installs terminal cleanup to run after stopped groups, before exit 130.
func OnStop(cleanup func()) { shutdown.Lock(); shutdown.cleanup = cleanup; shutdown.Unlock() }

var groups = struct {
	sync.Mutex
	stopping bool
	pids     map[int]bool
}{pids: map[int]bool{}}

// Listen installs ask's signal handlers before any agent or hook is started.
func Listen() {
	c := make(chan os.Signal, 2)
	signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-c
		groups.Lock()
		groups.stopping = true
		pids := []int{}
		for pid := range groups.pids {
			pids = append(pids, pid)
		}
		groups.Unlock()
		stopGroups(pids)
		shutdown.Lock()
		cleanup := shutdown.cleanup
		shutdown.Unlock()
		if cleanup != nil {
			cleanup()
		}
		os.Exit(130)
	}()
}

// Stopping reports whether signal shutdown has begun.
func Stopping() bool { groups.Lock(); defer groups.Unlock(); return groups.stopping }

// AwaitShutdown blocks once signal shutdown has begun, so the handler stops every group,
// runs the OnStop cleanup and exits 130 before a caller can report a stopped run as finished.
func AwaitShutdown() {
	groups.Lock()
	stopping := groups.stopping
	groups.Unlock()
	if stopping {
		select {}
	}
}

// groupAlive checks whether any member of a process group remains.
func groupAlive(pid int) bool { return syscall.Kill(-pid, 0) == nil }

// stopGroups sends TERM, waits five seconds, then sends KILL and waits briefly.
func stopGroups(pids []int) {
	live := []int{}
	for _, pid := range pids {
		if groupAlive(pid) {
			live = append(live, pid)
			_ = syscall.Kill(-pid, syscall.SIGTERM)
		}
	}
	anyAlive := func() bool {
		for _, pid := range live {
			if groupAlive(pid) {
				return true
			}
		}
		return false
	}
	for deadline := time.Now().Add(5 * time.Second); anyAlive() && time.Now().Before(deadline); {
		time.Sleep(50 * time.Millisecond)
	}
	for _, pid := range live {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
	for deadline := time.Now().Add(time.Second); anyAlive() && time.Now().Before(deadline); {
		time.Sleep(20 * time.Millisecond)
	}
}

// Options specifies stdin, working directory, environment and the hard time limit.
type Options struct {
	Input, Dir string
	Env        []string
	Timeout    time.Duration
	Stop       <-chan struct{} // closing it stops the command as a timeout does, without marking one
}

// Result contains decoded output, exit code (-1 for signals/spawn errors), and timeout state.
type Result struct {
	Code           int
	Stdout, Stderr string
	TimedOut       bool
	Signal         syscall.Signal
}

type tail struct{ b []byte }

// Write retains enough raw stderr for the last 64K UTF-16 units after decoding.
func (t *tail) Write(b []byte) (int, error) {
	n := len(b)
	t.b = append(t.b, b...)
	if len(t.b) > 4*64*1024 {
		t.b = t.b[len(t.b)-4*64*1024:]
	}
	return n, nil
}

// SignalName renders the common POSIX signal names used in process failures.
func SignalName(signal syscall.Signal) string {
	switch signal {
	case syscall.SIGINT:
		return "SIGINT"
	case syscall.SIGTERM:
		return "SIGTERM"
	case syscall.SIGKILL:
		return "SIGKILL"
	case syscall.SIGPIPE:
		return "SIGPIPE"
	case syscall.SIGHUP:
		return "SIGHUP"
	default:
		return signal.String()
	}
}

// Timeout clamps a seconds value to the supported timer range.
func Timeout(seconds float64) time.Duration {
	max := 2147483647 * time.Millisecond
	if seconds >= float64(max)/float64(time.Second) {
		return max
	}
	d := time.Duration(seconds * float64(time.Second))
	if d < time.Millisecond {
		return time.Millisecond
	}
	return d
}

// Run returns after the child exits, bounding pipe waits even for detached descendants.
// Failures become Result, and agent exit stops descendants in its process group.
func Run(command string, args []string, o Options) Result {
	r := Result{Code: -1}
	cmd := exec.Command(command, args...)
	cmd.Dir = o.Dir
	cmd.Env = o.Env
	cmd.SysProcAttr = attributes()
	inR, inW, e := os.Pipe()
	if e != nil {
		r.Stderr = e.Error()
		return r
	}
	defer inR.Close()
	outR, outW, e := os.Pipe()
	if e != nil {
		inW.Close()
		r.Stderr = e.Error()
		return r
	}
	defer outR.Close()
	errR, errW, e := os.Pipe()
	if e != nil {
		inW.Close()
		outW.Close()
		r.Stderr = e.Error()
		return r
	}
	defer errR.Close()
	cmd.Stdin = inR
	cmd.Stdout = outW
	cmd.Stderr = errW
	groups.Lock()
	if groups.stopping {
		groups.Unlock()
		inW.Close()
		outW.Close()
		errW.Close()
		r.Stderr = "ask was stopped"
		return r
	}
	e = cmd.Start()
	if e == nil {
		groups.pids[cmd.Process.Pid] = true
	}
	groups.Unlock()
	outW.Close()
	errW.Close()
	if e != nil {
		inW.Close()
		r.Stderr = e.Error() + "\n"
		return r
	}
	go func() { defer inW.Close(); _, _ = io.WriteString(inW, o.Input) }()
	outDone, errDone := make(chan string, 1), make(chan string, 1)
	go func() { b, _ := io.ReadAll(outR); outDone <- home.UTF8(b) }()
	go func() {
		t := &tail{}
		_, _ = io.Copy(t, errR)
		units := utf16.Encode([]rune(home.UTF8(t.b)))
		if len(units) > 64*1024 {
			units = units[len(units)-64*1024:]
		}
		errDone <- string(utf16.Decode(units))
	}()
	waited := make(chan Result, 1)
	go func() {
		_ = cmd.Wait()
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		result := Result{Code: cmd.ProcessState.ExitCode()}
		if state, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && state.Signaled() {
			result.Signal = state.Signal()
		}
		waited <- result
	}()
	d := o.Timeout
	if d < time.Millisecond {
		d = time.Millisecond
	}
	if d > 2147483647*time.Millisecond {
		d = 2147483647 * time.Millisecond
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case r = <-waited:
	case <-timer.C:
		stopGroups([]int{cmd.Process.Pid})
		r = <-waited
		r.TimedOut = true
	case <-o.Stop:
		stopGroups([]int{cmd.Process.Pid})
		r = <-waited
	}
	deadline := time.AfterFunc(time.Second, func() { outR.Close(); errR.Close() })
	r.Stdout = <-outDone
	r.Stderr = <-errDone
	deadline.Stop()

	groups.Lock()
	delete(groups.pids, cmd.Process.Pid)
	groups.Unlock()
	return r
}

var errorLine = regexp.MustCompile(`^(\w*(Error|Exception)|panic)\b[^:]*:`)

// Reason selects the last error line ahead of runtime stack traces and closing banners.
func Reason(stderr string) string {
	last, found := "", ""
	for _, line := range strings.Split(stderr, "\n") {
		line = home.Trim(line)
		if line == "" {
			continue
		}
		last = line
		if errorLine.MatchString(line) {
			found = line
		}
	}
	if found != "" {
		last = found
	}
	r := utf16.Encode([]rune(last))
	if len(r) > 300 {
		return string(utf16.Decode(r[:300]))
	}
	return last
}
