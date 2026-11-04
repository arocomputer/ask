package cli

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/runs"
	"github.com/arocomputer/ask/internal/tui"
)

// TestReporterActivity bounds plain output per task, resetting the limit for a follow-up round.
func TestReporterActivity(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	old := os.Stderr
	os.Stderr = f
	defer func() { os.Stderr = old }()
	r := &runs.Run{ID: "run", Tasks: []home.Object{home.O("id", "a"), home.O("id", "b")}}
	report := reporter(nil, r, nil)
	report(runs.Event{Kind: "activity", Activity: "thinking"})
	report(runs.Event{Kind: "activity", Activity: "thinking"})
	report(runs.Event{Kind: "activity", Activity: "editing files"})
	report(runs.Event{Kind: "activity", Index: 1, Activity: "using tools"})
	report(runs.Event{Kind: "start"})
	report(runs.Event{Kind: "activity", Activity: "answering"})
	b, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	if strings.Count(text, " · activity · ") != 3 || strings.Contains(text, "editing files") ||
		!strings.Contains(text, "ask run/b · activity · using tools") || !strings.Contains(text, "activity · answering") {
		t.Fatalf("activity must be deduplicated, throttled per task, and reset for follow-ups: %q", text)
	}
}

func TestCompletedFollowup(t *testing.T) {
	var out bytes.Buffer
	p := &tui.Prompter{In: strings.NewReader("finish please\r"), Out: &out}
	r := &runs.Run{Name: "done", Tasks: []home.Object{home.O("id", "a", "prompt", "one")}}
	ref, prompt, err := completedFollowup(p, r, 0, "done")
	if err != nil || ref != "done" || prompt != "finish please" {
		t.Fatalf("%q %q %v", ref, prompt, err)
	}
}
