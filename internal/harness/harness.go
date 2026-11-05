// Package harness is ask's own agent loop: it sends the conversation to a provider, runs the
// tools the model calls, feeds back their results and stops at a final answer or a limit.
// It records every provider item in the transcript and every visible step as an event.
package harness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/arocomputer/ask/internal/config"
	"github.com/arocomputer/ask/internal/provider"
	"github.com/arocomputer/ask/internal/sessions"
)

// Options describe one run of the loop. Transcript is the conversation so far (empty for a
// new run); Prompt is appended as the user's message. Cost prices accumulated usage, or
// returns nil when prices are unknown; MaxCost stops the loop once cost passes it (0 for no
// limit). Event receives visible activity; Progress receives usage after each model turn.
// Extra are tools extensions add, offered after the built-in ones.
type Options struct {
	Provider     provider.Provider
	Model        string
	Effort       string
	Write        bool
	Dir          string
	Instructions string
	Transcript   []json.RawMessage
	Prompt       string
	Schema       json.RawMessage
	Extra        []Tool
	MaxSteps     int
	MaxCost      float64
	Cost         func(provider.Usage) *float64
	Event        func(sessions.Event)
	Progress     func(provider.Usage, *float64)
}

// Result is the loop's outcome. Transcript holds every item, including the final answer, so
// a follow-up can continue the conversation. Error is empty on success.
type Result struct {
	Answer     string
	Transcript []json.RawMessage
	Usage      provider.Usage
	Cost       *float64
	Steps      int
	Error      string
}

// ErrStopped is the loop's error when ask stops the turn.
var ErrStopped = errors.New("stopped")

// Run executes the loop until the model answers without calling a tool, or a limit ends it.
// The transcript returned is complete up to the last finished model turn, even on failure.
func Run(ctx context.Context, o Options) Result {
	items := append([]json.RawMessage{}, o.Transcript...)
	items = append(items, provider.UserMessage(o.Prompt))
	res := Result{Transcript: items}
	emit := func(e sessions.Event) {
		if o.Event != nil {
			o.Event(e)
		}
	}
	tools := append(Tools(o.Write), o.Extra...)
	offered := make([]provider.Tool, len(tools))
	for i, t := range tools {
		offered[i] = provider.Tool{Name: t.Name, Description: t.Description, Parameters: t.Parameters}
	}
	steps := o.MaxSteps
	if steps <= 0 {
		steps = 100
	}
	for res.Steps = 1; res.Steps <= steps; res.Steps++ {
		req := provider.Request{Model: o.Model, Effort: o.Effort, Instructions: o.Instructions, Input: items, Tools: offered, Schema: o.Schema}
		turn, err := o.Provider.Complete(ctx, req, nil)
		if err != nil {
			if ctx.Err() != nil {
				res.Error = ErrStopped.Error()
			} else {
				res.Error = describe(err)
			}
			return res
		}
		items = append(items, turn.Items...)
		res.Transcript = items
		res.Usage.Add(turn.Usage)
		if o.Cost != nil {
			res.Cost = o.Cost(res.Usage)
		}
		if o.Progress != nil {
			o.Progress(res.Usage, res.Cost)
		}
		if text := config.Trim(turn.Text); text != "" {
			emit(sessions.Event{Type: "message", Text: text})
		}
		if o.MaxCost > 0 && res.Cost != nil && *res.Cost > o.MaxCost {
			res.Error = "stopped at the $" + config.Dollars(o.MaxCost) + " cost limit"
			return res
		}
		if turn.Incomplete != "" {
			res.Error = "the model stopped early (" + turn.Incomplete + ")"
			return res
		}
		if len(turn.Calls) == 0 {
			res.Answer = config.Trim(turn.Text)
			if res.Answer == "" {
				res.Error = "no answer"
			}
			return res
		}
		for _, call := range turn.Calls {
			if ctx.Err() != nil {
				res.Error = ErrStopped.Error()
				return res
			}
			output := run(ctx, tools, o.Dir, call, emit)
			items = append(items, provider.CallOutput(call.ID, output))
			res.Transcript = items
		}
	}
	res.Error = fmt.Sprintf("hit the %d-step limit without answering", steps)
	return res
}

// run executes one tool call and reports it, returning what the model sees.
func run(ctx context.Context, tools []Tool, dir string, call provider.Call, emit func(sessions.Event)) string {
	var args config.Object
	if v, err := config.ParseJSON(call.Arguments); err == nil {
		args, _ = v.(config.Object)
	}
	emit(sessions.Event{Type: "tool", Tool: call.Name, Text: summarize(call.Name, args)})
	var output string
	found := false
	for _, t := range tools {
		if t.Name == call.Name {
			found = true
			if args == nil {
				output = "error: arguments must be a JSON object"
				break
			}
			out, err := t.Run(ctx, dir, args)
			if err != nil {
				output = "error: " + err.Error()
			} else {
				output = out
			}
		}
	}
	if !found {
		output = "error: no tool named " + call.Name
	}
	emit(sessions.Event{Type: "tool_result", Tool: call.Name, Text: clip(output, 2000)})
	return output
}

// summarize describes a call's arguments in one line for the activity record.
func summarize(name string, args config.Object) string {
	switch name {
	case "shell":
		return args.S("command")
	case "grep":
		s := args.S("pattern")
		if p := args.S("path"); p != "" {
			s += " in " + p
		}
		return s
	default:
		if p := args.S("path"); p != "" {
			return p
		}
	}
	return ""
}

// describe turns a provider error into the turn's error text.
func describe(err error) string {
	var e *provider.Error
	if errors.As(err, &e) {
		switch {
		case e.Code == "context_length_exceeded" || strings.Contains(e.Message, "context length"):
			return "the conversation no longer fits the model's context: " + e.Message
		case e.Status == 401:
			return "the provider rejected the credential: " + e.Message
		case e.Status == 429:
			return "the provider is rate limiting or out of quota: " + e.Message
		}
		return e.Error()
	}
	return err.Error()
}
