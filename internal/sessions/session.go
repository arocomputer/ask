// Package sessions records sessions under ~/.ask/agent/sessions: one folder and one ID per
// conversation, holding session.json with every turn, the native transcript, visible activity
// across turns, and the lock the worker holds while a turn runs.
package sessions

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/arocomputer/ask/internal/config"
)

// Usage holds token counts and the cost in USD when known. A nil Cost means unknown.
type Usage struct {
	Input  int      `json:"input"`
	Output int      `json:"output"`
	Cached int      `json:"cached,omitempty"`
	Cost   *float64 `json:"cost,omitempty"`
}

// Change describes a file a write turn changed.
type Change struct {
	Path   string `json:"path"`
	Change string `json:"change"`
}

// Worktree identifies the branch and checkout a write session works in.
type Worktree struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
}

// Turn is one prompt in a session and its outcome. State is running, succeeded, failed or
// stopped; a running turn whose lock nobody holds was interrupted (see Session.State).
type Turn struct {
	Prompt   string          `json:"prompt"`
	Model    string          `json:"model"`
	Effort   string          `json:"effort,omitempty"`
	Write    bool            `json:"write"`
	Schema   json.RawMessage `json:"schema,omitempty"`
	Timeout  float64         `json:"timeout"`
	MaxCost  float64         `json:"max_cost,omitempty"`
	State    string          `json:"state"`
	Started  string          `json:"started"`
	Finished string          `json:"finished,omitempty"`
	Seconds  float64         `json:"seconds,omitempty"`
	Name     string          `json:"name,omitempty"`
	Usage    *Usage          `json:"usage,omitempty"`
	Answer   string          `json:"answer,omitempty"`
	Error    string          `json:"error,omitempty"`
	Changes  []Change        `json:"changes,omitempty"`
	Commits  int             `json:"commits,omitempty"`
}

// Record is session.json. Dir is where the session works; Origin is where ask was run, which
// decides which repository lists it. HarnessSession is an external harness's own session ID,
// which a follow-up resumes. Turns always has at least one turn.
type Record struct {
	ID             string    `json:"id"`
	Created        string    `json:"created"`
	Parent         string    `json:"parent,omitempty"`
	Dir            string    `json:"dir"`
	Origin         string    `json:"origin"`
	Worktree       *Worktree `json:"worktree,omitempty"`
	HarnessSession string    `json:"harness_session,omitempty"`
	Turns          []Turn    `json:"turns"`
}

// Session is a record and the folder it lives in.
type Session struct {
	Folder string
	Record
}

// NewID returns six lowercase letters and digits.
func NewID() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, 6)
	for i := range b {
		var v [1]byte
		for {
			_, _ = rand.Read(v[:])
			if v[0] < 252 {
				break
			}
		}
		b[i] = alphabet[int(v[0])%36]
	}
	return string(b)
}

// Now is the timestamp records use: UTC, to the millisecond, so sessions started within one
// second still list in order.
func Now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00") }

// Parent identifies the conversation that is calling ask: ASK_PARENT, else the session
// variable Claude Code or Codex sets for the commands they run, else "" (unknown).
func Parent() string {
	if p := os.Getenv("ASK_PARENT"); p != "" {
		return p
	}
	if s := os.Getenv("CLAUDE_CODE_SESSION_ID"); s != "" {
		return "claude-code:" + s
	}
	if s := os.Getenv("CODEX_THREAD_ID"); s != "" {
		return "codex:" + s
	}
	return ""
}

// Create makes the session's folder (mode 0700) with its first turn, marked running.
func Create(p config.Paths, rec Record) (*Session, error) {
	if len(rec.Turns) != 1 {
		return nil, errors.New("a new session has exactly one turn")
	}
	rec.ID, rec.Created = NewID(), Now()
	rec.Turns[0].State, rec.Turns[0].Started = "running", rec.Created
	if e := os.MkdirAll(p.Sessions, 0700); e != nil {
		return nil, e
	}
	stamp := strings.NewReplacer("-", "", ":", "", ".", "", "Z", "").Replace(rec.Created)
	s := &Session{Folder: filepath.Join(p.Sessions, stamp+"-"+rec.ID), Record: rec}
	if e := os.Mkdir(s.Folder, 0700); e != nil {
		return nil, e
	}
	return s, s.Save()
}

// AddTurn appends a turn, marked running, and saves. The caller holds no lock: the worker
// takes it; a session whose latest turn is running cannot take another.
func (s *Session) AddTurn(t Turn) error {
	t.State, t.Started = "running", Now()
	s.Turns = append(s.Turns, t)
	return s.Save()
}

// DropTurn removes the latest turn, for a turn whose worker never started.
func (s *Session) DropTurn() error {
	if len(s.Turns) < 2 {
		return errors.New("a session keeps its first turn")
	}
	s.Turns = s.Turns[:len(s.Turns)-1]
	return s.Save()
}

// Turn is the latest turn.
func (s *Session) Turn() *Turn { return &s.Turns[len(s.Turns)-1] }

// State is the latest turn's effective state: a turn still marked running whose lock no
// process holds was interrupted, so it is stopped.
func (s *Session) State() string {
	t := s.Turn()
	if t.State == "running" && Owner(s) == 0 {
		return "stopped"
	}
	return t.State
}

// Updated is when the session last did something: its latest turn's start.
func (s *Session) Updated() string { return s.Turn().Started }

// Save rewrites session.json atomically.
func (s *Session) Save() error {
	return config.WriteJSON(filepath.Join(s.Folder, "session.json"), s.Record)
}

// Reload reads session.json again, for a record another process is writing.
func (s *Session) Reload() error {
	rec, e := load(s.Folder)
	if e != nil {
		return e
	}
	s.Record = rec
	return nil
}

func load(dir string) (Record, error) {
	var rec Record
	b, e := os.ReadFile(filepath.Join(dir, "session.json"))
	if e != nil {
		return rec, e
	}
	if e := json.Unmarshal(b, &rec); e != nil || len(rec.Turns) == 0 {
		return rec, errors.New(dir + ": session.json is damaged")
	}
	return rec, nil
}

// Load reads the session in a folder.
func Load(folder string) (*Session, error) {
	rec, err := load(folder)
	if err != nil {
		return nil, err
	}
	return &Session{Folder: folder, Record: rec}, nil
}

// Open finds a session by its ID.
func Open(p config.Paths, id string) (*Session, error) {
	id = strings.ToLower(config.Trim(id))
	if id == "" || strings.ContainsAny(id, "/\\") {
		return nil, config.Usage("a session is named by its six-character ID, like k3f9a2")
	}
	entries, _ := os.ReadDir(p.Sessions)
	for _, d := range entries {
		if d.IsDir() && strings.HasSuffix(d.Name(), "-"+id) {
			return Load(filepath.Join(p.Sessions, d.Name()))
		}
	}
	return nil, config.Usage("no session %s; see ask sessions", id)
}

// All lists every session, oldest first. Damaged folders are skipped.
func All(p config.Paths) []*Session {
	entries, _ := os.ReadDir(p.Sessions)
	out := []*Session{}
	for _, d := range entries {
		if !d.IsDir() {
			continue
		}
		if s, e := Load(filepath.Join(p.Sessions, d.Name())); e == nil {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created < out[j].Created })
	return out
}

// Transcript reads the native conversation saved with the session, or nil.
func (s *Session) Transcript() []json.RawMessage {
	b, e := os.ReadFile(filepath.Join(s.Folder, "transcript.json"))
	if e != nil {
		return nil
	}
	var items []json.RawMessage
	if json.Unmarshal(b, &items) != nil {
		return nil
	}
	return items
}

// SaveTranscript writes the native conversation beside the record, so the next turn continues
// it and no model turn is replayed after a crash.
func (s *Session) SaveTranscript(items []json.RawMessage) error {
	return config.WriteJSON(filepath.Join(s.Folder, "transcript.json"), items)
}

// In reports whether the session was started from, or works in, one of the given checkouts
// (physical paths).
func (s *Session) In(checkouts []string) bool {
	for _, dir := range []string{s.Origin, s.Dir} {
		if real, e := filepath.EvalSymlinks(dir); e == nil {
			dir = real
		}
		for _, c := range checkouts {
			if dir == c || strings.HasPrefix(dir, c+string(filepath.Separator)) {
				return true
			}
		}
	}
	return false
}
