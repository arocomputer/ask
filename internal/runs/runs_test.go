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

func TestCompleteUsageOmitsMissingRounds(t *testing.T) {
	first := home.O("input", 100, "cost", 0.2)
	second := home.O("input", 50)
	got := completeUsage(first, second)
	if home.JSON(got, false) != `{"input":150}` {
		t.Fatalf("partial cost presented as total: %v", got)
	}
	if got := completeUsage(first, nil); got != nil {
		t.Fatalf("unreported round treated as zero: %v", got)
	}
}
