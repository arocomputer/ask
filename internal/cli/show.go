package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/runs"
	"github.com/arocomputer/ask/internal/status"
)

const (
	activityLineLimit   = 16 * 1024 // includes the terminating newline
	activityReadLimit   = 256 * 1024
	activityRecentLimit = 64 * 1024
	activityEventLimit  = 100
)

// activityEvent deliberately decodes only the public activity fields. In particular,
// provider metadata and any private reasoning fields never pass through the viewer.
type activityEvent struct {
	Type string `json:"type"`
	Text string `json:"text"`
	Tool string `json:"tool,omitempty"`
}

// activityPage uses offsets in the original file, even for rejected records. NextCursor
// always follows a complete line; an unfinished tail is retried by every reader.
type activityPage struct {
	RunID      string          `json:"run_id"`
	State      string          `json:"state"`
	Events     []activityEvent `json:"events"`
	NextCursor int64           `json:"next_cursor"`
	HasMore    bool            `json:"has_more"`
}

var activityCredentials = regexp.MustCompile(`(?i)(["']?(?:[a-z0-9_\-]*(?:api[_-]?key|token|password|passwd|secret|credential|authorization))["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)`)
var activityBearer = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[^\s,"';]+`)

// This suppresses obvious credential assignments, not arbitrary secrets in prose.
// Removing controls also makes decoded JSON strings safe to print to a terminal.
func activityText(s string) string {
	s = status.SafeText(s)
	s = activityBearer.ReplaceAllString(s, "${1} [redacted]")
	return activityCredentials.ReplaceAllString(s, "${1}[redacted]")
}

func parseActivity(line []byte) (activityEvent, bool) {
	if len(line)+1 > activityLineLimit || !utf8.Valid(line) {
		return activityEvent{}, false
	}
	var fields map[string]any
	if json.Unmarshal(line, &fields) != nil {
		return activityEvent{}, false
	}
	kind, _ := fields["type"].(string)
	text, ok := fields["text"].(string)
	if !ok {
		return activityEvent{}, false
	}
	switch kind {
	case "message", "reasoning", "tool", "tool_result":
	default:
		return activityEvent{}, false
	}
	e := activityEvent{Type: kind, Text: activityText(text)}
	if value, present := fields["tool"]; present {
		tool, ok := value.(string)
		if !ok {
			return activityEvent{}, false
		}
		e.Tool = activityText(tool)
	}
	return e, true
}

// readActivity does bounded, read-only IO against a regular append-only file. A
// cursor is valid only at zero or immediately after a newline, including at EOF.
// Recent reads discard the first cut line and retain the latest bounded records.
func readActivity(r *runs.Run, index int, cursor int64, recent bool) (activityPage, error) {
	out := activityPage{Events: []activityEvent{}, NextCursor: cursor}
	f, err := os.OpenFile(filepath.Join(r.Dir, fmt.Sprintf("events-%d.jsonl", index)), os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if os.IsNotExist(err) {
		if cursor != 0 {
			return out, home.Usage("activity cursor is out of bounds")
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
		return out, home.Usage("activity cursor is out of bounds")
	}
	if cursor > 0 {
		var prev [1]byte
		if _, err := f.ReadAt(prev[:], cursor-1); err != nil {
			return out, err
		}
		if prev[0] != '\n' {
			return out, home.Usage("activity cursor must follow a complete line")
		}
	}
	limit := activityReadLimit
	if recent {
		limit = activityRecentLimit
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
		// The window may begin inside a record; never parse its suffix as JSON.
		cut := bytes.IndexByte(b, '\n')
		if cut < 0 {
			return out, fmt.Errorf("activity tail exceeds the read limit")
		}
		cursor += int64(cut + 1)
		b = b[cut+1:]
	}
	out.NextCursor = cursor
	lines := 0
	for len(b) > 0 {
		end := bytes.IndexByte(b, '\n')
		if end < 0 {
			break
		}
		// Leave one legal record of lookahead so a partial tail alone does not
		// advertise another page when this read reaches its byte budget.
		if !recent && (lines == activityEventLimit || lines > 0 && out.NextCursor-cursor+int64(end+1) > activityReadLimit-activityLineLimit) {
			out.HasMore = true
			break
		}
		if e, ok := parseActivity(b[:end]); ok {
			out.Events = append(out.Events, e)
			if recent && len(out.Events) > activityEventLimit {
				out.Events = out.Events[1:]
			}
		}
		lines++
		out.NextCursor += int64(end + 1)
		b = b[end+1:]
	}
	if !recent && !out.HasMore && readEnd < info.Size() {
		// Data outside this bounded window may contain another complete line.
		// Refuse a malformed record that cannot be crossed within one window.
		if out.NextCursor == cursor {
			return out, fmt.Errorf("activity record exceeds the read limit")
		}
		out.HasMore = true
	}
	return out, nil
}

func showAfter(p home.Paths, r *runs.Run, index int, raw string) (int, error) {
	if index < 0 {
		return 0, home.Usage("--after needs one task; use ask show RUN/TASK --after CURSOR")
	}
	cursor, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || cursor < 0 || raw == "" || strings.IndexFunc(raw, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
		return 0, home.Usage("--after needs a nonnegative byte offset")
	}
	fresh, record, err := runSnapshot(p, r)
	if err != nil {
		return 0, err
	}
	out, err := readActivity(fresh, index, cursor, false)
	if err != nil {
		return 0, err
	}
	out.RunID, out.State = fresh.ID, record.Tasks[index].State
	fmt.Fprintln(os.Stdout, home.JSON(out, false))
	return 0, nil
}

func printActivity(events []activityEvent) {
	for _, e := range events {
		label := e.Type
		if e.Tool != "" {
			label += " " + e.Tool
		}
		fmt.Fprintf(os.Stderr, "%s: %s\n", label, e.Text)
	}
}

// showActivity never starts an agent or registers worker cleanup. The normal CLI
// signal handler can interrupt this reader without touching the run's owner.
func showActivity(p home.Paths, r *runs.Run, index int, ref string, follow bool) (int, error) {
	cursor := int64(0)
	first := true
	lastStatus := ""
	for {
		fresh, record, err := runSnapshot(p, r)
		if err != nil {
			return 0, err
		}
		r = fresh
		state := record.State
		if index >= 0 {
			state = record.Tasks[index].State
		}
		line := "ask " + status.SafeText(ref) + " · " + state
		if index >= 0 {
			if activity := runs.Activities(r)[index]; state == "running" && activity != "" {
				line += " · " + activity
			}
		} else {
			for i, task := range record.Tasks[:min(len(record.Tasks), activityEventLimit)] {
				id := r.Tasks[i].S("id")
				if len(id) > 200 {
					id = home.UTF8([]byte(id[:200])) + "…"
				}
				line += "\n  " + status.SafeText(id) + " · " + task.State
			}
			if len(record.Tasks) > activityEventLimit {
				line += "\n  … use RUN/TASK to inspect a task"
			}
		}
		more := false
		if index >= 0 {
			page, err := readActivity(r, index, cursor, first)
			if err != nil {
				return 0, err
			}
			printActivity(page.Events)
			cursor, more = page.NextCursor, page.HasMore
		}
		if state != "running" && !more {
			if state == "stopped" {
				fmt.Fprintln(os.Stderr, line+" · continue: ask continue "+status.SafeText(ref))
				return 1, nil
			}
			return showRun(r, home.Object{}, ref, index)
		}
		if line != lastStatus {
			fmt.Fprintln(os.Stderr, line)
			lastStatus = line
		}
		if !follow {
			return 0, nil
		}
		first = false
		if !more {
			time.Sleep(250 * time.Millisecond)
		}
	}
}
