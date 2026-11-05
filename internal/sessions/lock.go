package sessions

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/arocomputer/ask/internal/config"
)

// Owner returns the pid holding a session's lock, asking the kernel without taking the lock,
// 0 when no process holds it, or -1 when it is held by a process outside this PID
// namespace (a container or sandbox), which the kernel reports as pid 0.
func Owner(s *Session) int {
	f, err := os.Open(filepath.Join(s.Folder, "lock"))
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

// Lock takes an exclusive kernel record lock for the complete execution of a turn. The lock
// belongs to this process and is released when the returned file closes or the process exits.
func Lock(s *Session) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(s.Folder, "lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.FcntlFlock(f.Fd(), syscall.F_SETLK, &syscall.Flock_t{Type: syscall.F_WRLCK}); err != nil {
		f.Close()
		return nil, config.Usage("session %s is running; stop it with ask stop %s", s.ID, s.ID)
	}
	return f, nil
}

// Stop sends SIGTERM to the live session owner and waits up to ten seconds for it to release the session.
// It returns false when nothing was running and an error when the owner outlives the wait or
// runs outside this PID namespace, where ask cannot signal it.
func Stop(s *Session) (bool, error) {
	pid := Owner(s)
	if pid == 0 {
		return false, nil
	}
	if pid < 0 {
		return false, fmt.Errorf("session %s is running outside this sandbox or container; stop it from there", s.ID)
	}
	if e := syscall.Kill(pid, syscall.SIGTERM); e != nil {
		return false, e
	}
	for i := 0; i < 200 && Owner(s) == pid; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if Owner(s) == pid {
		return false, fmt.Errorf("session %s did not stop within 10 seconds (pid %d)", s.ID, pid)
	}
	return true, nil
}
