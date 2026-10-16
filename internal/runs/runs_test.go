package runs

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/arocomputer/ask/internal/home"
)

// TestOwnerRequiresHeldLock treats a stale PID, even a reused live PID, as idle.
func TestOwnerRequiresHeldLock(t *testing.T) {
	r := &Run{Dir: t.TempDir()}
	if e := os.WriteFile(filepath.Join(r.Dir, "lock"), []byte(strconv.Itoa(os.Getpid())), 0600); e != nil {
		t.Fatal(e)
	}
	if got := Owner(r); got != 0 {
		t.Fatalf("stale lock owned by %d", got)
	}

}

// TestAddUsageKeepsOnlyReported never invents zero token counts for an agent that reports only cost.
func TestAddUsageKeepsOnlyReported(t *testing.T) {
	got := home.JSON(AddUsage(home.O("cost", 0.5), home.O("cost", 0.25)), false)
	if got != `{"cost":0.75}` {
		t.Fatal(got)
	}
}
