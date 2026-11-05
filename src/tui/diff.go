package tui

import (
	"fmt"
	"io"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// Change is one file a command is about to change: its text before and after ("" when it doesn't
// exist), or for something that isn't a text file, a Summary line like "install the claude agent".
type Change struct {
	Path, Before, After, Summary string
}

// lines splits text into lines without a trailing empty one.
func lines(text string) []string {
	if text == "" {
		return nil
	}
	return strings.Split(strings.TrimSuffix(text, "\n"), "\n")
}

// Diff returns the lines removed and added between two texts, in order, as "- line" and "+ line",
// keeping the lines both share out (a longest-common-subsequence diff).
func Diff(before, after string) []string {
	a, b := lines(before), lines(after)
	common := make([][]int, len(a)+1)
	for i := range common {
		common[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				common[i][j] = common[i+1][j+1] + 1
			} else {
				common[i][j] = max(common[i+1][j], common[i][j+1])
			}
		}
	}
	out := []string{}
	i, j := 0, 0
	for i < len(a) || j < len(b) {
		switch {
		case i < len(a) && j < len(b) && a[i] == b[j]:
			i, j = i+1, j+1
		case i < len(a) && (j == len(b) || common[i+1][j] >= common[i][j+1]):
			out = append(out, "- "+a[i])
			i++
		default:
			out = append(out, "+ "+b[j])
			j++
		}
	}
	return out
}

// Review prints what changes will do, file by file, width columns wide: each file a grey bar with
// its path and counts after it, like "~/.ask/settings.json  +1 -1", then its lines on a dark red
// background when removed and a dark green one when added, then a git-style total. Without color
// the lines are marked "- " and "+ " instead. A new file longer than a dozen lines shows its size
// rather than its text.
func Review(w io.Writer, changes []Change, color bool, width int) {
	if width < 20 {
		width = 80
	}
	paint := func(code, s string) string {
		if !color {
			return s
		}
		return "\x1b[" + code + "m" + s + "\x1b[0m"
	}
	bar := func(code, text string, visible int) string {
		if !color {
			return text
		}
		return "\x1b[" + code + "m" + text + strings.Repeat(" ", max(width-1-visible, 0)) + "\x1b[0m"
	}
	row := func(added bool, text string) string {
		mark, code := "-", "48;5;52;38;5;224"
		if added {
			mark, code = "+", "48;5;22;38;5;194"
		}
		if !color {
			return mark + " " + text
		}
		text = "  " + text
		text = ansi.Truncate(text, width-1, "…")
		return bar(code, text, lipgloss.Width(text))
	}
	added, removed := 0, 0
	for _, c := range changes {
		plus, minus, body := 0, 0, []string{}
		switch {
		case c.Summary != "" && strings.HasPrefix(c.Summary, "remove"):
			minus++
			body = append(body, row(false, c.Summary))
		case c.Summary != "":
			plus++
			body = append(body, row(true, c.Summary))
		default:
			d := Diff(c.Before, c.After)
			for _, l := range d {
				if strings.HasPrefix(l, "-") {
					minus++
				} else {
					plus++
				}
			}
			if c.Before == "" && len(d) > 12 {
				body = append(body, row(true, fmt.Sprintf("%d new lines", len(d))))
				break
			}
			for _, l := range d {
				body = append(body, row(strings.HasPrefix(l, "+"), l[2:]))
			}
		}
		added, removed = added+plus, removed+minus
		head, visible := c.Path, lipgloss.Width(c.Path)
		if color {
			head, visible = " "+head, visible+1
		}
		const base = "48;5;236"
		on := func(fg, s string) string {
			if !color {
				return s
			}
			return "\x1b[" + base + ";" + fg + "m" + s + "\x1b[0;" + base + ";1m"
		}
		if c.Before == "" && c.After != "" {
			head += on("38;5;245", " new")
			visible += 4
		}
		counts := ""
		if plus > 0 {
			counts += " " + on("38;5;114", fmt.Sprintf("+%d", plus))
			visible += 1 + len(fmt.Sprintf("+%d", plus))
		}
		if minus > 0 {
			counts += " " + on("38;5;210", fmt.Sprintf("-%d", minus))
			visible += 1 + len(fmt.Sprintf("-%d", minus))
		}
		if counts != "" {
			head += " " + counts
			visible++
		}
		if color {
			head = ansi.Truncate(head, width-1, "…")
			visible = lipgloss.Width(head)
		}
		fmt.Fprint(w, bar(base+";1", head, visible), "\n")
		for _, l := range body {
			fmt.Fprint(w, l, "\n")
		}
		fmt.Fprint(w, "\n")
	}
	plural := func(n int, one, many string) string {
		if n == 1 {
			return "1 " + one
		}
		return fmt.Sprintf("%d %s", n, many)
	}
	summary := plural(len(changes), "file changed", "files changed")
	if added > 0 {
		summary += ", " + paint("32", plural(added, "insertion(+)", "insertions(+)"))
	}
	if removed > 0 {
		summary += ", " + paint("31", plural(removed, "deletion(-)", "deletions(-)"))
	}
	fmt.Fprint(w, summary, "\n")
}
