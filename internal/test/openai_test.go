package test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeProvider is an OpenAI Responses endpoint that scripts its answers from the prompt and
// records every request. A model turn with tool calls is scripted by a prompt that starts
// with directives, one per line, before the question:
//
//	call read {"path":"a.txt"}      the model calls a tool; the next turn sees its output
//	answer TEXT                     the model answers with TEXT (default: echo of inputs)
//	fail CODE MESSAGE               the API returns an error
//	slow                            the turn takes two seconds
//
// Each turn consumes the next directive, so a prompt can chain several calls.
type fakeProvider struct {
	t      testing.TB
	server *httptest.Server
	mu     sync.Mutex
	turns  []object
	// outputs remembers tool outputs by call id, so answers can echo them.
	outputs map[string]string
}

func newFakeProvider(t testing.TB) *fakeProvider {
	p := &fakeProvider{t: t, outputs: map[string]string{}}
	p.server = httptest.NewServer(http.HandlerFunc(p.handle))
	t.Cleanup(p.server.Close)
	return p
}

func (p *fakeProvider) URL() string { return p.server.URL + "/v1" }

// requests returns the recorded request bodies.
func (p *fakeProvider) requests() []object {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]object{}, p.turns...)
}

func (p *fakeProvider) handle(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer test-key" {
		http.Error(w, `{"error":{"message":"bad request or key","code":"invalid"}}`, 401)
		return
	}
	body, _ := io.ReadAll(r.Body)
	var req object
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":{"message":"bad json"}}`, 400)
		return
	}
	req["_headers"] = map[string]any{"user-agent": r.Header.Get("User-Agent"), "session": r.Header.Get("x-opencode-session")}
	p.mu.Lock()
	p.turns = append(p.turns, req)
	turn := len(p.turns)
	p.mu.Unlock()
	input, _ := req["input"].([]any)
	prompt := ""
	outputs := []string{}
	calls := 0
	for _, item := range input {
		o, _ := item.(map[string]any)
		switch o["type"] {
		case "message":
			if o["role"] == "user" {
				content, _ := o["content"].([]any)
				for _, c := range content {
					m, _ := c.(map[string]any)
					prompt, _ = m["text"].(string)
				}
			}
		case "function_call_output":
			out, _ := o["output"].(string)
			outputs = append(outputs, out)
		case "function_call":
			calls++
		}
	}
	directives := []string{}
	for _, line := range strings.Split(prompt, "\n") {
		if strings.HasPrefix(line, "call ") || strings.HasPrefix(line, "answer ") || strings.HasPrefix(line, "fail ") || line == "slow" {
			directives = append(directives, line)
		}
	}
	// The directive for this turn is the one after the calls already answered in this
	// conversation; follow-ups reset nothing, so later prompts restart from their own list.
	index := calls
	if index > len(directives) {
		index = len(directives)
	}
	directive := ""
	if index < len(directives) {
		directive = directives[index]
	}
	if directive == "slow" {
		directive = ""
		p.sleep()
	}
	w.Header().Set("Content-Type", "text/event-stream")
	flusher, _ := w.(http.Flusher)
	emit := func(event string, data any) {
		b, _ := json.Marshal(data)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		if flusher != nil {
			flusher.Flush()
		}
	}
	usage := map[string]any{"input_tokens": 100 * turn, "output_tokens": 10, "input_tokens_details": map[string]any{"cached_tokens": 20}}
	switch {
	case strings.HasPrefix(directive, "fail "):
		rest := strings.TrimPrefix(directive, "fail ")
		code, msg, _ := strings.Cut(rest, " ")
		emit("response.failed", map[string]any{"type": "response.failed", "response": map[string]any{"status": "failed", "error": map[string]any{"code": code, "message": msg}}})
	case strings.HasPrefix(directive, "call "):
		rest := strings.TrimPrefix(directive, "call ")
		name, args, _ := strings.Cut(rest, " ")
		if args == "" {
			args = "{}"
		}
		id := fmt.Sprintf("call_%d", turn)
		emit("response.output_item.done", map[string]any{"type": "response.output_item.done", "item": map[string]any{"type": "function_call", "id": "fc_" + id, "call_id": id, "name": name, "arguments": args}})
		emit("response.completed", map[string]any{"type": "response.completed", "response": map[string]any{"status": "completed", "usage": usage}})
	default:
		if strings.Contains(prompt, "reason\n") && len(outputs) == 0 {
			emit("response.output_item.done", map[string]any{"type": "response.output_item.done", "item": map[string]any{"type": "reasoning", "id": fmt.Sprintf("rs_%d", turn), "summary": []any{}}})
		}
		text := strings.TrimPrefix(directive, "answer ")
		if directive == "" {
			text = "echo: " + lastLine(prompt)
			if len(outputs) > 0 {
				text += " | " + strings.Join(outputs, " | ")
			}
		}
		emit("response.output_text.delta", map[string]any{"type": "response.output_text.delta", "delta": text})
		emit("response.output_item.done", map[string]any{"type": "response.output_item.done", "item": map[string]any{"type": "message", "role": "assistant", "content": []map[string]any{{"type": "output_text", "text": text}}}})
		emit("response.completed", map[string]any{"type": "response.completed", "response": map[string]any{"status": "completed", "usage": usage}})
	}
}

func (p *fakeProvider) sleep() { time.Sleep(2 * time.Second) }

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}
