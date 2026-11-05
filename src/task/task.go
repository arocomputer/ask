// Package task runs one task, including worktrees, prompts, git changes and JSON checks.
package task

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/arocomputer/ask/src/agent"
	"github.com/arocomputer/ask/src/git"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/hooks"
	"github.com/arocomputer/ask/src/schema"
)

var fence = regexp.MustCompile("(?is)^\\s*```[a-z]*\\s*\\n(.*?)\\n\\s*```\\s*$")

// KeptWorktree resolves a prepared task's saved location. Older reuse records saved only the
// folder's basename; their template directory and branch pattern still come from settings.
func KeptWorktree(p home.Paths, t home.Object) (*home.WorktreeRecord, error) {
	if kept, ok := t.Get("kept_worktree").(home.Object); ok {
		return &home.WorktreeRecord{Path: kept.S("path"), Branch: kept.S("branch")}, nil
	}
	if !t.B("reuse") {
		return nil, nil
	}
	template, err := p.Worktree(git.Root(t.S("dir")), "{name}")
	if err != nil {
		return nil, err
	}
	path := filepath.Join(filepath.Dir(template), t.S("worktree"))
	prefix, suffix, _ := strings.Cut(filepath.Base(template), "{name}")
	name := strings.TrimSuffix(strings.TrimPrefix(t.S("worktree"), prefix), suffix)
	branch, err := p.Branch(name)
	return &home.WorktreeRecord{Path: path, Branch: branch}, err
}

// fullPrompt is the prompt as given, plus the JSON answer instruction for --json or --schema.
func fullPrompt(t home.Object) string {
	prompt := t.S("prompt")
	if t.Has("schema") && t.Get("schema") != nil {
		prompt += "\n\nAnswer ONLY with JSON matching this JSON Schema, no prose and no code fences:\n" + home.JSON(t.Get("schema"), false)
	} else if t.B("json") {
		prompt += "\n\nAnswer ONLY with JSON, no prose and no code fences."
	}
	return prompt
}
func checkJSON(text string, s any) (any, string) {
	if m := fence.FindStringSubmatch(text); m != nil {
		text = m[1]
	}
	v, e := home.ParseJSON(home.Trim(text))
	if e != nil {
		return nil, "answer was not valid JSON"
	}
	problem, err := schema.Mismatch(v, s, "$")
	if err != nil {
		return nil, err.Error()
	}
	if problem != "" {
		return nil, "answer does not match the schema: " + problem
	}
	return json.RawMessage(home.Trim(text)), ""
}

// Started is the actual working directory and optional worktree reported before the agent runs.
type Started struct {
	Dir      string
	Worktree *git.Worktree
	Task     home.Object
	Name     string
	Notes    []hooks.Note
}

// Run returns one complete result, converting task errors into failed results.
// progress (if not nil) gets the agent's usage and coarse activity while it runs.
// events goes only to the agent, never to hooks or persisted task metadata.
func Run(a *agent.Registry, t home.Object, h *hooks.Hooks, events string, started func(Started), progress func(agent.Progress)) home.Object {
	begin := time.Now()
	dir := t.S("dir")
	var w *git.Worktree
	var files []any
	commits := 0
	diff := false
	m, e := agent.Parse(a.Paths, t.S("model"))
	r := home.Object{}
	if e == nil && t.B("write") && !t.B("worktree") {
		var settings home.Object
		settings, e = a.Paths.ReadSettings()
		if e == nil && settings.B("worktree") {
			e = home.Usage("writes require a worktree; a task hook cannot enable in-place write access")
		}
	}
	if e == nil && t.B("worktree") {
		var kept *home.WorktreeRecord
		kept, e = KeptWorktree(a.Paths, t)
		if e == nil && kept != nil && !t.B("write") {
			if info, err := os.Stat(kept.Path); err != nil || !info.IsDir() {
				e = home.Usage("a read follow-up needs its kept worktree to exist: %s", kept.Path)
			}
		}
		if e == nil {
			w, e = git.Add(a.Paths, dir, t.S("worktree"), kept)
		}
		if e == nil {
			dir = w.Dir
		}
	}
	if e == nil {
		name := a.Name(m, "")
		title := Title(name, t.S("prompt"), t.S("title"), t.B("write"), t.B("worktree"))
		var notes []hooks.Note
		if h != nil {
			title, notes = h.Title(title, nil, "", dir, t)
		}
		started(Started{Dir: dir, Worktree: w, Task: t, Name: name, Notes: notes})
		var before *git.Snapshot
		if t.B("write") {
			before = git.Take(dir)
		}
		runTask := t.Clone()
		runTask.Set("dir", dir)
		runTask.Set("title", title)
		r = a.Run(m, fullPrompt(t), runTask, events, progress)
		if before != nil {
			files, commits = git.Changes(before)
			diff = true
		}
		if r.B("ok") && (t.B("json") || (t.Has("schema") && t.Get("schema") != nil)) {
			answer, problem := checkJSON(r.S("text"), t.Get("schema"))
			if problem != "" {
				r.Set("ok", false)
				r.Set("note", problem)
				r.Set("raw_answer", r.S("text"))
			} else {
				r.Set("answer", answer)
			}
		} else if r.B("ok") {
			r.Set("answer", home.TrimEnd(r.S("text")))
		}

	}
	if e != nil {
		r.Set("ok", false)
		r.Set("note", e.Error())
	}
	name := t.S("model")
	if m.Agent != "" {
		name = a.Name(m, r.S("name"))
	}
	out := home.O("id", t.Get("id"), "model", t.Get("model"), "write", t.B("write"), "name", name, "ok", r.B("ok"))
	if r.B("ok") {
		out.Set("answer", r.Get("answer"))
		if r.B("note") {
			out.Set("note", r.Get("note"))
		}
	} else {
		out.Set("error", r.Get("note"))
		if r.Has("raw_answer") {
			out.Set("raw_answer", r.Get("raw_answer"))
		}
	}
	out.Set("seconds", home.Number(home.Fixed(float64(time.Since(begin).Milliseconds())/1000, 1)))
	out.Set("usage", r.Get("usage"))
	session := r.Get("session")
	if !home.Truth(session) {
		session = nil
	}
	out.Set("session", session)
	out.Set("dir", dir)
	if diff {
		out.Set("changes", files)
		out.Set("commits", commits)
	}
	if w != nil {
		out.Set("worktree", home.O("path", w.Path, "branch", w.Branch))
	}
	return out
}
