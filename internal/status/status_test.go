package status

import (
	"strings"
	"testing"
	"time"

	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/runs"
)

// TestStatusFormatting pins outcome order and cost precision for plain streams.
func TestStatusFormatting(t *testing.T) {
	result := home.Object{"run": "abc123", "ok": true, "name": "Sonnet 5.5", "seconds": 3.7, "usage": home.Object{"input": 32400, "output": 4, "cost": 0.04}}
	if got := Done(result); got != "ask abc123 · ok · Sonnet 5.5 · 3.7s · 32.4k in · 4 out · $0.04" {
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

// TestBatchEndPartialCost leaves out a cost that only some tasks reported.
func TestBatchEndPartialCost(t *testing.T) {
	r := &runs.Run{ID: "abc123", Tasks: []home.Object{{}, {}}, Results: []home.Object{
		{"ok": true, "usage": home.Object{"input": 10, "output": 5, "cost": 0.01}},
		{"ok": true, "usage": home.Object{"input": 100, "output": 50}},
	}}
	if got := BatchEnd(r, 1); got != "ask abc123 · 2/2 ok · 1.0s · 110 in · 55 out" {
		t.Fatal(got)
	}
}
