package runs

import (
	"os"
	"testing"

	"github.com/arocomputer/ask/src/home"
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

func TestPendingRequiresCurrentOwner(t *testing.T) {
	r := &Run{Dir: t.TempDir(), Tasks: []home.Object{{}, {}}}
	if err := home.WriteJSON(pendingPath(r), pendingRecord{PID: 42, Tasks: []int{1}}); err != nil {
		t.Fatal(err)
	}
	pending, ok := Pending(r, 42)
	if !ok || !pending[1] || pending[0] {
		t.Fatal(pending, ok)
	}
	if _, ok := Pending(r, 43); ok {
		t.Fatal("accepted another process's snapshot")
	}
	if err := home.WriteJSON(pendingPath(r), pendingRecord{PID: 42, Tasks: []int{2}}); err != nil {
		t.Fatal(err)
	}
	if _, ok := Pending(r, 42); ok {
		t.Fatal("accepted an invalid task index")
	}
}
