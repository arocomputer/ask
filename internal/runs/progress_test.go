package runs

import (
	"os"
	"testing"

	"github.com/arocomputer/ask/internal/home"
)

func TestActivitiesIgnoreStaleOrUnrecognizedReports(t *testing.T) {
	r := &Run{Dir: t.TempDir(), Tasks: []home.Object{{}, {}}}
	if err := os.WriteFile(progressPath(r, 0), []byte(`{"pid":42,"activity":"running commands"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(progressPath(r, 1), []byte(`{"pid":42,"activity":"private command text"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if got := activities(r, 42); got[0] != "running commands" || got[1] != "" {
		t.Fatal(got)
	}
	if got := activities(r, 43); got[0] != "" || got[1] != "" {
		t.Fatal(got)
	}
}
