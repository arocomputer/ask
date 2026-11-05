package status

import (
	"os"
	"testing"
)

// TestTerminalSizeUsesColumns uses a positive environment width when ioctl fails.
func TestTerminalSizeUsesColumns(t *testing.T) {
	t.Setenv("COLUMNS", "132")
	f, e := os.CreateTemp(t.TempDir(), "file")
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	width, _, _ := terminalSize(f)
	if width != 132 {
		t.Fatalf("width %d", width)
	}
}
