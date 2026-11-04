package status

import (
	"io"
	"os"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/runs"
	"github.com/arocomputer/ask/internal/task"
)

// TestFrame pins running rows with usage so far, queued and final rows, and a footer with total usage.
func TestFrame(t *testing.T) {
	t.Run("a named foreground run includes its stable ID", func(t *testing.T) {
		s := LiveState{Rows: []LiveRow{{Ref: "named-run", RunID: "abc123", State: "running"}}}
		got := strings.Join(Frame(s, time.Now(), 0, 100, 24, false, false), "\n")
		if !strings.Contains(got, "named-run · id abc123") {
			t.Fatal(got)
		}
	})
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
		"0/3 ok · 1 failed · 0:02 · reported: 1.2k in · 30 out",
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
	if got := Frame(s, time.Time{}, 0, 80, 5, false, true); len(got) > 4 || !strings.Contains(strings.Join(got, "\n"), "more lines") {
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

// TestLiveActivity keeps progress in the current row and clears it for follow-ups and completion.
func TestLiveActivity(t *testing.T) {
	l := &Live{state: LiveState{Rows: []LiveRow{{Ref: "run", State: "queued"}}}, done: make(chan struct{})}
	l.program = tea.NewProgram(&liveModel{width: 100, height: 24}, tea.WithInput(nil), tea.WithOutput(io.Discard), tea.WithoutSignalHandler())
	go func() { defer close(l.done); _, _ = l.program.Run() }()
	defer l.Finish("", false)
	start := runs.Event{Kind: "start", Started: task.Started{Task: home.O(), Dir: "/tmp"}}
	l.Update(start, "Model", "")
	l.Update(runs.Event{Kind: "usage", Result: home.O("input", 7)}, "", "")
	l.Update(runs.Event{Kind: "activity", Activity: "editing files"}, "", "")
	frame := strings.Join(Frame(l.state, time.Now(), 0, 100, 24, false, true), "\n")
	if !strings.Contains(frame, "editing files") || !strings.Contains(frame, "7 in") || len(l.state.Rows[0].Notes) != 0 {
		t.Fatalf("activity must share the live row with usage: %q", frame)
	}
	l.Update(runs.Event{Kind: "activity"}, "", "")
	if l.state.Rows[0].Activity != "" {
		t.Fatal("stale activity after a cleared report")
	}
	l.Update(runs.Event{Kind: "activity", Activity: "editing files"}, "", "")
	l.Update(start, "Model", "")
	if l.state.Rows[0].Activity != "" {
		t.Fatal("stale activity after follow-up start")
	}
	l.Update(runs.Event{Kind: "activity", Activity: "answering"}, "", "")
	l.Update(runs.Event{Kind: "done", Result: home.O("run", "run", "ok", true, "name", "Model")}, "", "")
	if frame := strings.Join(Frame(l.state, time.Now(), 0, 100, 24, false, true), "\n"); strings.Contains(frame, "answering") {
		t.Fatalf("activity survived completion: %q", frame)
	}
}

func TestFrameKeepsRunHandle(t *testing.T) {
	row := LiveRow{Ref: "review-fix", Name: "Model", State: "ok", Final: "ask review-fix · ok · Model · 10s · 100k in · 50k cache read · branch some-very-long-branch"}
	got := Frame(LiveState{Rows: []LiveRow{row}}, time.Now(), 0, 50, 24, false, false)[0]
	if !strings.Contains(got, "review-fix") {
		t.Fatalf("run handle was clipped: %q", got)
	}
}

func TestFramePrioritizesActiveRowsInLargeBatches(t *testing.T) {
	rows := make([]LiveRow, 10)
	for i := range rows {
		rows[i] = LiveRow{Ref: "batch/queued", State: "queued"}
	}
	rows[9] = LiveRow{Ref: "batch/active", State: "running", Name: "Model", Started: time.Now()}
	got := strings.Join(Frame(LiveState{Batch: true, Header: "batch", Rows: rows}, time.Now(), 0, 80, 5, false, false), "\n")
	if !strings.Contains(got, "active") || !strings.Contains(got, "0/10 ok") {
		t.Fatalf("active task or footer hidden: %s", got)
	}
}
