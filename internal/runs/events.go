package runs

import (
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

// eventsFile preserves each task position's stream across retries and hook follow-ups.
// Activity is optional: unsafe paths or I/O errors disable it without failing the task.
func eventsFile(r *Run, index int) string {
	path, err := filepath.Abs(filepath.Join(r.Dir, "events-"+strconv.Itoa(index)+".jsonl"))
	if err != nil {
		return ""
	}
	// Never truncate, follow a substituted symlink or block opening a special file.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return ""
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Sys().(*syscall.Stat_t).Nlink != 1 {
		return ""
	}
	if err := f.Chmod(0600); err != nil {
		return ""
	}
	return path
}
