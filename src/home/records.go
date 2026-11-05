package home

import "encoding/json"

// TaskRecord is the version 1 prepared task on disk, in the documented field order.
// Schema retains user key order; omitted optional fields remain omitted on a new record.
// Reuse marks a follow-up continuing a worktree the previous turn kept, rather than claiming one.
type TaskRecord struct {
	ID        string          `json:"id"`
	Prompt    string          `json:"prompt"`
	Title     string          `json:"title,omitempty"`
	Model     string          `json:"model"`
	Write     bool            `json:"write"`
	JSON      bool            `json:"json"`
	Schema    json.RawMessage `json:"schema,omitempty"`
	Dir       string          `json:"dir"`
	Timeout   float64         `json:"timeout"`
	MaxCost   float64         `json:"max_cost,omitempty"`
	Worktree  string          `json:"worktree,omitempty"`
	Reuse     bool            `json:"reuse,omitempty"`
	Session   string          `json:"session,omitempty"`
	Continues string          `json:"continues,omitempty"`
}

// UsageRecord carries optional token counts and USD cost; nil usage means no report.
type UsageRecord struct {
	Input  *float64 `json:"input,omitempty"`
	Output *float64 `json:"output,omitempty"`
	Cached *float64 `json:"cached,omitempty"`
	Cost   *float64 `json:"cost,omitempty"`
}

// ChangeRecord describes a file content, mode or link change in a write run.
type ChangeRecord struct {
	Path   string `json:"path"`
	Change string `json:"change"`
}

// WorktreeRecord identifies an isolated branch kept for review.
type WorktreeRecord struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
}

// ResultRecord is a version 1 result, preserving the documented field order and raw JSON answer.
// Answer is absent on failures; write records effective access; changes and commits track write runs.
type ResultRecord struct {
	Run       string          `json:"run"`
	ID        string          `json:"id"`
	Model     string          `json:"model"`
	Write     *bool           `json:"write,omitempty"`
	Name      string          `json:"name"`
	OK        bool            `json:"ok"`
	Answer    json.RawMessage `json:"answer,omitempty"`
	Note      string          `json:"note,omitempty"`
	Error     string          `json:"error,omitempty"`
	Seconds   float64         `json:"seconds"`
	Usage     *UsageRecord    `json:"usage"`
	Session   *string         `json:"session"`
	Dir       string          `json:"dir"`
	Changes   *[]ChangeRecord `json:"changes,omitempty"`
	Commits   *int            `json:"commits,omitempty"`
	Worktree  *WorktreeRecord `json:"worktree,omitempty"`
	Followups int             `json:"followups,omitempty"`
}

// TaskRecords converts validated dynamic tasks to their typed disk representation.
func TaskRecords(tasks []Object) []TaskRecord {
	out := make([]TaskRecord, len(tasks))
	for i, t := range tasks {
		if err := json.Unmarshal([]byte(JSON(t, false)), &out[i]); err != nil {
			panic(err)
		}
	}
	return out
}

// ResultRecords converts dynamic hook results to typed records, keeping unfinished slots null.
func ResultRecords(results []Object) []*ResultRecord {
	out := make([]*ResultRecord, len(results))
	for i, r := range results {
		if r == nil {
			continue
		}
		out[i] = &ResultRecord{}
		if err := json.Unmarshal([]byte(JSON(r, false)), out[i]); err != nil {
			panic(err)
		}
	}
	return out
}
