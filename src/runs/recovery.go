package runs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/arocomputer/ask/src/git"
	"github.com/arocomputer/ask/src/home"
)

// A recovery record belongs only to the current attempt. Before starting another attempt,
// Execute removes it and clears the old result under the run lock. Immutable task sessions
// are never evidence that an interrupted rerun reached that conversation.
type recoveryRecord struct {
	Task     *home.TaskRecord     `json:"task"`
	Dir      string               `json:"dir"`
	Session  string               `json:"session"`
	Worktree *home.WorktreeRecord `json:"worktree,omitempty"`
	Blocker  string               `json:"blocker,omitempty"`
}

func recoveryPath(r *Run, i int) string {
	return filepath.Join(r.Dir, fmt.Sprintf("recovery-%d.json", i))
}

func recovery(r *Run, i int) *recoveryRecord {
	if result := r.Results[i]; result != nil {
		t := r.Tasks[i].Clone()
		for _, key := range []string{"model", "write"} {
			if result.Has(key) {
				t.Set(key, result.Get(key))
			}
		}
		s := &recoveryRecord{Task: &home.TaskRecords([]home.Object{t})[0], Dir: result.S("dir"), Session: result.S("session")}
		if kept, ok := result.Get("worktree").(home.Object); ok {
			s.Worktree = &home.WorktreeRecord{Path: kept.S("path"), Branch: kept.S("branch")}
		}
		if !result.B("ok") {
			s.Blocker = automaticBlocker(result.S("error"))
		}
		return s
	}
	b, err := os.ReadFile(recoveryPath(r, i))
	var s recoveryRecord
	if err != nil || json.Unmarshal(b, &s) != nil || s.Task == nil {
		return nil
	}
	return &s
}

// Error reports have no standardized failure code in contract v1. Match explicit blocker
// language, leaving transient errors and unknown failures eligible for recovery.
var blockerWords = regexp.MustCompile(`(?i)\b(` +
	`auth(?:entication|orization)?|unauthenticated|unauthorized|forbidden|401|403|` +
	`(?:invalid|missing) api[ _-]?key|api[ _-]?key (?:required|not found)|` +
	`log[ -]?in|logged (?:in|out)|sign[ -]?in|access denied|permission denied|` +
	`refus\w*|safety policy|cost limit|spending limit|usage limit|budget|quota|billing|` +
	`insufficient (?:credits|balance)|credit balance|payment required)\b`)

func automaticBlocker(reason string) string {
	if blockerWords.MatchString(reason) {
		return reason
	}
	return ""
}

// recoverTask chooses an actual reported session and location, or a fresh attempt with the
// original prompt. Missing/replaced worktrees must not silently create a new session location.
func recoverTask(r *Run, i int, automatic bool) (home.Object, string, bool) {
	t := r.Tasks[i].Clone()
	t.Delete("session")
	t.Delete("continues")
	t.Delete("reuse")
	t.Delete("kept_worktree")
	s := recovery(r, i)
	if automatic && s != nil && s.Blocker != "" {
		return nil, "blocked: " + s.Blocker + "; resolve it and give an explicit follow-up prompt", false
	}
	if s == nil || s.Session == "" {
		return t, "no usable saved session; rerunning 1 task from the beginning", false
	}
	if s.Task.Model == "" || s.Dir == "" || s.Task.Dir != t.S("dir") {
		return t, "saved session location is unsafe; rerunning 1 task from the beginning", false
	}
	if t.B("worktree") {
		if s.Worktree == nil || git.CheckWorktree(s.Task.Dir, s.Worktree) != nil {
			return t, "saved worktree is missing or changed; rerunning 1 task from the beginning", false
		}
		realDir, dirErr := filepath.EvalSymlinks(s.Dir)
		realTree, treeErr := filepath.EvalSymlinks(s.Worktree.Path)
		rel, err := filepath.Rel(realTree, realDir)
		if dirErr != nil || treeErr != nil || err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return t, "saved session location is unsafe; rerunning 1 task from the beginning", false
		}
		t.Set("kept_worktree", home.O("path", s.Worktree.Path, "branch", s.Worktree.Branch))
		t.Set("reuse", true)
	} else if filepath.Clean(s.Dir) != filepath.Clean(s.Task.Dir) {
		return t, "saved session location is unsafe; rerunning 1 task from the beginning", false
	}
	if info, err := os.Stat(s.Dir); err != nil || !info.IsDir() {
		return t, "saved session directory is missing; rerunning 1 task from the beginning", false
	}
	t.Set("model", s.Task.Model)
	t.Set("write", s.Task.Write)
	t.Set("session", s.Session)
	t.Set("prompt", "Continue the existing conversation and finish the original task. Check the work already done, complete what remains, and report the result.\n\nOriginal task:\n"+t.S("prompt"))
	return t, "continuing saved conversation to finish the original task", true
}

// InterruptedWorktree returns an unfinished attempt's recorded worktree, so cleanup accounts
// for its changes even though no final result exists yet. It never infers a path from settings.
func InterruptedWorktree(r *Run, i int) *home.WorktreeRecord {
	if r.Results[i] != nil || Owner(r) != 0 {
		return nil
	}
	if s := recovery(r, i); s != nil {
		return s.Worktree
	}
	return nil
}
