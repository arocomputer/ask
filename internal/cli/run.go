package cli

import (
	"cmp"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/hooks"
	"github.com/arocomputer/ask/internal/process"
	"github.com/arocomputer/ask/internal/runs"
	"github.com/arocomputer/ask/internal/status"
)

// taskOptions reads the task fields shared by single and batch commands.
func taskOptions(opts home.Object) (home.Object, error) {
	t := home.Object{}
	if opts.B("-m") {
		t.Set("model", opts.Get("-m"))
	}
	if opts.Has("--title") {
		title := strings.Join(strings.Fields(opts.S("--title")), " ")
		if title == "" {
			return nil, home.Usage("--title needs a nonempty title")
		}
		t.Set("title", title)
	}
	if opts.B("-r") || opts.B("-w") {
		t.Set("write", opts.B("-w"))
	}
	if opts.B("--worktree") {
		t.Set("worktree", true)
	}
	if opts.B("--json") {
		t.Set("json", true)
	}
	if opts.B("--schema") {
		text, e := home.ReadInput(opts.S("--schema"), "schema")
		if e != nil {
			return nil, e
		}
		schema, e := home.ParseJSON(text)
		if e != nil {
			return nil, home.Usage("cannot parse schema %s: %s", opts.S("--schema"), e)
		}
		_ = schema
		t.Set("schema", json.RawMessage(text))
	}
	if opts.B("-C") {
		t.Set("dir", opts.Get("-C"))
	}
	if opts.Has("--max-cost") {
		n, e := strconv.ParseFloat(strings.TrimPrefix(opts.S("--max-cost"), "$"), 64)
		if e != nil || n < 0 {
			return nil, home.Usage("--max-cost takes dollars, like 2.50 (0 for no limit), not %q", opts.S("--max-cost"))
		}
		t.Set("max_cost", n)
	}
	if opts.B("-t") {
		n, e := number("-t", opts.S("-t"), false)
		if e != nil {
			return nil, e
		}
		if n > 2000000 {
			return nil, home.Usage("-t needs at most 2000000 seconds, not \"%s\"", opts.S("-t"))
		}
		t.Set("timeout", n)
	}
	return t, nil
}

// readTasks accepts a JSON array or nonblank JSON lines, with source-specific diagnostics.
func readTasks(text string) ([]any, error) {
	trimmed := home.Trim(text)
	if trimmed == "" {
		return nil, home.Usage("no tasks: pass a JSON array or JSON lines in FILE or on stdin")
	}
	decode := func(text, where string) (any, error) {
		v, e := home.ParseJSON(text)
		if e != nil {
			return nil, home.Usage("cannot parse %s: %s", where, e)
		}
		return v, nil
	}
	items := []any{}
	if strings.HasPrefix(trimmed, "[") {
		v, e := decode(trimmed, "the batch")
		if e != nil {
			return nil, e
		}
		items, _ = v.([]any)
	} else {
		for i, line := range strings.Split(text, "\n") {
			line = home.Trim(line)
			if line == "" {
				continue
			}
			v, e := decode(line, fmt.Sprintf("line %d", i+1))
			if e != nil {
				return nil, e
			}
			items = append(items, v)
		}
	}
	if len(items) == 0 {
		return nil, home.Usage("no tasks: the batch is empty")
	}
	return items, nil
}

// prepare validates task fields and resolves follow-ups without starting model processes.
func prepare(a *agent.Registry, items []any, defaults home.Object, label string, single bool) ([]home.Object, error) {
	return runs.Prepare(a.Paths, items, defaults, label, single, func(where string) error {
		return home.Usage("%s needs a model: give -m MODEL, or set \"model\" in ~/.ask/settings.json", where)
	})
}

// runName names a new run before its tasks are prepared, so worktrees and branches carry it:
// a single follow-up takes over its conversation's name; otherwise name hooks may rename the
// first prompt's slug, and a number keeps it apart from earlier runs.
func runName(a *agent.Registry, items []any, hooksOn bool) (string, []hooks.Note) {
	prompts := []string{}
	for _, item := range items {
		t, _ := item.(home.Object)
		prompts = append(prompts, home.String(t.Get("prompt")))
	}
	if len(items) == 1 {
		t, _ := items[0].(home.Object)
		if ref, ok := t.Get("continue").(string); ok {
			if name := runs.Inherit(a.Paths, ref); name != "" {
				return name, nil
			}
		}
	}
	name := runs.Slug(prompts[0])
	var notes []hooks.Note
	if hooksOn {
		dir, _ := os.Getwd()
		var chosen string
		chosen, notes = hooks.New(a.Paths).Name(name, prompts, dir)
		if clean := runs.Clean(chosen); clean != "" && chosen != name {
			name = clean
		}
	}
	return runs.Unique(a.Paths, name), notes
}

// reporter serializes complete status lines from parallel tasks to stderr.
func reporter(a *agent.Registry, r *runs.Run, live *status.Live) func(runs.Event) {
	var mu sync.Mutex
	return func(e runs.Event) {
		mu.Lock()
		defer mu.Unlock()
		if live == nil {
			if e.Kind != "usage" { // plain status lines report usage once, at the end
				fmt.Fprintln(os.Stderr, status.StyledLine(status.EventLine(r, e), os.Stderr))
			}
			return
		}
		name := ""
		if e.Kind == "start" {
			name = e.Started.Name
		}
		live.Update(e, name, status.EventLine(r, e))
	}
}

// answerText prints JSON task values as JSON and ordinary answers as text.
func answerText(t, r home.Object) string {
	if t.B("json") || t.Has("schema") && t.Get("schema") != nil {
		return home.JSON(r.Get("answer"), false)
	}
	answer := r.Get("answer")
	if raw, ok := answer.(json.RawMessage); ok {
		var text string
		if json.Unmarshal(raw, &text) == nil {
			return text
		}
		return string(raw)
	}
	return home.String(answer)
}

// runOne records and executes one prompt, printing only a successful answer.
func runOne(a *agent.Registry, opts home.Object, words []string) (int, error) {
	prompt := strings.Join(words, " ")
	if prompt == "" || prompt == "-" {
		if stdinTerminal() {
			return 0, home.Usage("no prompt: give it as an argument, or pipe it in")
		}
		var e error
		prompt, e = home.ReadInput("-", "prompt")
		if e != nil {
			return 0, e
		}
	}
	t, e := taskOptions(opts)
	if e != nil {
		return 0, e
	}
	t.Set("prompt", prompt)
	if opts.Has("-c") {
		t.Set("continue", opts.Get("-c"))
	}
	id := runs.NewID()
	name, notes := runName(a, []any{t}, !opts.B("--no-hooks"))
	tasks, e := prepare(a, []any{t}, nil, cmp.Or(name, id), true)
	if e != nil {
		return 0, e
	}
	r, e := runs.Create(a.Paths, id, name, tasks)
	if e != nil {
		return 0, e
	}
	live := status.NewLive(r, "", false)
	process.OnStop(func() { live.Finish("ask "+r.Label()+" · stopped", true) })
	defer process.OnStop(nil)
	report := reporter(a, r, live)
	for _, n := range notes {
		report(runs.Event{Kind: "note", Note: n})
	}
	results, e := runs.Execute(a, r, 1, !opts.B("--no-hooks"), report)
	process.AwaitShutdown()
	final := ""
	if e == nil {
		final = status.Done(results[0])
	}
	live.Finish(final, false)
	if e != nil {
		return 0, e
	}
	if !results[0].B("ok") {
		return 1, nil
	}
	fmt.Fprintln(os.Stdout, answerText(tasks[0], results[0]))
	return 0, nil
}

// batch records or resumes tasks and prints all results in task order.
func batch(a *agent.Registry, opts home.Object, words []string) (int, error) {
	jobs, e := jobCount(a, opts)
	if e != nil {
		return 0, e
	}
	var r *runs.Run
	var notes []hooks.Note
	if opts.B("--resume") {
		extra := []string{}
		for key := range opts {
			if !has([]string{"--resume", "-j", "--no-hooks"}, key) {
				extra = append(extra, key)
			}
		}
		extra = append(extra, words...)
		if len(extra) > 0 {
			return 0, home.Usage("--resume reruns a batch as it was recorded; it takes only -j and --no-hooks, not %s", strings.Join(extra, " "))
		}
		r, _, e = runs.Open(a.Paths, opts.S("--resume"))
		if e != nil {
			return 0, e
		}
	} else {
		if len(words) > 1 {
			return 0, home.Usage("ask batch takes one file of tasks, not %d", len(words))
		}
		path := "-"
		if len(words) > 0 && words[0] != "" {
			path = words[0]
		}
		text, e := home.ReadInput(path, "tasks")
		if e != nil {
			return 0, e
		}
		items, e := readTasks(text)
		if e != nil {
			return 0, e
		}
		defaults, e := taskOptions(opts)
		if e != nil {
			return 0, e
		}
		id := runs.NewID()
		var name string
		name, notes = runName(a, items, !opts.B("--no-hooks"))
		tasks, e := prepare(a, items, defaults, cmp.Or(name, id), false)
		if e != nil {
			return 0, e
		}
		r, e = runs.Create(a.Paths, id, name, tasks)
		if e != nil {
			return 0, e
		}
	}
	results, e := execute(a, r, jobs, !opts.B("--no-hooks"), notes)
	if e != nil {
		return 0, e
	}
	fmt.Fprintln(os.Stdout, home.JSON(home.ResultRecords(results), true))
	for _, x := range results {
		if !x.B("ok") {
			return 1, nil
		}
	}
	return 0, nil
}

// jobCount is how many tasks run at once: -j, else the jobs setting, else 4.
func jobCount(a *agent.Registry, opts home.Object) (int, error) {
	jobs := 4
	if settings, e := a.Paths.ReadSettings(); e != nil {
		return 0, e
	} else if settings.Has("jobs") {
		jobs = int(settings.N("jobs"))
	}
	if opts.B("-j") {
		n, e := number("-j", opts.S("-j"), true)
		if e != nil {
			return 0, e
		}
		jobs = integer(n)
	}
	return jobs, nil
}

// execute runs a created run's unfinished tasks with the live rows and status lines a batch
// shows on stderr, and returns every task's result in task order.
func execute(a *agent.Registry, r *runs.Run, jobs int, hooksOn bool, notes []hooks.Note) ([]home.Object, error) {
	todo := 0
	for _, x := range r.Results {
		if !x.B("ok") {
			todo++
		}
	}
	begin := time.Now()
	header := status.BatchStart(r, jobs, todo)
	live := status.NewLive(r, header, true)
	if live == nil {
		fmt.Fprintln(os.Stderr, status.StyledLine(header, os.Stderr))
	}
	process.OnStop(func() { live.Finish("ask "+r.Label()+" · stopped", true) })
	defer process.OnStop(nil)
	report := reporter(a, r, live)
	for _, n := range notes {
		report(runs.Event{Kind: "note", Note: n})
	}
	results, e := runs.Execute(a, r, jobs, hooksOn, report)
	process.AwaitShutdown()
	summary := status.BatchEnd(r, float64(time.Since(begin).Milliseconds())/1000)
	live.Finish(summary, false)
	if e != nil {
		return nil, e
	}
	if live == nil {
		fmt.Fprintln(os.Stderr, status.StyledLine(summary, os.Stderr))
	}
	return results, nil
}
