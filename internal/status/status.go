// Package status formats the status lines and recent-run table shared by CLI commands.
package status

import (
	"fmt"
	"math"
	"os"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/runs"
)

// Duration prints subminute time in seconds and longer time as a compact clock.
func Duration(seconds float64) string {
	if seconds < 60 {
		return home.Fixed(seconds, 1) + "s"
	}
	n := int(math.Round(seconds))
	if n < 3600 {
		return fmt.Sprintf("%d:%02d", n/60, n%60)
	}
	return fmt.Sprintf("%d:%02d:%02d", n/3600, (n/60)%60, n%60)
}

// Clock prints live elapsed time as minutes and seconds.
func Clock(d time.Duration) string {
	n := int(d.Seconds())
	if n < 0 {
		n = 0
	}
	if n < 3600 {
		return fmt.Sprintf("%d:%02d", n/60, n%60)
	}
	return fmt.Sprintf("%d:%02d:%02d", n/3600, (n/60)%60, n%60)
}

// Usage prints token totals and optional cost, omitting empty reports.
func Usage(v any) string {
	u, _ := v.(home.Object)
	if !u.B("input") && !u.B("output") && !u.Has("cost") {
		return ""
	}
	k := func(n float64) string {
		if n >= 1000 {
			return home.Fixed(n/1000, 1) + "k"
		}
		return home.String(n)
	}
	text := k(u.N("input")) + " in · " + k(u.N("output")) + " out"
	if u.Has("cost") {
		digits := 4
		if u.N("cost") >= 0.01 {
			digits = 2
		}
		text += " · $" + home.Fixed(u.N("cost"), digits)
	}
	return text
}

// SafeText replaces control characters in text supplied by agents, hooks and saved records.
func SafeText(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
}

// line joins nonempty status parts using the stable run-prefix format.
func line(ref string, parts ...string) string {
	all := []string{SafeText(ref)}
	for _, p := range parts {
		if p != "" {
			all = append(all, SafeText(p))
		}
	}
	return "ask " + strings.Join(all, " · ")
}

// Plural formats a count with its noun, like "1 file" or "3 models".
func Plural(n int, word string) string {
	s := ""
	if n != 1 {
		s = "s"
	}
	return fmt.Sprintf("%d %s%s", n, word, s)
}

// length counts characters for status tables and hook-note limits.
func length(s string) int { return utf8.RuneCountInString(s) }

// clip truncates at a character boundary.
func clip(s string, n int) string {
	units := []rune(s)
	if len(units) <= n {
		return s
	}
	return string(units[:n])
}

// EventLine formats a task start, hook event, or completed result.
func EventLine(r *runs.Run, e runs.Event) string {
	if e.Kind == "done" {
		return Done(e.Result)
	}
	ref := runs.Ref(r, e.Index)
	if e.Kind == "start" {
		t := e.Started.Task
		where := home.Tilde(e.Started.Dir)
		if e.Started.Worktree != nil {
			where = "worktree " + home.Tilde(e.Started.Worktree.Path)
		}
		access := "read"
		if t.B("write") {
			access = "write"
		}
		continues := ""
		if t.B("continues") {
			continues = "follow-up " + t.S("continues")
		}
		text := line(ref, "started", e.Started.Name, access, where, continues)
		for _, note := range e.Started.Notes {
			first, _, _ := strings.Cut(note.Text, "\n")
			first = SafeText(first)
			if length(first) > 100 {
				first = clip(first, 99) + "…"
			}
			text += "\n" + line(ref, "note", "hook "+note.Name, first)
		}
		if e.Started.Worktree != nil && e.Started.Worktree.Dirty {
			text += "\n" + line(ref, "note", "the worktree starts from HEAD; uncommitted changes in "+home.Tilde(t.S("dir"))+" are not in it")
		}
		return text
	}
	first, _, _ := strings.Cut(e.Note.Text, "\n")
	first = SafeText(first)
	if length(first) > 100 {
		first = clip(first, 99) + "…"
	}
	kind := "note"
	if e.Kind == "followup" {
		kind = "follow-up"
	}
	return line(ref, kind, "hook "+e.Note.Name, first)
}

// Done formats a completed result, including its failure reason or successful note.
func Done(r home.Object) string {
	outcome := "failed"
	note := r.S("error")
	if strings.HasPrefix(note, "stopped at the $") && r.B("session") {
		note += "; ask -c " + r.S("run") + " continues it"
	}
	if r.B("ok") {
		outcome = "ok"
		note = r.S("note")
	}
	changed := ""
	if r.Has("changes") {
		a, _ := r.Get("changes").([]any)
		parts := []string{}
		if len(a) > 0 {
			parts = append(parts, Plural(len(a), "file")+" changed")
		}
		if r.N("commits") != 0 {
			parts = append(parts, Plural(int(r.N("commits")), "commit"))
		}
		changed = strings.Join(parts, ", ")
		if changed == "" {
			changed = "no changes"
		}
	}
	branch := ""
	if w, ok := r.Get("worktree").(home.Object); ok {
		branch = "branch " + w.S("branch")
	}
	return line(r.S("run"), outcome, r.S("name"), Duration(r.N("seconds")), changed, branch, Usage(r.Get("usage")), note)
}

// BatchStart prints the batch size and effective parallelism, including resume state.
func BatchStart(r *runs.Run, jobs, todo int) string {
	resume := ""
	if todo < len(r.Tasks) {
		resume = fmt.Sprintf("resuming %d unfinished", todo)
	}
	if jobs > todo {
		jobs = todo
	}
	return line(r.Label(), "started", fmt.Sprintf("batch of %d", len(r.Tasks)), resume, fmt.Sprintf("%d at a time", jobs))
}

// BatchEnd prints outcome counts, elapsed time and summed usage.
func BatchEnd(r *runs.Run, seconds float64) string {
	ok := 0
	all := []any{}
	for _, x := range r.Results {
		if x.B("ok") {
			ok++
		}
		all = append(all, x.Get("usage"))
	}
	return line(r.Label(), fmt.Sprintf("%d/%d ok", ok, len(r.Tasks)), Duration(seconds), Usage(batchUsage(all)))
}

// batchUsage sums a batch's task usage, leaving out cost unless every task that reported usage
// reported its cost, so a partial sum never reads as the batch's total.
func batchUsage(list []any) any {
	sum, _ := runs.AddUsage(list...).(home.Object)
	for _, v := range list {
		if u, ok := v.(home.Object); ok && home.Truth(v) && !u.Has("cost") {
			delete(sum, "cost")
		}
	}
	return sum
}

// BatchSaved reports a recorded batch's result count without inventing elapsed wall time.
func BatchSaved(r *runs.Run) string {
	ok := 0
	for _, result := range r.Results {
		if result.B("ok") {
			ok++
		}
	}
	return line(r.Label(), fmt.Sprintf("%d/%d ok", ok, len(r.Tasks)))
}

// when renders a saved UTC timestamp relative to the caller's local clock.
func when(stamp string, now time.Time) string {
	if len(stamp) < 15 {
		return ""
	}
	date, err := time.Parse("20060102T150405", stamp[:15])
	if err != nil {
		return ""
	}
	date = date.In(now.Location())
	age := now.Sub(date)
	if age < 0 {
		return date.Format("Jan 2 15:04")
	}
	if age < time.Minute {
		return "now"
	}
	if age < time.Hour {
		return fmt.Sprintf("%dm ago", int(age.Minutes()))
	}
	if age < 24*time.Hour && date.Day() == now.Day() {
		return fmt.Sprintf("%dh ago", int(age.Hours()))
	}
	yesterday := now.AddDate(0, 0, -1)
	if date.Year() == yesterday.Year() && date.YearDay() == yesterday.YearDay() {
		return "yesterday " + date.Format("15:04")
	}
	return date.Format("Jan 2 15:04")
}

// Table prints recent runs with relative dates, omitting columns with no values.
func Table(list []*runs.Run, now time.Time, color bool) string {
	headers := []string{"RUN", "ID", "STARTED", "STATUS", "MODEL", "TIME", "TASK"}
	rows := [][]string{}
	for _, r := range list {
		done := []home.Object{}
		okCount := 0
		for _, result := range r.Results {
			if result != nil {
				done = append(done, result)
				if result.B("ok") {
					okCount++
				}
			}
		}
		single := len(r.Tasks) == 1
		state := ""
		switch {
		case runs.Owner(r) != 0:
			state = "running"
		case len(done) < len(r.Tasks):
			state = "stopped"
		case single:
			state = "failed"
			if done[0].B("ok") {
				state = "ok"
			}
		default:
			state = fmt.Sprintf("%d/%d ok", okCount, len(r.Tasks))
		}
		first := r.Tasks[0]
		model := fmt.Sprintf("%d tasks", len(r.Tasks))
		elapsed := ""
		if single {
			model = first.S("model")
			if len(done) > 0 {
				if done[0].B("name") {
					model = done[0].S("name")
				}
				elapsed = Duration(done[0].N("seconds"))
			}
		}
		about, _, _ := strings.Cut(first.S("prompt"), "\n")
		if first.B("continues") {
			about = "↪ " + first.S("continues") + " " + about
		}
		if state == "stopped" {
			about = "resume: ask batch --resume " + r.Label()
		}
		id := "" // a named run's ID reaches it after a follow-up takes over the name
		if r.Name != "" {
			id = r.ID
		}
		rows = append(rows, []string{r.Label(), id, when(r.Created, now), state, model, elapsed, about})
	}
	keep := []int{}
	for col := range headers {
		visible := col == 0 || col == 3 || col == 6
		for _, row := range rows {
			if row[col] != "" {
				visible = true
				break
			}
		}
		if visible {
			keep = append(keep, col)
		}
	}
	widths := make([]int, len(headers))
	for _, col := range keep {
		widths[col] = length(headers[col])
		for _, row := range rows {
			if length(row[col]) > widths[col] {
				widths[col] = length(row[col])
			}
		}
	}
	room := terminalWidth()
	for _, col := range keep[:len(keep)-1] {
		room -= widths[col] + 2
	}
	if room < 8 {
		room = 8
	}
	render := func(row []string, header bool) string {
		parts := []string{}
		for _, col := range keep {
			value := SafeText(row[col])
			if col == 6 && length(value) > room {
				value = clip(value, room-1) + "…"
			}
			if col != 6 {
				value += strings.Repeat(" ", widths[col]-length(value))
			}
			if color && !header && col == 3 {
				value = ColorStatus(value, row[col])
			}
			parts = append(parts, value)
		}
		return strings.TrimRight(strings.Join(parts, "  "), " ")
	}
	out := []string{render(headers, true)}
	for _, row := range rows {
		out = append(out, render(row, false))
	}
	return strings.Join(out, "\n")
}

// CanStyle checks the stream and color environment before adding ANSI to text.
func CanStyle(file *os.File) bool {
	return IsTerminal(file) && os.Getenv("NO_COLOR") == ""
}

// IsTerminal reports whether a stream can display an interactive layout.
func IsTerminal(file *os.File) bool {
	_, _, ok := terminalSize(file)
	return ok && os.Getenv("TERM") != "dumb"
}

// ColorStatus marks successful and failed outcomes without changing visible text.
func ColorStatus(text, status string) string {
	code := ""
	if status == "ok" {
		code = "32"
	}
	if status == "failed" || status == "stopped" {
		code = "31"
	}
	if strings.HasSuffix(status, " ok") {
		code = "32"
	}
	if status == "note" || status == "follow-up" {
		code = "2"
	}
	if code == "" {
		return text
	}
	return "\x1b[" + code + "m" + text + "\x1b[0m"
}

// StyledLine adds color to a status outcome when its output stream supports styling.
func StyledLine(text string, file *os.File) string {
	if !CanStyle(file) {
		return text
	}
	parts := strings.SplitN(text, " · ", 3)
	if len(parts) < 2 {
		return text
	}
	out := parts[0] + " · " + ColorStatus(parts[1], parts[1])
	if len(parts) == 3 {
		out += " · " + parts[2]
	}
	return out
}
