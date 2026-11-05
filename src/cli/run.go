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

	"github.com/arocomputer/ask/src/agent"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/hooks"
	"github.com/arocomputer/ask/src/process"
	"github.com/arocomputer/ask/src/runs"
	"github.com/arocomputer/ask/src/status"
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

// prepare validates task fields and resolves follow-ups without starting model processes.
func prepare(a *agent.Registry, items []any, defaults home.Object, label string, single bool) ([]home.Object, error) {
	return runs.Prepare(a.Paths, items, defaults, label, single, func(where string) error {
		return home.Usage("%s needs a model: give -m MODEL, or set \"model\" in ~/.ask/settings.json", where)
	})
}

// runName names a new run before its tasks are prepared, so worktrees and branches carry it:
// a single follow-up takes over its conversation's name; otherwise name hooks may rename the
// first prompt's slug. Create chooses any uniqueness suffix under its claim lock. defaults
// are the options a batch applies to tasks that don't set their own, or nil.
func runName(a *agent.Registry, items []any, defaults home.Object, hooksOn bool) (string, []hooks.Note) {
	prompts := []string{}
	worktree := false
	for _, item := range items {
		t, _ := item.(home.Object)
		prompts = append(prompts, home.String(t.Get("prompt")))
		if t.Has("worktree") {
			worktree = worktree || t.B("worktree")
		} else {
			worktree = worktree || defaults.B("worktree")
		}
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
		chosen, notes = hooks.New(a.Paths).Name(name, prompts, worktree, dir)
		if clean := runs.Clean(chosen); clean != "" && chosen != name {
			name = clean
		}
	}
	return name, notes
}

// reporter serializes complete status lines from parallel tasks to stderr.
func reporter(a *agent.Registry, r *runs.Run, live *status.Live) func(runs.Event) {
	var mu sync.Mutex
	activity := map[int]string{}
	shown := map[int]time.Time{}
	return func(e runs.Event) {
		mu.Lock()
		defer mu.Unlock()
		if live == nil {
			if e.Kind == "start" {
				delete(activity, e.Index)
				delete(shown, e.Index)
			}
			if e.Kind == "activity" {
				if e.Activity == "" || e.Activity == activity[e.Index] || time.Since(shown[e.Index]) < 5*time.Second {
					return
				}
				activity[e.Index], shown[e.Index] = e.Activity, time.Now()
			}
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

// runOne reads a prompt and admits detached work, or returns its answer with --wait.
func runOne(a *agent.Registry, opts home.Object, words []string) (int, error) {
	prompt := strings.Join(words, " ")
	// An inherited pipe looks just like intentional context. Read it alongside an argument
	// only when requested, so shell loops and callers holding stdin open remain safe.
	if prompt == "" || prompt == "-" || opts.B("--stdin") {
		if stdinTerminal() {
			if opts.B("--stdin") {
				return 0, home.Usage("--stdin needs piped or redirected input")
			}
			return 0, home.Usage("no prompt: give it as an argument, or pipe it in")
		}
		if opts.S("--schema") == "-" {
			return 0, home.Usage("stdin cannot supply both the prompt and --schema; use a schema file")
		}
		input, e := home.ReadInput("-", "prompt")
		if e != nil {
			return 0, e
		}
		if prompt == "" || prompt == "-" {
			prompt = input
		} else if input != "" {
			prompt += "\n\n" + input
		}
	}
	return runPrompt(a, opts, prompt)
}

// runPrompt records and executes a prompt already read from arguments or stdin.
func runPrompt(a *agent.Registry, opts home.Object, prompt string) (int, error) {
	t, e := taskOptions(opts)
	if e != nil {
		return 0, e
	}
	t.Set("prompt", prompt)
	if opts.Has("-c") {
		t.Set("continue", opts.Get("-c"))
	}
	id := runs.NewID()
	name, notes := runName(a, []any{t}, nil, !opts.B("--no-hooks"))
	tasks, e := prepare(a, []any{t}, nil, cmp.Or(name, id), true)
	if e != nil {
		return 0, e
	}
	if !opts.B("--wait") {
		return startWorker(a.Paths, launchRequest{Name: name, Notes: notes, Tasks: home.TaskRecords(tasks), WorktreeLabel: id, Jobs: 1, Hooks: !opts.B("--no-hooks")})
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
	results, e := runs.Execute(a, r, 1, !opts.B("--no-hooks"), report, nil)
	process.AwaitShutdown()
	final := ""
	if e == nil {
		final = status.Done(results[0])
	}
	live.Finish(final, false)
	if e != nil {
		// An admission failure must not take over the conversation's name with an empty run.
		if results == nil && runs.Owner(r) == 0 {
			if err := runs.Delete(r); err != nil {
				return 0, err
			}
		}
		return 0, e
	}
	if !results[0].B("ok") {
		return 1, nil
	}
	fmt.Fprintln(os.Stdout, answerText(tasks[0], results[0]))
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
func execute(a *agent.Registry, r *runs.Run, jobs int, hooksOn bool, notes []hooks.Note, batch, smart bool, selected ...int) ([]home.Object, error) {
	todo := 0
	for i, x := range r.Results {
		if !x.B("ok") && (len(selected) == 0 || selected[0] == i) {
			todo++
		}
	}
	begin := time.Now()
	header := status.BatchStart(r, jobs, todo)
	var live *status.Live
	if len(selected) == 0 {
		live = status.NewLive(r, header, batch)
	} else {
		batch = false
	}
	if batch && live == nil {
		fmt.Fprintln(os.Stderr, status.StyledLine(header, os.Stderr))
	}
	process.OnStop(func() { live.Finish("ask "+r.Label()+" · stopped", true) })
	defer process.OnStop(nil)
	report := reporter(a, r, live)
	for _, n := range notes {
		report(runs.Event{Kind: "note", Note: n})
	}
	run := runs.Execute
	if smart {
		run = runs.Continue
	}
	results, e := run(a, r, jobs, hooksOn, report, nil, selected...)
	process.AwaitShutdown()
	summary := ""
	if batch {
		summary = status.BatchEnd(r, float64(time.Since(begin).Milliseconds())/1000)
	} else if e == nil && len(results) == 1 {
		summary = status.Done(results[0])
	}
	live.Finish(summary, false)
	if e != nil {
		return results, e
	}
	if batch && live == nil {
		fmt.Fprintln(os.Stderr, status.StyledLine(summary, os.Stderr))
	}
	return results, nil
}
