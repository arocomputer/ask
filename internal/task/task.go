// Package task runs one task, including worktrees, prompts, git changes and JSON checks.
package task

import (
	"encoding/json"
	"regexp"
	"time"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/git"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/hooks"
	"github.com/arocomputer/ask/internal/schema"
)

var fence = regexp.MustCompile("(?is)^\\s*```[a-z]*\\s*\\n(.*?)\\n\\s*```\\s*$")

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
// progress (if not nil) gets the agent's usage so far while it runs.
func Run(a *agent.Registry, t home.Object, h *hooks.Hooks, started func(Started), progress func(home.Object)) home.Object {
	begin := time.Now()
	dir := t.S("dir")
	var w *git.Worktree
	var files []any
	commits := 0
	diff := false
	m, e := agent.Parse(a.Paths, t.S("model"))
	r := home.Object{}
	if e == nil && t.B("worktree") {
		w, e = git.Add(a.Paths, dir, t.S("worktree"), t.B("reuse"))
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
		r = a.Run(m, fullPrompt(t), runTask, progress)
		if before != nil {
			files, commits = git.Changes(before)
			diff = true
		}
		if r.B("ok") && (t.B("json") || (t.Has("schema") && t.Get("schema") != nil)) {
			answer, problem := checkJSON(r.S("text"), t.Get("schema"))
			if problem != "" {
				r.Set("ok", false)
				r.Set("note", problem)
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
