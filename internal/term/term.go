// Package term formats what people see on a terminal: status lines, the sessions table and
// help, with color and symbols only where the output is a terminal.
package term

import (
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
	"unsafe"

	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/sessions"
)

// Style says whether a stream gets color and symbols: it does when it is a terminal, NO_COLOR
// is unset and TERM is not dumb. Piped output stays plain, so scripts see stable text.
type Style struct{ On bool }

// Styled inspects a stream once.
func Styled(f *os.File) Style {
	if os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb" {
		return Style{}
	}
	info, err := f.Stat()
	return Style{err == nil && info.Mode()&os.ModeCharDevice != 0}
}

func (s Style) wrap(code, t string) string {
	if !s.On || t == "" {
		return t
	}
	return "\x1b[" + code + "m" + t + "\x1b[0m"
}

// Bold, Dim, Green, Red, Yellow and Cyan apply the eight-color ANSI styles terminals honor;
// Orange, ask's own color, is from the 256-color palette.
func (s Style) Orange(t string) string { return s.wrap("38;5;208", t) }
func (s Style) Bold(t string) string   { return s.wrap("1", t) }
func (s Style) Dim(t string) string    { return s.wrap("2", t) }
func (s Style) Green(t string) string  { return s.wrap("32", t) }
func (s Style) Red(t string) string    { return s.wrap("31", t) }
func (s Style) Yellow(t string) string { return s.wrap("33", t) }
func (s Style) Cyan(t string) string   { return s.wrap("36", t) }

// Spinner is the running symbol's frames, dots chasing round a square; a still line shows the first.
var Spinner = []string{"⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"}

// Symbol is a state's colored symbol; frame picks the spinner frame for a running one.
func (s Style) Symbol(state string, frame int) string {
	switch state {
	case "succeeded":
		return s.Green("✓")
	case "failed":
		return s.Red("✗")
	case "stopped":
		return s.Dim("-")
	case "running":
		return s.Orange(Spinner[frame%len(Spinner)])
	}
	return state
}

// State colors a lifecycle state and, on a terminal, prefixes its symbol.
func (s Style) State(state string) string {
	if !s.On {
		return state
	}
	sym := s.Symbol(state, 0)
	switch state {
	case "succeeded":
		return s.Green("✓ " + state)
	case "failed":
		return s.Red("✗ " + state)
	case "stopped":
		return s.Dim("- " + state)
	case "running":
		return sym + " " + s.Orange(state)
	}
	return state
}

// Duration prints subminute time in seconds and longer time as a compact clock.
func Duration(seconds float64) string {
	if seconds < 60 {
		return config.Fixed(seconds, 1) + "s"
	}
	n := int(math.Round(seconds))
	if n < 3600 {
		return fmt.Sprintf("%d:%02d", n/60, n%60)
	}
	return fmt.Sprintf("%d:%02d:%02d", n/3600, (n/60)%60, n%60)
}

// Usage prints token counts and cost, omitting what is unknown.
func Usage(u *sessions.Usage) string {
	if u == nil {
		return ""
	}
	k := func(n int) string {
		if n >= 1000 {
			return config.Fixed(float64(n)/1000, 1) + "k"
		}
		return fmt.Sprint(n)
	}
	parts := []string{k(u.Input) + " in", k(u.Output) + " out"}
	if u.Cached > 0 {
		parts = append(parts, k(u.Cached)+" cached")
	}
	if u.Cost != nil {
		digits := 4
		if *u.Cost >= 0.01 {
			digits = 2
		}
		parts = append(parts, "$"+config.Fixed(*u.Cost, digits))
	}
	return strings.Join(parts, " · ")
}

// Safe replaces control characters in text that came from a model, an agent or a record.
func Safe(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
}

// Line is a session's status line, for its latest turn. Piped:
// "ask ID · state · model · time · changes · usage · error", plain and stable for scripts.
// On a terminal it starts with the state's symbol and a bold ID, and dims the details.
func Line(ses *sessions.Session, s Style) string { return Spinning(ses, s, 0) }

// Spinning is Line with the running symbol at a given spinner frame, for a line redrawn in place.
func Spinning(ses *sessions.Session, s Style, frame int) string {
	state := ses.State()
	t := ses.Turn()
	parts := []string{}
	if name := TurnModel(t); name != "" {
		parts = append(parts, name)
	}
	if n := len(ses.Turns); n > 1 {
		parts = append(parts, fmt.Sprintf("turn %d", n))
	}
	if t.Write {
		parts = append(parts, "write")
	}
	if ses.Worktree != nil {
		parts = append(parts, "worktree "+config.Tilde(ses.Worktree.Path))
	}
	details := []string{}
	switch state {
	case "running":
		if at, e := time.Parse(time.RFC3339, t.Started); e == nil {
			details = append(details, Duration(time.Since(at).Seconds()))
		}
	default:
		if t.Seconds > 0 {
			details = append(details, Duration(t.Seconds))
		}
	}
	if n := len(t.Changes); n > 0 {
		c := fmt.Sprintf("%d file", n)
		if n != 1 {
			c += "s"
		}
		c += " changed"
		if t.Commits > 0 {
			c += fmt.Sprintf(", %d commit", t.Commits)
			if t.Commits != 1 {
				c += "s"
			}
		}
		details = append(details, c)
	}
	if u := Usage(t.Usage); u != "" {
		details = append(details, u)
	}
	failure := ""
	if t.Error != "" && state == "failed" {
		failure = Safe(t.Error)
	}
	for i := range parts {
		parts[i] = Safe(parts[i])
	}
	if !s.On {
		all := append([]string{"ask " + ses.ID, state}, parts...)
		all = append(all, details...)
		if failure != "" {
			all = append(all, failure)
		}
		return strings.Join(all, " · ")
	}
	// The symbol says the state, except stopped, whose dash alone says little.
	if state == "stopped" {
		parts = append([]string{"stopped"}, parts...)
	}
	line := s.Symbol(state, frame) + " " + s.Bold(ses.ID)
	if len(parts) > 0 {
		line += " · " + strings.Join(parts, " · ")
	}
	if len(details) > 0 {
		line += s.Dim(" · " + strings.Join(details, " · "))
	}
	if failure != "" {
		line += " · " + s.Red(failure)
	}
	return line
}

// TurnModel is a turn's model for people: its recorded display name, else its spec rendered.
func TurnModel(t *sessions.Turn) string {
	if t.Name != "" || t.Model == "" {
		return t.Name
	}
	return ModelName(t.Model)
}

// ModelName renders a model spec for people: the id after the provider, title-cased.
func ModelName(spec string) string {
	_, id, _ := strings.Cut(spec, ":")
	if id == "" {
		id = spec
	}
	id, _, _ = strings.Cut(id, "#")
	if i := strings.LastIndex(id, "/"); i >= 0 {
		id = id[i+1:]
	}
	words := strings.Split(id, "-")
	for i, w := range words {
		if w == "" {
			continue
		}
		r := []rune(w)
		if strings.HasPrefix(w, "gpt") || strings.HasPrefix(w, "glm") {
			r = []rune(strings.ToUpper(w))
		} else {
			r[0] = unicode.ToUpper(r[0])
		}
		words[i] = string(r)
	}
	return strings.Join(words, " ")
}

// Ago prints how long ago a timestamp was, compactly.
func Ago(stamp string) string {
	t, e := time.Parse(time.RFC3339, stamp)
	if e != nil {
		return ""
	}
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 14*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
	return t.Local().Format("Jan 2")
}

// Table renders rows for a terminal as aligned columns under an uppercase dimmed header, and
// for a pipe as tab-separated lines with no header: cut-friendly and untruncated.
// cell may color a cell by column for the terminal; it gets the plain text and returns styled.
func Table(s Style, header []string, rows [][]string, cell func(column int, text string) string) string {
	var b strings.Builder
	if !s.On {
		for _, row := range rows {
			b.WriteString(strings.Join(row, "\t") + "\n")
		}
		return b.String()
	}
	drawn := [][]string{}
	head := []string{}
	for _, c := range header {
		head = append(head, s.Dim(strings.ToUpper(c)))
	}
	drawn = append(drawn, head)
	for _, row := range rows {
		cells := []string{}
		for i, c := range row {
			cells = append(cells, cell(i, c))
		}
		drawn = append(drawn, cells)
	}
	widths := make([]int, len(header))
	for _, row := range drawn {
		for i, c := range row {
			widths[i] = max(widths[i], Width(c))
		}
	}
	for _, row := range drawn {
		parts := []string{}
		for i, c := range row {
			pad := ""
			if i < len(row)-1 {
				pad = strings.Repeat(" ", widths[i]-Width(c))
			}
			parts = append(parts, c+pad)
		}
		b.WriteString(strings.TrimRight(strings.Join(parts, "  "), " ") + "\n")
	}
	return b.String()
}

var escape = regexp.MustCompile("\x1b\\[[0-9;]*m")

// Width is how many columns text takes on a terminal: its characters without color codes.
func Width(text string) int { return len([]rune(escape.ReplaceAllString(text, ""))) }

// Success is a confirmation line: a green check, then what happened.
func (s Style) Success(text string) string {
	if !s.On {
		return text
	}
	return s.Green("✓") + " " + text
}

// Columns is how wide the terminal behind f is: what it reports, else $COLUMNS, else 80.
func Columns(f *os.File) int {
	var size struct{ Rows, Cols, X, Y uint16 }
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), syscall.TIOCGWINSZ, uintptr(unsafe.Pointer(&size))); e == 0 && size.Cols > 0 {
		return int(size.Cols)
	}
	if n, err := strconv.Atoi(os.Getenv("COLUMNS")); err == nil && n > 0 {
		return n
	}
	return 80
}

// Fit cuts a styled line to n columns, keeping its color codes, so a line redrawn in place
// never wraps.
func Fit(line string, n int) string {
	if Width(line) <= n {
		return line
	}
	var b strings.Builder
	seen := 0
	for i := 0; i < len(line); {
		if loc := escape.FindStringIndex(line[i:]); loc != nil && loc[0] == 0 {
			b.WriteString(line[i : i+loc[1]])
			i += loc[1]
			continue
		}
		r, size := utf8.DecodeRuneInString(line[i:])
		if seen < n-1 {
			b.WriteRune(r)
			seen++
		}
		i += size
	}
	return b.String() + "…\x1b[0m"
}
