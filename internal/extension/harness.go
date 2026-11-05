package extension

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/process"
)

// Listed is a model a harness offers: its id and optional display name.
type Listed struct{ ID, Name string }

// Models asks a harness for its models (NAME models: one id or id<TAB>name per line).
func Models(p config.Paths, name string) ([]Listed, error) {
	executable := Path(p, name)
	if executable == "" {
		return nil, config.Usage("no harness %q; installed: %s", name, strings.Join(Harnesses(p), ", "))
	}
	r := process.Run(executable, []string{"models"}, process.Options{Env: p.Env(nil), Timeout: 10 * time.Second})
	if r.Code != 0 {
		why := process.Reason(r.Stderr)
		if why == "" {
			why = exitText(r)
		}
		return nil, fmt.Errorf("%s: %s", name, why)
	}
	out := []Listed{}
	for _, line := range strings.Split(r.Stdout, "\n") {
		if config.Trim(line) == "" {
			continue
		}
		id, display, _ := strings.Cut(line, "\t")
		out = append(out, Listed{strings.ToLower(config.Trim(id)), config.Trim(display)})
	}
	return out, nil
}

// Options describe one harness run. Session continues an earlier conversation; Events is a
// private JSONL path the harness may append activity to; Progress receives each report.
type Options struct {
	Harness, Model, Effort string
	Write                  bool
	Dir, Prompt            string
	Schema                 json.RawMessage
	Session, Events        string
	Title                  string
	MaxCost                float64
	Timeout                time.Duration
	Stop                   <-chan struct{}
	Progress               func(Report)
}

// Report is the harness's optional metadata file, rewritten whole as it learns more. Pointer
// counts distinguish an omitted metric from a reported zero.
type Report struct {
	Session string   `json:"session"`
	Name    string   `json:"name"`
	Input   *float64 `json:"input"`
	Output  *float64 `json:"output"`
	Cached  *float64 `json:"cached"`
	Cost    *float64 `json:"cost"`
	Note    string   `json:"note"`
}

// Result is the outcome: the answer on success, else why it failed, plus the last report.
type Result struct {
	OK     bool
	Answer string
	Error  string
	Report Report
}

// Run sends the prompt on stdin and reads the report even after failure or timeout. When
// MaxCost is set, ask stops the harness once its reported cost passes it.
func Run(p config.Paths, o Options) Result {
	executable := Path(p, o.Harness)
	if executable == "" {
		return Result{Error: "no harness " + o.Harness}
	}
	work, err := os.MkdirTemp("", "ask-")
	if err != nil {
		return Result{Error: err.Error()}
	}
	defer os.RemoveAll(work)
	access := "read"
	if o.Write {
		access = "write"
	}
	vars := map[string]string{"ASK_MODEL": o.Model, "ASK_EFFORT": o.Effort, "ASK_ACCESS": access, "ASK_REPORT": filepath.Join(work, "report.json")}
	if o.Events != "" {
		vars["ASK_EVENTS"] = o.Events
	}
	if o.Title != "" {
		vars["ASK_TITLE"] = o.Title
	}
	if o.Session != "" {
		vars["ASK_SESSION"] = o.Session
	}
	if len(o.Schema) > 0 {
		vars["ASK_SCHEMA"] = filepath.Join(work, "schema.json")
		if e := os.WriteFile(vars["ASK_SCHEMA"], o.Schema, 0600); e != nil {
			return Result{Error: e.Error()}
		}
	}
	if o.MaxCost > 0 {
		vars["ASK_MAX_COST"] = strconv.FormatFloat(o.MaxCost, 'f', -1, 64)
	}
	done, stop := make(chan struct{}), make(chan struct{})
	watched := make(chan struct{})
	overLimit := false
	var last Report
	go func() {
		defer close(watched)
		tick := time.NewTicker(500 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case <-o.Stop:
				close(stop)
				return
			case <-tick.C:
			}
			if r, ok := read(vars["ASK_REPORT"]); ok {
				last = r
				if o.MaxCost > 0 && r.Cost != nil && *r.Cost > o.MaxCost && !overLimit {
					overLimit = true
					close(stop)
				}
				if o.Progress != nil {
					o.Progress(r)
				}
			}
		}
	}()
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Minute
	}
	r := process.Run(executable, nil, process.Options{Input: o.Prompt, Dir: o.Dir, Env: p.Env(vars), Timeout: timeout, Stop: stop})
	close(done)
	<-watched
	if final, ok := read(vars["ASK_REPORT"]); ok {
		last = final
	}
	out := Result{Report: last}
	switch {
	case r.TimedOut:
		out.Error = "timed out"
	case overLimit:
		out.Error = "stopped at the $" + config.Dollars(o.MaxCost) + " cost limit"
	case r.Code != 0:
		out.Error = process.Reason(r.Stderr)
		if out.Error == "" {
			out.Error = exitText(r)
		}
	case config.Trim(r.Stdout) == "":
		out.Error = "no answer"
	default:
		out.OK = true
		out.Answer = strings.TrimRight(r.Stdout, "\n")
	}
	return out
}

// read parses the report, rejecting counts that are not finite nonnegative numbers.
func read(path string) (Report, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Report{}, false
	}
	var r Report
	if json.Unmarshal(b, &r) != nil {
		return Report{}, false
	}
	for _, n := range []**float64{&r.Input, &r.Output, &r.Cached, &r.Cost} {
		if *n != nil && (**n < 0 || math.IsInf(**n, 0) || math.IsNaN(**n)) {
			*n = nil
		}
	}
	return r, true
}

func exitText(r process.Result) string {
	if r.Signal != 0 {
		return "killed by " + process.SignalName(r.Signal)
	}
	if r.Code < 0 {
		return "could not start"
	}
	return "exit " + strconv.Itoa(r.Code)
}
