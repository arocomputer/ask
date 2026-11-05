package sessions

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"

	"github.com/arocomputer/ask/internal/config"
)

// Event is one line of events.jsonl: visible activity as it happens. Type is message (model
// text), tool (a call starting; Tool names it, Text summarizes its input), tool_result (its
// outcome) or status (a lifecycle note). Text is untrusted and may hold sensitive content.
type Event struct {
	Type string `json:"type"`
	Text string `json:"text"`
	Tool string `json:"tool,omitempty"`
}

const (
	eventLineLimit  = 16 * 1024 // including the newline
	eventReadLimit  = 64 * 1024
	eventTailLimit  = 32 * 1024
	eventCountLimit = 100
)

// EventsPath is the session's activity file, kept across turns, created private and empty so an external harness can
// append to it; "" when it cannot be prepared.
func EventsPath(s *Session) string {
	path := filepath.Join(s.Folder, "events.jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return ""
	}
	f.Close()
	return path
}

// Append records one event. Text is clipped to the line limit; failures are ignored, since
// activity must never affect the answer.
func Append(s *Session, e Event) {
	path := EventsPath(s)
	if path == "" {
		return
	}
	e.Text = clean(e.Text)
	e.Tool = clean(e.Tool)
	line := config.JSON(e, false)
	for len(line)+1 > eventLineLimit {
		cut := len(e.Text) - (len(line) + 1 - eventLineLimit) - 1
		if cut < 0 {
			cut = 0
		}
		for cut > 0 && !utf8.RuneStart(e.Text[cut]) {
			cut--
		}
		e.Text = e.Text[:cut] + "…"
		line = config.JSON(e, false)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line + "\n")
}

// clean removes terminal control characters, keeping newlines and tabs.
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
}

// Page is a bounded read of events after a cursor. NextCursor always follows a complete
// line, so a partial tail is read again next time.
type Page struct {
	SessionID  string  `json:"session_id"`
	State      string  `json:"state"`
	Events     []Event `json:"events"`
	NextCursor int64   `json:"next_cursor"`
	HasMore    bool    `json:"has_more"`
}

func parseEvent(line []byte) (Event, bool) {
	if len(line)+1 > eventLineLimit || !utf8.Valid(line) {
		return Event{}, false
	}
	var e Event
	if json.Unmarshal(line, &e) != nil {
		return Event{}, false
	}
	switch e.Type {
	case "message", "tool", "tool_result", "status", "reasoning":
	default:
		return Event{}, false
	}
	e.Text, e.Tool = clean(e.Text), clean(e.Tool)
	return e, true
}

// Events reads events after cursor (a byte offset at zero or just past a newline), or with
// recent the latest bounded window of events regardless of cursor.
func Events(s *Session, cursor int64, recent bool) (Page, error) {
	out := Page{SessionID: s.ID, Events: []Event{}, NextCursor: cursor}
	f, err := os.OpenFile(filepath.Join(s.Folder, "events.jsonl"), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if os.IsNotExist(err) {
		if cursor != 0 {
			return out, config.Usage("activity cursor is out of bounds")
		}
		return out, nil
	}
	if err != nil {
		return out, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return out, err
	}
	if !info.Mode().IsRegular() {
		return out, fmt.Errorf("activity must be a regular file")
	}
	if cursor < 0 || cursor > info.Size() {
		return out, config.Usage("activity cursor is out of bounds")
	}
	if cursor > 0 {
		var prev [1]byte
		if _, err := f.ReadAt(prev[:], cursor-1); err != nil {
			return out, err
		}
		if prev[0] != '\n' {
			return out, config.Usage("activity cursor must follow a complete line")
		}
	}
	limit := eventReadLimit
	if recent {
		limit = eventTailLimit
		cursor = max(0, info.Size()-int64(limit))
	}
	b := make([]byte, min(int64(limit), info.Size()-cursor))
	n, err := f.ReadAt(b, cursor)
	if err != nil && err != io.EOF {
		return out, err
	}
	b = b[:n]
	readEnd := cursor + int64(n)
	if recent && cursor > 0 {
		var prev [1]byte
		if _, err := f.ReadAt(prev[:], cursor-1); err != nil {
			return out, err
		}
		if prev[0] != '\n' {
			// The window may begin inside a record; never parse its suffix as JSON.
			cut := bytes.IndexByte(b, '\n')
			if cut < 0 {
				return out, fmt.Errorf("activity tail exceeds the read limit")
			}
			cursor += int64(cut + 1)
			b = b[cut+1:]
		}
	}
	out.NextCursor = cursor
	lines := 0
	for len(b) > 0 {
		end := bytes.IndexByte(b, '\n')
		if end < 0 {
			break
		}
		if !recent && (lines == eventCountLimit || lines > 0 && out.NextCursor-cursor+int64(end+1) > eventReadLimit-eventLineLimit) {
			out.HasMore = true
			break
		}
		if e, ok := parseEvent(b[:end]); ok {
			out.Events = append(out.Events, e)
			if recent && len(out.Events) > eventCountLimit {
				out.Events = out.Events[1:]
			}
		}
		lines++
		out.NextCursor += int64(end + 1)
		b = b[end+1:]
	}
	if !recent && !out.HasMore && readEnd < info.Size() {
		if out.NextCursor == cursor {
			return out, fmt.Errorf("activity record exceeds the read limit")
		}
		out.HasMore = true
	}
	return out, nil
}
