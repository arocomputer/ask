package status

import (
	"io"
	"os"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/arocomputer/ask/internal/home"
)

// TestFrame pins running rows with usage so far, queued and final rows, and a footer with total usage.
func TestFrame(t *testing.T) {
	now := time.Unix(100, 0)
	s := LiveState{Header: "ask abc123 · batch of 3", Batch: true, Started: now.Add(-2 * time.Second), Rows: []LiveRow{
		{Ref: "abc123/a", Name: "Small One", Access: "read", Dir: "/tmp", State: "running", Started: now.Add(-2 * time.Second), Usage: home.O("input", 1200.0, "output", 30.0, "cost", 0.05)},
		{Ref: "abc123/b", Name: "Big", State: "queued"},
		{Ref: "abc123/c", Name: "Big", State: "failed", Reason: "quota exceeded"},
	}}
	got := Frame(s, now, 0, 100, 24, false, true)
	want := []string{
		"ask abc123 · batch of 3",
		"⠋ a  Small One  read · /tmp · 0:02 · 1.2k in · 30 out · $0.05",
		"· b  Big        queued",
		"✗ c  Big        quota exceeded",
		"0/3 ok · 1 failed · 0:02 · 1.2k in · 30 out · $0.05",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("%#v", got)
	}
	color := Frame(s, now, 0, 100, 24, true, true)
	if !strings.HasPrefix(color[3], "\x1b[31m✗\x1b[0m") {
		t.Fatalf("colors: %#v", color)
	}
	s.Rows[0].State = "ok"
	s.Rows[0].Final = "ask abc123/a · ok · Small One · 2.0s"
	if !strings.HasPrefix(Frame(s, now, 0, 100, 24, true, true)[1], "\x1b[32m✓\x1b[0m") {
		t.Fatal("missing green success")
	}
	if !strings.HasPrefix(Frame(s, now, 0, 100, 24, false, false)[1], "+ a  Small One") {
		t.Fatal("missing ASCII marks")
	}
}

// TestFrameClipping prevents narrow terminals, control characters and wide text from wrapping.
func TestFrameClipping(t *testing.T) {
	for _, width := range []int{1, 2, 8, 20} {
		s := LiveState{Rows: []LiveRow{{Ref: "abc123", Name: "模型🐧\n\x1b[2J", State: "queued"}}}
		got := Frame(s, time.Time{}, 0, width, 24, false, true)[0]
		n := 0
		for _, r := range got {
			n += cells(r)
		}
		if n > width-1 || strings.ContainsAny(got, "\n\x1b") {
			t.Fatalf("width %d: %q (%d)", width, got, n)
		}
	}
	s := LiveState{Batch: true, Header: "batch", Rows: make([]LiveRow, 30)}
	if got := Frame(s, time.Time{}, 0, 80, 5, false, true); len(got) > 4 || !strings.Contains(got[len(got)-1], "more lines") {
		t.Fatalf("height: %#v", got)
	}
}

// TestLiveBatchFinishPrintsTotals prints the same batch summary on a terminal.
func TestLiveBatchFinishPrintsTotals(t *testing.T) {
	old := os.Stderr
	r, w, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	os.Stderr = w
	defer func() { os.Stderr = old }()
	l := &Live{state: LiveState{Batch: true}, done: make(chan struct{})}
	l.program = tea.NewProgram(&liveModel{width: 80, height: 24}, tea.WithInput(nil), tea.WithOutput(w), tea.WithoutSignalHandler())
	go func() { defer close(l.done); _, _ = l.program.Run() }()
	l.Finish("ask run · 2/2 ok · 10 in · 5 out · $0.02", false)
	w.Close()
	b, _ := io.ReadAll(r)
	if !strings.Contains(string(b), "10 in · 5 out · $0.02") {
		t.Fatalf("missing totals: %q", b)
	}
}
