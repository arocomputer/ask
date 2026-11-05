package process

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestDetachedPipeHolderCannotHangRun bounds waiting for a detached output-pipe holder. Perl detaches
// it because macOS has no setsid command.
func TestDetachedPipeHolderCannotHangRun(t *testing.T) {
	dir := t.TempDir()
	pidfile := filepath.Join(dir, "pid")
	begin := time.Now()
	r := Run("sh", []string{"-c", `perl -MPOSIX -e 'POSIX::setsid(); open my $f, ">", $ARGV[0]; print $f $$; close $f; exec "sleep", "30"' "$1" & while [ ! -s "$1" ]; do sleep 0.01; done; echo done`, "sh", pidfile}, Options{Env: os.Environ(), Timeout: 2 * time.Second})
	if b, e := os.ReadFile(pidfile); e == nil {
		if pid, e := strconv.Atoi(strings.TrimSpace(string(b))); e == nil {
			defer syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	if r.Code != 0 || strings.TrimSpace(r.Stdout) != "done" {
		t.Fatalf("result: %#v", r)
	}
	if time.Since(begin) > 3*time.Second {
		t.Fatal("waited too long for detached pipe")
	}
}
