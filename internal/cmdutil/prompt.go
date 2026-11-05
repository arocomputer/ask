package cmdutil

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/sessions"
)

// LaunchFlags are the options run and continue share.
var LaunchFlags = []Flag{
	{"model", "m", true}, {"write", "w", false}, {"timeout", "t", true}, {"max-cost", "", true},
	{"schema", "", true}, {"stdin", "", false}, {"wait", "", false}, {"json", "", false},
}

// Limits applies timeout and cost from options, then config, to a turn.
func Limits(t *sessions.Turn, opts, cfg config.Object) error {
	timeout, err := Number(opts, "timeout", "a number of seconds")
	if err != nil {
		return err
	}
	if timeout == 0 {
		timeout = cfg.N("timeout")
	}
	if timeout == 0 {
		timeout = 900
	}
	t.Timeout = timeout
	cost, err := Number(opts, "max-cost", "dollars, like 2 or 0.5")
	if err != nil {
		return err
	}
	if !opts.Has("max-cost") {
		cost = cfg.N("max_cost")
	}
	t.MaxCost = cost
	return nil
}

// ReadPrompt joins the words, or reads stdin when there are none or the prompt is -.
// With stdin, piped input follows an argument prompt after a blank line.
func ReadPrompt(words []string, stdin bool) (string, error) {
	prompt := config.Trim(strings.Join(words, " "))
	if prompt == "" || prompt == "-" {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return "", config.Usage("cannot read the prompt from stdin: %s", err)
		}
		prompt = config.Trim(config.UTF8(b))
	} else if stdin {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return "", config.Usage("cannot read stdin: %s", err)
		}
		if extra := config.Trim(config.UTF8(b)); extra != "" {
			prompt += "\n\n" + extra
		}
	}
	if prompt == "" {
		return "", config.Usage("give a prompt, as arguments or on stdin")
	}
	return prompt, nil
}

// ReadSchema reads and checks a JSON Schema: inline JSON, a file, or - for stdin.
func ReadSchema(path string) (json.RawMessage, error) {
	text := path
	if !strings.HasPrefix(config.Trim(path), "{") {
		var err error
		if text, err = config.ReadInput(path, "schema"); err != nil {
			return nil, err
		}
	}
	v, err := config.ParseJSON(text)
	if _, ok := v.(config.Object); err != nil || !ok {
		return nil, config.Usage("the schema must be a JSON Schema object")
	}
	return json.RawMessage(config.JSON(v, false)), nil
}

// WorkDir resolves the session's directory to an absolute existing directory.
func WorkDir(dir string) (string, error) {
	if dir == "" {
		wd, err := os.Getwd()
		if err != nil {
			return "", err
		}
		dir = wd
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return "", config.Usage("%s is not a directory", dir)
	}
	return abs, nil
}

// Slug names a worktree after the prompt's first words, or the session ID when they give nothing.
func Slug(prompt, id string) string {
	words := []string{}
	for _, w := range strings.FieldsFunc(strings.ToLower(prompt), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if len(w) < 2 || len(w) > 20 {
			continue
		}
		words = append(words, w)
		if len(words) == 4 {
			break
		}
	}
	if len(words) == 0 {
		return id
	}
	return strings.Join(words, "-")
}
