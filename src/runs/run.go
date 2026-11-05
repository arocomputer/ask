// Package runs records, validates, follows up, resumes and stops runs under ASK_HOME/runs.
package runs

import (
	"crypto/rand"
	"path/filepath"
	"strings"
	"sync"

	"github.com/arocomputer/ask/src/home"
)

// Run is a saved run with immutable tasks and position-matched results (nil means unfinished).
// ID never changes; Name is the run's readable handle, shared by its follow-ups, and may be empty.
type Run struct {
	ID, Name, Dir, Created string
	Tasks, Results         []home.Object
	// Closing any descriptor of a process-owned record lock releases it. Keep
	// execution's deferred close from dropping an overlapping cleanup's lock.
	lockMu sync.Mutex
}

// Label is the name people and agents use for a run: its Name, or its ID when it has none.
func (r *Run) Label() string {
	if r.Name != "" {
		return r.Name
	}
	return r.ID
}

// folder splits a run folder STAMP-ID[-NAME]; folders from before names have no NAME.
func folder(n string) (created, id, name string) {
	parts := strings.SplitN(n, "-", 3)
	if len(parts) < 2 {
		return "", n, ""
	}
	if len(parts) == 3 {
		name = parts[2]
	}
	return parts[0], parts[1], name
}

// NewID returns six lowercase letters and digits.
func NewID() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, 6)
	for i := range b {
		var v [1]byte
		for {
			_, _ = rand.Read(v[:])
			if v[0] < 252 {
				break
			}
		}
		b[i] = alphabet[int(v[0])%36]
	}
	return string(b)
}

// Ref names a single task by its run's label, or a batch task as LABEL/TASK.
func Ref(r *Run, index int) string {
	if len(r.Tasks) == 1 {
		return r.Label()
	}
	return r.Label() + "/" + r.Tasks[index].S("id")
}

// In reports whether any of the run's tasks worked inside one of the given checkouts.
func In(r *Run, checkouts []string) bool {
	for _, t := range r.Tasks {
		dir := t.S("dir")
		if real, e := filepath.EvalSymlinks(dir); e == nil {
			dir = real
		}
		for _, c := range checkouts {
			if dir == c || strings.HasPrefix(dir, c+string(filepath.Separator)) {
				return true
			}
		}
	}
	return false
}
