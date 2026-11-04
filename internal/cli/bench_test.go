package cli

import (
	"strings"
	"testing"

	"github.com/arocomputer/ask/internal/home"
)

func TestBenchOmitsPartialInput(t *testing.T) {
	results := []home.Object{{"name": "Example"}, {"name": "Example"}}
	scored := []any{
		home.O("model", "a", "usage", home.O("input", 10, "cost", 0.1)),
		home.O("model", "a", "usage", home.O("cost", 0.2)),
	}
	rows := table([]string{"a"}, results, scored)
	row := rows[0].(home.Object)
	if row.Has("input") {
		t.Fatalf("partial input presented as total: %v", row)
	}
	if got := benchTable(home.O("models", rows)); !strings.Contains(got, "—") {
		t.Fatalf("missing unknown input: %s", got)
	}
}
