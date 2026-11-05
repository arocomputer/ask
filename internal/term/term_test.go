package term

import (
	"strings"
	"testing"
)

func TestLines(t *testing.T) {
	t.Run("columns line up when cells carry color and symbols", func(t *testing.T) {
		s := Style{On: true}
		out := Table(s, []string{"state", "model"}, [][]string{{"succeeded", "GLM"}}, func(i int, c string) string {
			if i == 0 {
				return s.Green("✓ " + c)
			}
			return c
		})
		lines := strings.Split(strings.TrimSpace(escape.ReplaceAllString(out, "")), "\n")
		if column(lines[0], "MODEL") != column(lines[1], "GLM") {
			t.Fatalf("header and row disagree:\n%s", strings.Join(lines, "\n"))
		}
	})
	t.Run("a redrawn line is cut to the terminal width with its colors intact", func(t *testing.T) {
		s := Style{On: true}
		line := Fit(s.Orange("⣾")+" "+s.Bold("k3f9a2")+" · GLM 5.3 · 12.0s", 10)
		if Width(line) != 10 || !strings.HasSuffix(line, "…\x1b[0m") {
			t.Fatalf("got %q, %d columns", line, Width(line))
		}
	})
}

// column is where sub starts in line, counted in characters.
func column(line, sub string) int { return len([]rune(line[:strings.Index(line, sub)])) }
