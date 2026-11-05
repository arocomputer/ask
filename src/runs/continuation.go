package runs

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	"github.com/arocomputer/ask/src/agent"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/task"
)

// lockContinuations reserves every pending continuation before any task starts, so duplicate
// sessions in a batch are refused even with -j 1. Hold reservations through hooks, worktree
// cleanup and saving results. flock belongs to each open file description, unlike the run's
// process-owned record lock: separate opens conflict within this process as well as across it.
func lockContinuations(p home.Paths, r *Run, todo []int) (func(), error) {
	var held []*os.File
	release := func() {
		for _, f := range held {
			f.Close()
		}
	}
	claim := func(key, resource, ref string) error {
		dir := filepath.Join(p.Home, "continuation-locks")
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		// Hash session IDs rather than putting agent-provided strings in filenames.
		path := filepath.Join(dir, fmt.Sprintf("%x", sha256.Sum256([]byte(key))))
		f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			return err
		}
		if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			f.Close()
			if err == syscall.EWOULDBLOCK || err == syscall.EAGAIN {
				return home.Usage("%s: %s is already in use by another task; retry after it finishes", ref, resource)
			}
			return err
		}
		// Keep the inode: unlinking on release could let another process lock a replacement.
		held = append(held, f)
		return nil
	}
	for _, i := range todo {
		t := r.Tasks[i]
		if t.B("session") {
			m, err := agent.Parse(p, t.S("model"))
			if err == nil {
				err = claim("session\x00"+m.Agent+"\x00"+t.S("session"), "agent session", Ref(r, i))
			}
			if err != nil {
				release()
				return nil, err
			}
		}
		kept, err := task.KeptWorktree(p, t)
		if err == nil && kept != nil {
			path := filepath.Clean(kept.Path)
			// Resolve the nearest existing ancestor so a removed worktree has the same key
			// before and after recreation, including when its parent is a symlink.
			for parent := path; ; parent = filepath.Dir(parent) {
				if real, e := filepath.EvalSymlinks(parent); e == nil {
					rel, _ := filepath.Rel(parent, path)
					path = filepath.Join(real, rel)
					break
				}
				if filepath.Dir(parent) == parent {
					break
				}
			}
			err = claim("worktree\x00"+path, "worktree", Ref(r, i))
		}
		if err != nil {
			release()
			return nil, err
		}
	}
	return release, nil
}
