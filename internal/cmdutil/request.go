package cmdutil

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/arocomputer/ask/internal/config"
)

// request is a launch written as one JSON object, the form agents find easier to build than
// flags. Each key stands for the flag of the same name.
type request struct {
	Prompt   *string         `json:"prompt"`
	Session  string          `json:"session"`
	Model    string          `json:"model"`
	Write    bool            `json:"write"`
	Worktree bool            `json:"worktree"`
	Dir      string          `json:"dir"`
	Timeout  *float64        `json:"timeout"`
	MaxCost  *float64        `json:"max_cost"`
	Schema   json.RawMessage `json:"schema"`
	Wait     bool            `json:"wait"`
}

// Request reads stdin text as a JSON request. ok is false when the text is not a JSON object
// with a prompt or session key, so it stays an ordinary prompt. Otherwise args are the flags
// and prompt the request stands for, and session names the session it continues, if any.
func Request(text string) (args []string, session string, ok bool, err error) {
	if !strings.HasPrefix(text, "{") {
		return nil, "", false, nil
	}
	var keys map[string]json.RawMessage
	if json.Unmarshal([]byte(text), &keys) != nil {
		return nil, "", false, nil
	}
	if _, p := keys["prompt"]; !p {
		if _, s := keys["session"]; !s {
			return nil, "", false, nil
		}
	}
	var r request
	d := json.NewDecoder(bytes.NewReader([]byte(text)))
	d.DisallowUnknownFields()
	if err := d.Decode(&r); err != nil {
		return nil, "", true, config.Usage("bad JSON request: %s; see ask help run", strings.TrimPrefix(err.Error(), "json: "))
	}
	prompt := ""
	if r.Prompt != nil {
		prompt = config.Trim(*r.Prompt)
	}
	if prompt == "" && r.Session == "" {
		return nil, "", true, config.Usage("a JSON request needs a prompt")
	}
	if r.Session != "" && (r.Worktree || r.Dir != "") {
		return nil, "", true, config.Usage("a JSON request that continues a session takes no worktree or dir")
	}
	add := func(flag, value string) { args = append(args, flag, value) }
	if r.Model != "" {
		add("--model", r.Model)
	}
	if r.Dir != "" {
		add("--directory", r.Dir)
	}
	if r.Timeout != nil {
		add("--timeout", strconv.FormatFloat(*r.Timeout, 'f', -1, 64))
	}
	if r.MaxCost != nil {
		add("--max-cost", strconv.FormatFloat(*r.MaxCost, 'f', -1, 64))
	}
	if len(r.Schema) > 0 && string(r.Schema) != "null" {
		add("--schema", string(r.Schema))
	}
	if r.Write {
		args = append(args, "--write")
	}
	if r.Worktree {
		args = append(args, "--worktree")
	}
	if r.Wait {
		args = append(args, "--wait")
	}
	if prompt != "" {
		args = append(args, "--", prompt)
	}
	return args, r.Session, true, nil
}
