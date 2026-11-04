package runs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// progressPath keeps transient task state apart from saved results.
func progressPath(r *Run, index int) string {
	return filepath.Join(r.Dir, fmt.Sprintf("progress-%d.json", index))
}

type progressRecord struct {
	PID      int    `json:"pid"`
	Activity string `json:"activity"`
}

// Activities returns the current owner's reported activities, ignoring stale snapshots.
func Activities(r *Run) []string {
	return activities(r, Owner(r))
}

func activities(r *Run, owner int) []string {
	out := make([]string, len(r.Tasks))
	if owner <= 0 {
		return out
	}
	for i := range r.Tasks {
		data, err := os.ReadFile(progressPath(r, i))
		if err != nil || len(data) > 4096 {
			continue
		}
		var p progressRecord
		if json.Unmarshal(data, &p) != nil || p.PID != owner {
			continue
		}
		switch p.Activity {
		case "thinking", "running commands", "editing files", "searching", "using tools", "answering":
			out[i] = p.Activity
		}
	}
	return out
}
