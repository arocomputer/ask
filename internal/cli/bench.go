package cli

import (
	"cmp"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/arocomputer/ask/internal/agent"
	"github.com/arocomputer/ask/internal/git"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/process"
	"github.com/arocomputer/ask/internal/runs"
	"github.com/arocomputer/ask/internal/status"
	"github.com/arocomputer/ask/internal/tui"
)

// attempt is one task on one model, one time; check is the task's shell command that passes it.
type attempt struct {
	Task, Model, Check string
	N                  int
}

// bench runs every task of a batch file on every -m model, -n times each, as one run. An attempt
// passes when its agent finishes and the task's "check" exits 0 in the folder it worked in (with
// the answer on stdin). A check is your command, from your bench file, so it runs for read tasks
// too: -r limits what the model can do, and the model only supplies the answer the check reads.
// Write tasks get a fresh worktree each, discarded after its check unless --keep. It prints a
// table per model, or JSON, and saves it as bench.json for ask show.
func bench(a *agent.Registry, opts home.Object, words []string) (int, error) {
	if len(words) != 1 {
		return 0, home.Usage("ask bench takes one file of tasks, like ask bench tasks.json -m claude:sonnet-5.5 -m codex:gpt-6.1-sol")
	}
	models := []string{}
	for _, m := range strings.Split(opts.S("-m"), ",") {
		if m = home.Trim(m); m == "" {
			continue
		}
		spec, e := agent.Parse(a.Paths, m)
		if e != nil {
			return 0, e
		}
		if !slices.Contains(models, spec.Spec) {
			models = append(models, spec.Spec)
		}
	}
	if len(models) == 0 {
		return 0, home.Usage("ask bench needs the models to compare, like -m claude:sonnet-5.5 -m codex:gpt-6.1-sol")
	}
	repeat := 1
	if opts.B("-n") {
		n, e := number("-n", opts.S("-n"), true)
		if e != nil {
			return 0, e
		}
		repeat = integer(n)
	}
	jobs, e := jobCount(a, opts)
	if e != nil {
		return 0, e
	}
	text, e := home.ReadInput(words[0], "tasks")
	if e != nil {
		return 0, e
	}
	items, e := readTasks(text)
	if e != nil {
		return 0, e
	}
	taskOpts := opts.Clone()
	taskOpts.Delete("-m")
	taskOpts.Delete("--json") // a bench's --json is its report; a task asks for JSON with "json"
	defaults, e := taskOptions(taskOpts)
	if e != nil {
		return 0, e
	}
	expanded, attempts := []any{}, []attempt{}
	for i, item := range items {
		t, ok := item.(home.Object)
		if !ok {
			return 0, home.Usage("task %d must be a JSON object", i+1)
		}
		if t.Has("model") {
			return 0, home.Usage("task %d: a bench gives every task every model; drop \"model\" and use -m", i+1)
		}
		check, ok := t.Get("check").(string)
		if t.Has("check") && !ok {
			return 0, home.Usage("task %d: \"check\" must be a shell command, like \"go test ./...\"", i+1)
		}
		write := t.B("write") || (!t.Has("write") && defaults.B("write"))
		id := strconv.Itoa(i + 1)
		if t.Get("id") != nil {
			id = home.String(t.Get("id"))
		}
		for _, m := range models {
			for n := 1; n <= repeat; n++ {
				x := t.Clone()
				x.Delete("check")
				x.Set("id", id)
				x.Set("model", m)
				if write {
					x.Set("worktree", true)
				}
				expanded = append(expanded, x)
				attempts = append(attempts, attempt{Task: id, Model: m, Check: check, N: n})
			}
		}
	}
	if len(expanded) == 0 {
		return 0, home.Usage("%s has no tasks", words[0])
	}
	id := runs.NewID()
	name, notes := runName(a, items, !opts.B("--no-hooks"))
	tasks, e := prepare(a, expanded, defaults, cmp.Or(name, id), false)
	if e != nil {
		return 0, e
	}
	if !opts.B("--yes") && status.IsTerminal(os.Stdin) && status.IsTerminal(os.Stderr) {
		t := &tui.Prompter{In: os.Stdin, Out: os.Stderr, Color: status.CanStyle(os.Stderr), Unicode: status.UTF8(), OnStop: process.OnStop}
		yes, e := t.Confirm(fmt.Sprintf("Run %d attempts (%d tasks × %d models × %d)?", len(tasks), len(items), len(models), repeat), true)
		if e != nil || !yes {
			return 0, e
		}
	}
	r, e := runs.Create(a.Paths, id, name, tasks)
	if e != nil {
		return 0, e
	}
	results, e := execute(a, r, jobs, !opts.B("--no-hooks"), notes)
	if e != nil {
		return 0, e
	}
	scored := score(tasks, results, attempts, jobs, opts.B("--keep"))
	report := home.O("models", table(models, results, scored), "attempts", scored)
	if e := home.WriteJSON(filepath.Join(r.Dir, "bench.json"), report); e != nil {
		return 0, e
	}
	if opts.B("--json") || !status.IsTerminal(os.Stdout) {
		fmt.Fprintln(os.Stdout, home.JSON(report, true))
	} else {
		fmt.Fprint(os.Stdout, benchTable(report))
	}
	return 0, nil
}

// score runs each finished attempt's check, jobs at a time, in the folder its agent worked in,
// then discards its worktree unless keep. It returns one record per attempt, in task order.
func score(tasks, results []home.Object, attempts []attempt, jobs int, keep bool) []any {
	out := make([]any, len(attempts))
	limit := make(chan struct{}, jobs)
	var wait sync.WaitGroup
	for i, at := range attempts {
		wait.Add(1)
		go func() {
			defer wait.Done()
			limit <- struct{}{}
			defer func() { <-limit }()
			t, x := tasks[i], results[i]
			rec := home.O("task", at.Task, "model", at.Model, "n", at.N, "ok", x.B("ok"), "passed", false,
				"seconds", x.Get("seconds"), "usage", x.Get("usage"))
			dir := x.S("dir")
			if _, e := os.Stat(dir); e != nil {
				dir = t.S("dir") // an attempt that changed nothing had its worktree removed
			}
			switch {
			case !x.B("ok"):
				rec.Set("note", x.Get("error"))
			case at.Check == "" || process.Stopping():
				rec.Set("passed", at.Check == "")
			default:
				c := process.Run("sh", []string{"-c", at.Check}, process.Options{Input: answerText(t, x), Dir: dir, Timeout: process.Timeout(t.N("timeout"))})
				rec.Set("passed", c.Code == 0)
				if c.Code != 0 {
					rec.Set("note", "check: "+cmp.Or(process.Reason(c.Stderr), lastLine(c.Stdout), "exit "+strconv.Itoa(c.Code)))
				}
			}
			if w, ok := x.Get("worktree").(home.Object); ok && !keep {
				git.Discard(&git.Worktree{Path: w.S("path"), Branch: w.S("branch")})
			} else if ok {
				rec.Set("worktree", w)
			}
			out[i] = rec
		}()
	}
	wait.Wait()
	return out
}

// table sums attempts per model, in -m order: passes, median seconds, input tokens and cost. A
// model whose agent reported no cost for some attempt gets none, never a partial sum.
func table(models []string, results []home.Object, scored []any) []any {
	rows := []any{}
	for _, m := range models {
		row := home.O("model", m, "name", m, "attempts", 0, "passed", 0)
		seconds, input, cost, costed := []float64{}, 0.0, 0.0, true
		for i, x := range scored {
			rec := x.(home.Object)
			if rec.S("model") != m {
				continue
			}
			row.Set("name", cmp.Or(results[i].S("name"), m))
			row.Set("attempts", row.N("attempts")+1)
			if rec.B("passed") {
				row.Set("passed", row.N("passed")+1)
			}
			seconds = append(seconds, rec.N("seconds"))
			u, _ := rec.Get("usage").(home.Object)
			input += u.N("input")
			cost += u.N("cost")
			costed = costed && u.Has("cost")
		}
		slices.Sort(seconds)
		if n := len(seconds); n > 0 {
			row.Set("median_seconds", home.Number(home.Fixed((seconds[(n-1)/2]+seconds[n/2])/2, 1)))
		}
		row.Set("input", input)
		if costed {
			row.Set("cost", home.Number(home.Fixed(cost, 4)))
		}
		rows = append(rows, row)
	}
	return rows
}

// benchTable prints a saved bench report as aligned columns.
func benchTable(report home.Object) string {
	lines := [][]string{{"model", "pass", "median", "tokens in", "cost", "$/pass"}}
	rows, _ := report.Get("models").([]any)
	for _, x := range rows {
		row, _ := x.(home.Object)
		cost, per := "—", "—"
		if row.Has("cost") {
			cost = "$" + home.Dollars(row.N("cost"))
			if row.N("passed") > 0 {
				per = "$" + home.Dollars(row.N("cost")/row.N("passed"))
			}
		}
		tokens := status.Usage(home.O("input", row.N("input")))
		tokens, _, _ = strings.Cut(tokens, " in")
		lines = append(lines, []string{status.SafeText(row.S("name")),
			fmt.Sprintf("%d/%d", int(row.N("passed")), int(row.N("attempts"))),
			status.Duration(row.N("median_seconds")), cmp.Or(tokens, "—"), cost, per})
	}
	widths := make([]int, len(lines[0]))
	for _, l := range lines {
		for c, cell := range l {
			widths[c] = max(widths[c], len([]rune(cell)))
		}
	}
	var b strings.Builder
	for _, l := range lines {
		row := ""
		for c, cell := range l {
			row += cell + strings.Repeat(" ", widths[c]-len([]rune(cell))+3)
		}
		b.WriteString(strings.TrimRight(row, " ") + "\n")
	}
	return b.String()
}

// lastLine is the last nonblank line of text, for a check that explains itself on stdout.
func lastLine(text string) string {
	lines := strings.Split(home.Trim(text), "\n")
	return home.Trim(lines[len(lines)-1])
}
