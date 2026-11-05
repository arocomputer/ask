package task

import "testing"

func TestTitleIsSharedAcrossAgentSessions(t *testing.T) {
	for _, tc := range []struct {
		name, prompt, override string
		write, worktree        bool
		want                   string
	}{
		{"read", "fix the login", "", false, false, "GPT-6.1 Sol · Fix the login"},
		{"write", "fix the login", "", true, false, "GPT-6.1 Sol · Fix the login · write"},
		{"worktree", "fix the login", "", true, true, "GPT-6.1 Sol · Fix the login · worktree"},
		{"multiline", "first line\nmore context", "", false, false, "GPT-6.1 Sol · First line"},
		{"override", "actual prompt", "Review parser edge cases", false, false, "GPT-6.1 Sol · Review parser edge cases"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := Title("GPT-6.1 Sol", tc.prompt, tc.override, tc.write, tc.worktree); got != tc.want {
				t.Fatalf("Title() = %q, want %q", got, tc.want)
			}
		})
	}
}
