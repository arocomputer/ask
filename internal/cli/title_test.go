package cli

import (
	"testing"

	"github.com/arocomputer/ask/internal/task"
)

// TestTitleJobDropsWhatTheLabelSays keeps a host's "Model · Job" description from naming the model twice.
func TestTitleJobDropsWhatTheLabelSays(t *testing.T) {
	for _, c := range [][3]string{
		{"Sonnet 5.5 · Mine sessions", "Sonnet 5.5", "Mine sessions"},
		{"Opus 5.5 · Audit", "Opus 5.5 (high)", "Audit"},
		{"Opus 5.5 · Audit", "Batch of 4 · Opus 5.5", "Audit"},
		{"Fix login · tests", "Sonnet 5.5", "Fix login · tests"},
		{"Sonnet 5.5", "Sonnet 5.5", "Sonnet 5.5"},
	} {
		if got := task.JobTitle(c[0], "", c[1]); got != c[2] {
			t.Fatalf("%q with %q: %q", c[0], c[1], got)
		}
	}
}
