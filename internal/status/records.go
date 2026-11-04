package status

import (
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/runs"
)

// RunRecord is the machine listing contract. Created is the saved UTC run timestamp.
// Tasks deliberately omit prompts, answers, sessions, schemas, notes and errors: listing
// runs should disclose only identity, state and execution metadata.
type RunRecord struct {
	RunID   string       `json:"run_id"`
	Name    string       `json:"name,omitempty"`
	Created string       `json:"created"`
	State   string       `json:"state"`
	Tasks   []TaskRecord `json:"tasks"`
}

// TaskRecord identifies a task independently of its possibly numeric ID. Position is
// one-based and present only in batches. State is running, stopped, failed or success.
type TaskRecord struct {
	TaskID    string               `json:"task_id"`
	Position  int                  `json:"position,omitempty"`
	State     string               `json:"state"`
	Model     string               `json:"model"`
	Dir       string               `json:"dir"`
	Write     bool                 `json:"write"`
	Continues string               `json:"continues,omitempty"`
	Seconds   *float64             `json:"seconds,omitempty"`
	Usage     *home.UsageRecord    `json:"usage,omitempty"`
	Worktree  *home.WorktreeRecord `json:"worktree,omitempty"`
}

// Record uses pending state sampled before results. Pending results may belong to an
// earlier attempt and must never appear completed, even after an interrupted retry.
// An active owner without matching pending state is conservatively still running.
func Record(r *runs.Run, owner int, pending map[int]bool, known bool) RunRecord {
	out := RunRecord{RunID: r.ID, Name: r.Name, Created: r.Created, State: "success", Tasks: make([]TaskRecord, len(r.Tasks))}
	for i, t := range r.Tasks {
		x := TaskRecord{TaskID: t.S("id"), State: "success", Model: t.S("model"), Dir: t.S("dir"), Write: t.B("write"), Continues: t.S("continues")}
		if len(r.Tasks) > 1 {
			x.Position = i + 1
		}
		result := r.Results[i]
		if result == nil || known && pending[i] || owner != 0 && !known {
			x.State = "stopped"
			if owner != 0 {
				x.State = "running"
			}
		} else {
			if !result.B("ok") {
				x.State = "failed"
			}
			saved := home.ResultRecords([]home.Object{result})[0]
			x.Seconds, x.Usage, x.Worktree = &saved.Seconds, saved.Usage, saved.Worktree
			if saved.Write != nil {
				x.Write = *saved.Write
			}
		}
		if x.State == "stopped" || x.State == "failed" && out.State == "success" {
			out.State = x.State
		}
		out.Tasks[i] = x
	}
	if owner != 0 {
		out.State = "running"
	}
	return out
}
