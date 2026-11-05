package cli

import (
	"reflect"
	"testing"
)

// TestShellCommands pins literal quoting, escapes, separators, assignments and redirects.
func TestShellCommands(t *testing.T) {
	cases := []struct {
		input string
		want  [][]string
	}{
		{`cd ~/code/app && VAR='two words' /bin/ask -m fake:x "Fix \"login\"" 2>&1 | tail -20`, [][]string{{"cd", "~/code/app"}, {"VAR=two words", "/bin/ask", "-m", "fake:x", `Fix "login"`}, {"tail", "-20"}}},
		{"ask -m fake:x 'a|b' escaped\\ word; ask 'it'\ntrue || false", [][]string{{"ask", "-m", "fake:x", "a|b", "escaped word"}, {"ask", "it"}, {"true"}, {"false"}}},
		{"A=1 ask -m fake:x \"a\\qb\" \\\n 'c\\d' > out", [][]string{{"A=1", "ask", "-m", "fake:x", `a\qb`, `c\d`}}},
	}
	for _, c := range cases {
		got, _, ok := shellCommands(c.input)
		if !ok || !reflect.DeepEqual(got, c.want) {
			t.Fatalf("%q: got %#v, %v; want %#v", c.input, got, ok, c.want)
		}
	}
	for _, input := range []string{`ask "unfinished`, "ask trailing\\", `ask $(echo hi)`, `ask go >`, `ask go ||`, `ask go <<EOF`} {
		if _, _, ok := shellCommands(input); ok {
			t.Fatalf("accepted %q", input)
		}
	}
}

// TestQuotedDigitsBeforeRedirect keeps a quoted or escaped numeric argument.
func TestQuotedDigitsBeforeRedirect(t *testing.T) {
	for _, input := range []string{`ask -m fake:x '2'>file`, `ask -m fake:x \2>file`} {
		got, _, ok := shellCommands(input)
		if !ok || !reflect.DeepEqual(got, [][]string{{"ask", "-m", "fake:x", "2"}}) {
			t.Fatalf("%q: %v %v", input, got, ok)
		}
	}
}

// TestShellHeredocs reads literal heredoc bodies and stdout files, and refuses unfinished ones.
func TestShellHeredocs(t *testing.T) {
	got, inputs, ok := shellCommands("cd /w && cat > t.json <<'EOF'\n[{\"prompt\": \"$HOME\"}]\nEOF\nask batch t.json")
	if !ok || !reflect.DeepEqual(got, [][]string{{"cd", "/w"}, {"cat"}, {"ask", "batch", "t.json"}}) {
		t.Fatalf("%#v %v", got, ok)
	}
	if inputs[1] != (shellInput{Stdin: "[{\"prompt\": \"$HOME\"}]\n", HasStdin: true, Out: "t.json"}) {
		t.Fatalf("%#v", inputs[1])
	}
	_, inputs, ok = shellCommands("ask batch - <<-END\n\t{\"prompt\": \"a\"}\n\tEND\n")
	if !ok || inputs[0].Stdin != "{\"prompt\": \"a\"}\n" {
		t.Fatalf("%#v %v", inputs, ok)
	}
	_, inputs, ok = shellCommands("ask batch - <<END\n{\"prompt\": \"$x\"}\nEND")
	if !ok || inputs[0].HasStdin {
		t.Fatalf("expanding body kept: %#v %v", inputs, ok)
	}
	for _, input := range []string{"ask batch - <<END\nno end", "ask go <<<word", "cat <<'EOF"} {
		if _, _, ok := shellCommands(input); ok {
			t.Fatalf("accepted %q", input)
		}
	}
}
