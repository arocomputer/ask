package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// OpenAI calls the Responses API with streaming and no server-side storage, so the whole
// conversation lives in ask's transcript. Key is a bearer token: an API key, or a token a
// subscription sign-in produced. BaseURL defaults to the public API; gateways such as OpenCode
// serve the same protocol at their own URL. Reasoning asks for encrypted reasoning items so
// they replay across turns, which only OpenAI's own endpoint supports. Session identifies the
// conversation to gateways that route and cache by it.
type OpenAI struct {
	Key       string
	BaseURL   string
	Reasoning bool
	UserAgent string
	Session   string
	Client    *http.Client
}

// Complete sends one turn and reads the event stream until the response completes.
// Transient failures (429 and 5xx) are retried three times with backoff.
func (o *OpenAI) Complete(ctx context.Context, req Request, delta func(string)) (Response, error) {
	body := map[string]any{
		"model":  req.Model,
		"input":  req.Input,
		"stream": true,
		"store":  false,
	}
	if o.Reasoning {
		body["include"] = []string{"reasoning.encrypted_content"}
	}
	if req.Instructions != "" {
		body["instructions"] = req.Instructions
	}
	if req.Effort != "" {
		body["reasoning"] = map[string]string{"effort": req.Effort}
	}
	tools := []map[string]any{}
	for _, t := range req.Tools {
		tools = append(tools, map[string]any{"type": "function", "name": t.Name, "description": t.Description, "parameters": t.Parameters})
	}
	if len(tools) > 0 {
		body["tools"] = tools
	}
	if len(req.Schema) > 0 {
		body["text"] = map[string]any{"format": map[string]any{"type": "json_schema", "name": "answer", "schema": req.Schema}}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return Response{}, err
	}
	client := o.Client
	if client == nil {
		client = &http.Client{}
	}
	base := strings.TrimSuffix(o.BaseURL, "/")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	var last error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return Response{}, ctx.Err()
			case <-time.After(time.Duration(1<<(attempt-1)) * time.Second):
			}
		}
		r, err := http.NewRequestWithContext(ctx, "POST", base+"/responses", bytes.NewReader(payload))
		if err != nil {
			return Response{}, err
		}
		r.Header.Set("Authorization", "Bearer "+o.Key)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "text/event-stream")
		if o.UserAgent != "" {
			r.Header.Set("User-Agent", o.UserAgent)
		}
		if o.Session != "" {
			r.Header.Set("x-opencode-session", o.Session)
		}
		res, err := client.Do(r)
		if err != nil {
			if ctx.Err() != nil {
				return Response{}, ctx.Err()
			}
			last = err
			continue
		}
		if res.StatusCode/100 != 2 {
			b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
			res.Body.Close()
			e := apiError(res.StatusCode, b)
			if res.StatusCode == 429 || res.StatusCode >= 500 {
				last = e
				continue
			}
			return Response{}, e
		}
		out, err := readStream(res.Body, delta, o.Reasoning)
		res.Body.Close()
		if err != nil && ctx.Err() != nil {
			return Response{}, ctx.Err()
		}
		return out, err
	}
	return Response{}, last
}

// apiError decodes {"error": {...}} bodies, falling back to the status.
func apiError(status int, body []byte) error {
	var wrapped struct {
		Error struct {
			Message string `json:"message"`
			Code    string `json:"code"`
			Type    string `json:"type"`
		} `json:"error"`
	}
	e := &Error{Status: status, Message: fmt.Sprintf("HTTP %d", status)}
	if json.Unmarshal(body, &wrapped) == nil && wrapped.Error.Message != "" {
		e.Message = wrapped.Error.Message
		e.Code = wrapped.Error.Code
		if e.Code == "" {
			e.Code = wrapped.Error.Type
		}
	}
	return e
}

// readStream consumes server-sent events. Output items arrive whole in output_item.done;
// text deltas stream separately; usage and the completion status close the response.
// Reasoning items are kept for replay only when the endpoint returns them encrypted
// (reasoning); a gateway's bare reasoning items are dropped, since sending them back fails.
func readStream(body io.Reader, delta func(string), reasoning bool) (Response, error) {
	out := Response{}
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64<<10), 16<<20)
	event, data := "", ""
	done := false
	flush := func() error {
		if data == "" {
			return nil
		}
		defer func() { event, data = "", "" }()
		var v struct {
			Type  string          `json:"type"`
			Delta string          `json:"delta"`
			Item  json.RawMessage `json:"item"`
			Error struct {
				Message string `json:"message"`
				Code    string `json:"code"`
			} `json:"error"`
			Message  string `json:"message"`
			Code     string `json:"code"`
			Response struct {
				Status string `json:"status"`
				Usage  struct {
					Input  int `json:"input_tokens"`
					Output int `json:"output_tokens"`
					Detail struct {
						Cached int `json:"cached_tokens"`
					} `json:"input_tokens_details"`
				} `json:"usage"`
				Incomplete struct {
					Reason string `json:"reason"`
				} `json:"incomplete_details"`
				Error struct {
					Message string `json:"message"`
					Code    string `json:"code"`
				} `json:"error"`
			} `json:"response"`
		}
		if err := json.Unmarshal([]byte(data), &v); err != nil {
			return nil
		}
		kind := v.Type
		if kind == "" {
			kind = event
		}
		switch kind {
		case "response.output_text.delta":
			if delta != nil && v.Delta != "" {
				delta(v.Delta)
			}
		case "response.output_item.done":
			if len(v.Item) == 0 {
				return nil
			}
			var kind struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(v.Item, &kind) == nil && kind.Type == "reasoning" && !reasoning {
				return nil
			}
			out.Items = append(out.Items, v.Item)
			var item struct {
				Type    string `json:"type"`
				CallID  string `json:"call_id"`
				Name    string `json:"name"`
				Args    string `json:"arguments"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			}
			if json.Unmarshal(v.Item, &item) != nil {
				return nil
			}
			switch item.Type {
			case "function_call":
				out.Calls = append(out.Calls, Call{ID: item.CallID, Name: item.Name, Arguments: item.Args})
			case "message":
				for _, c := range item.Content {
					if c.Type == "output_text" {
						out.Text += c.Text
					}
				}
			}
		case "response.completed", "response.incomplete":
			out.Usage = Usage{Input: v.Response.Usage.Input, Output: v.Response.Usage.Output, Cached: v.Response.Usage.Detail.Cached}
			if kind == "response.incomplete" || v.Response.Status == "incomplete" {
				out.Incomplete = v.Response.Incomplete.Reason
				if out.Incomplete == "" {
					out.Incomplete = "incomplete"
				}
			}
			done = true
		case "response.failed":
			done = true
			return &Error{Message: v.Response.Error.Message, Code: v.Response.Error.Code}
		case "error":
			msg, code := v.Message, v.Code
			if msg == "" {
				msg, code = v.Error.Message, v.Error.Code
			}
			if msg == "" {
				msg = "the provider reported an error"
			}
			return &Error{Message: msg, Code: code}
		}
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "":
			if err := flush(); err != nil {
				return out, err
			}
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			d := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if d == "[DONE]" {
				continue
			}
			if data != "" {
				data += "\n"
			}
			data += d
		}
	}
	if err := flush(); err != nil {
		return out, err
	}
	if err := scanner.Err(); err != nil {
		return out, fmt.Errorf("the response stream was interrupted: %w", err)
	}
	if !done {
		return out, &Error{Message: "the response stream ended before the response completed"}
	}
	return out, nil
}
