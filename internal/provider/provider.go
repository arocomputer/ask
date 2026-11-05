// Package provider calls model providers directly. A Provider turns one request (the
// conversation so far plus tools) into one response (new items, text, tool calls and usage).
// It knows nothing about ask's runs; the harness owns the loop.
package provider

import (
	"context"
	"encoding/json"
	"fmt"
)

// Tool is a function the model may call, with a JSON Schema for its arguments.
type Tool struct {
	Name        string
	Description string
	Parameters  json.RawMessage
}

// Call is a tool call the model made; Arguments is the JSON text it produced.
type Call struct{ ID, Name, Arguments string }

// Usage counts the tokens of one response. Cached is the part of Input served from cache.
type Usage struct{ Input, Output, Cached int }

// Add accumulates usage across responses.
func (u *Usage) Add(o Usage) { u.Input += o.Input; u.Output += o.Output; u.Cached += o.Cached }

// Request is one model turn: the conversation so far as provider-native items, instructions,
// the tools on offer and an optional schema the final answer must match.
type Request struct {
	Model        string
	Effort       string
	Instructions string
	Input        []json.RawMessage
	Tools        []Tool
	Schema       json.RawMessage
}

// Response is what one turn produced. Items are appended to the conversation verbatim, so
// the provider's own reasoning and message items round-trip. Incomplete names the reason
// when the model stopped before finishing (for example max_output_tokens).
type Response struct {
	Items      []json.RawMessage
	Text       string
	Calls      []Call
	Usage      Usage
	Incomplete string
}

// Provider completes one turn, calling delta with output text as it streams.
type Provider interface {
	Complete(ctx context.Context, req Request, delta func(string)) (Response, error)
}

// Error is a failure the provider reported. Code is its machine name when it gave one.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("%s (%s)", e.Message, e.Code)
	}
	return e.Message
}

// UserMessage builds the input item for text the user sends.
func UserMessage(text string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"type": "message", "role": "user", "content": []map[string]string{{"type": "input_text", "text": text}}})
	return b
}

// CallOutput builds the input item that answers a tool call.
func CallOutput(callID, output string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"type": "function_call_output", "call_id": callID, "output": output})
	return b
}
