package status

import (
	"strings"
	"testing"
	"time"

	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/runs"
)

// TestStatusFormatting pins outcome order and cost precision for plain streams.
func TestStatusFormatting(t *testing.T) {
	result := home.Object{"run": "abc123", "ok": true, "name": "Sonnet 5.5", "seconds": 3.7, "usage": home.Object{"input": 32400, "output": 4, "cost": 0.04}}
	if got := Done(result); got != "ask abc123 · succeeded · Sonnet 5.5 · 3.7s · 32.4k in · 4 out · $0.04" {
		t.Fatal(got)
	}
	result.Set("usage", home.Object{"input": 1, "output": 1, "cost": 0.0025})
	if !strings.HasSuffix(Done(result), "$0.0025") {
		t.Fatal(Done(result))
	}
}

// TestRunsTable pins relative start times and omission of wholly empty columns.
func TestRunsTable(t *testing.T) {
	now := time.Date(2026, 10, 2, 12, 2, 0, 0, time.UTC)
	r := &runs.Run{ID: "abc123", Created: "20261002T120000000", Tasks: []home.Object{{"prompt": "Check login"}}, Results: []home.Object{nil}}
	got := Table([]*runs.Run{r}, now, false)
	if !strings.Contains(got, "2m ago") || strings.Contains(strings.Split(got, "\n")[0], "TIME") || !strings.Contains(got, "stopped") {
		t.Fatal(got)
	}
}

func TestRunRecord(t *testing.T) {
	r := &runs.Run{ID: "abc123", Tasks: []home.Object{{"id": "1"}, {"id": "custom"}}, Results: []home.Object{{"ok": true}, {"ok": false, "seconds": 99}}}
	for _, tt := range []struct {
		name    string
		owner   int
		pending map[int]bool
		known   bool
		state   string
		tasks   string
	}{
		{"saved failure", 0, nil, false, "failed", "succeeded,failed"},
		{"retry running", 123, map[int]bool{1: true}, true, "running", "succeeded,running"},
		{"retry stopped", 0, map[int]bool{1: true}, true, "stopped", "succeeded,stopped"},
		{"owner preparing pending", 123, nil, false, "running", "running,running"},
		{"owner outside PID namespace", -1, nil, false, "running", "running,running"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got := Record(r, tt.owner, tt.pending, tt.known)
			if got.State != tt.state || got.Tasks[0].State+","+got.Tasks[1].State != tt.tasks {
				t.Fatalf("%+v", got)
			}
			if got.Tasks[1].Position != 2 || got.Tasks[1].TaskID != "custom" {
				t.Fatalf("lost task identity: %+v", got.Tasks[1])
			}
			if got.Tasks[1].State != "failed" && got.Tasks[1].Seconds != nil {
				t.Fatal("included stale attempt metadata")
			}
		})
	}
}

// TestBatchEndPartialCost leaves out a cost that only some tasks reported.
func TestBatchEndPartialCost(t *testing.T) {
	r := &runs.Run{ID: "abc123", Tasks: []home.Object{{}, {}}, Results: []home.Object{
		{"ok": true, "usage": home.Object{"input": 10, "output": 5, "cost": 0.01}},
		{"ok": true, "usage": home.Object{"input": 100, "output": 50}},
	}}
	if got := BatchEnd(r, 1); got != "ask abc123 · 2 succeeded · 0 failed · 1.0s · reported: 110 in · 55 out" {
		t.Fatal(got)
	}
}

func TestBatchOutcomeCounts(t *testing.T) {
	r := &runs.Run{ID: "batch", Results: []home.Object{{"ok": true}, {"ok": false}, nil}}
	if got := BatchSaved(r); got != "ask batch · 1 succeeded · 1 failed · 1 stopped" {
		t.Fatal(got)
	}
	if got := BatchEnd(r, 1); got != "ask batch · 1 succeeded · 1 failed · 1 stopped · 1.0s" {
		t.Fatal(got)
	}
}

func TestUsageReportedMetrics(t *testing.T) {
	for _, tt := range []struct {
		name  string
		usage home.Object
		want  string
	}{
		{"cached input", home.O("input", 1200000, "output", 7000, "cached", 1100000), "1200.0k in · 7.0k out · 1100.0k cache read"},
		{"cost only", home.O("cost", 0.05), "$0.05"},
		{"cached only", home.O("cached", 3000), "3.0k cache read"},
		{"unreported", home.Object{}, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := Usage(tt.usage); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBatchUsageOmitsPartialCache(t *testing.T) {
	usage := batchUsage([]any{home.O("input", 100, "cached", 60), home.O("input", 50)})
	if got := Usage(usage); got != "150 in" {
		t.Fatalf("partial cache presented as total: %s", got)
	}
}

func TestBatchUsageOmitsCostWhenTaskReportsNothing(t *testing.T) {
	usage := batchUsage([]any{home.O("input", 100, "cost", 0.5), nil})
	if got := Usage(usage); got != "100 in" {
		t.Fatalf("partial cost presented as total: %s", got)
	}
}

func TestDoneIncludesKeptWorktree(t *testing.T) {
	r := home.O("run", "abc", "ok", true, "name", "Model", "seconds", 1, "worktree", home.O("branch", "ask/fix", "path", "/tmp/ask-fix"))
	if got := Done(r); !strings.Contains(got, "branch ask/fix · worktree /tmp/ask-fix") {
		t.Fatal(got)
	}
}
