// Package tui renders inline prompts and review diffs. Bubble Tea owns input,
// rendering and terminal cleanup; callers own the actions following a choice.
package tui

import (
	"errors"
	"fmt"
	"io"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// ErrInterrupted reports Ctrl-C during a prompt; callers should exit 130.
var ErrInterrupted = errors.New("interrupted")

// Option is a choice and its optional secondary description.
type Option struct{ Label, Note string }

// Prompter asks inline questions, leaving answered prompts in scrollback.
type Prompter struct {
	In             io.Reader
	Out            io.Writer
	Color, Unicode bool
	OnStop         func(func()) // optional owner callback for cleanup before process exit
}

// paint emphasizes text using the terminal's own palette.
func (p *Prompter) paint(code, text string) string {
	if !p.Color || text == "" {
		return text
	}
	return "\x1b[" + code + "m" + text + "\x1b[0m"
}

// prompt holds one question's selection, editing and layout state.
type prompt struct {
	p                            *Prompter
	kind, question, def, text    string
	options                      []Option
	picked                       []bool
	cursor, caret, width, height int
	yes, done                    bool
	err                          error
}

// Init starts a prompt without background work.
func (m *prompt) Init() tea.Cmd { return nil }

// shown finds choices matching the case-insensitive filter.
func (m *prompt) shown() []int {
	var out []int
	for i, o := range m.options {
		if strings.Contains(strings.ToLower(o.Label+" "+o.Note), strings.ToLower(m.text)) {
			out = append(out, i)
		}
	}
	return out
}

// Update handles selection, editable text, paste and terminal resizing.
func (m *prompt) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if m.done {
		return m, nil
	}
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case tea.KeyMsg:
		key := msg.String()
		if key == "ctrl+c" {
			m.err, m.done = ErrInterrupted, true
			return m, tea.Quit
		}
		if m.kind == "confirm" {
			switch strings.ToLower(key) {
			case "y":
				m.yes = true
			case "n":
				m.yes = false
			case "enter":
			default:
				return m, nil
			}
			m.done = true
			return m, tea.Quit
		}
		shown := m.shown()
		if m.kind != "input" {
			m.cursor = min(max(m.cursor, 0), max(len(shown)-1, 0))
			switch key {
			case "up", "down":
				if len(shown) > 0 {
					d := 1
					if key == "up" {
						d = -1
					}
					m.cursor = (m.cursor + d + len(shown)) % len(shown)
				}
				return m, nil
			case "ctrl+a":
				if m.kind == "multi" {
					all := true
					for _, i := range shown {
						all = all && m.picked[i]
					}
					for _, i := range shown {
						m.picked[i] = !all
					}
				}
				return m, nil
			case " ":
				if m.kind == "multi" && !msg.Paste {
					if len(shown) > 0 {
						m.picked[shown[m.cursor]] = !m.picked[shown[m.cursor]]
					}
					return m, nil
				}
			case "enter":
				if m.kind == "multi" || len(shown) > 0 {
					m.done = true
					return m, tea.Quit
				}
				return m, nil
			}
		} else if key == "enter" {
			m.done = true
			return m, tea.Quit
		}
		r := []rune(m.text)
		switch key {
		case "left":
			m.caret = max(0, m.caret-1)
		case "right":
			m.caret = min(len(r), m.caret+1)
		case "home", "ctrl+a":
			m.caret = 0
		case "end", "ctrl+e":
			m.caret = len(r)
		case "backspace":
			if m.caret > 0 {
				r = append(r[:m.caret-1], r[m.caret:]...)
				m.caret--
			}
		case "delete":
			if m.caret < len(r) {
				r = append(r[:m.caret], r[m.caret+1:]...)
			}
		case "ctrl+u":
			r, m.caret = r[m.caret:], 0
		default:
			if msg.Type == tea.KeyRunes || msg.Type == tea.KeySpace {
				text := string(msg.Runes)
				if msg.Type == tea.KeySpace {
					text = " "
				}
				text = strings.Map(func(r rune) rune {
					if r < 32 || r == 127 {
						return ' '
					}
					return r
				}, text)
				insert := []rune(text)
				r = append(append(append([]rune{}, r[:m.caret]...), insert...), r[m.caret:]...)
				m.caret += len(insert)
			}
		}
		if m.text != string(r) {
			m.cursor = 0
		}
		m.text = string(r)
	}
	return m, nil
}

// answer formats the submitted value for scrollback.
func (m *prompt) answer() string {
	switch m.kind {
	case "confirm":
		if m.yes {
			return "Yes"
		}
		return "No"
	case "input":
		if s := strings.TrimSpace(m.text); s != "" {
			return s
		}
		return m.def
	case "select":
		shown := m.shown()
		if len(shown) > 0 {
			return m.options[shown[min(m.cursor, len(shown)-1)]].Label
		}
	case "multi":
		var names []string
		for i, picked := range m.picked {
			if picked {
				names = append(names, m.options[i].Label)
			}
		}
		if len(names) == 0 {
			return "None"
		}
		if len(m.options) > 6 {
			return fmt.Sprintf("%d of %d", len(names), len(m.options))
		}
		return strings.Join(names, ", ")
	}
	return ""
}

// View draws a compact monochrome hierarchy, clipping rows to the terminal.
func (m *prompt) View() string {
	mark := ">"
	if m.p.Unicode {
		mark = "›"
	}
	if m.done {
		if m.err != nil {
			return ""
		}
		return m.p.Dim(mark+" ") + m.question + " " + m.p.Bold(m.answer()) + "\n"
	}
	lines := []string{m.p.Bold(m.question)}
	switch m.kind {
	case "confirm":
		hint := "y/N"
		if m.yes {
			hint = "Y/n"
		}
		lines = append(lines, "  "+m.p.Dim(hint+" · enter to confirm"))
	case "input":
		r := []rune(m.text)
		before, after := string(r[:m.caret]), string(r[m.caret:])
		room := max(1, m.width-4)
		before = ansi.TruncateLeft(before, max(0, lipgloss.Width(before)-room), "")
		cursor := "|"
		if m.p.Color {
			cursor = m.p.paint("7", " ")
			if len(after) > 0 {
				cursor = m.p.paint("7", string(r[m.caret]))
				after = string(r[m.caret+1:])
			}
		}
		lines = append(lines, "  "+before+cursor+after)
		hint := "enter to confirm"
		if m.def != "" {
			hint += " · default: " + m.def
		}
		lines = append(lines, "  "+m.p.Dim(hint))
	default:
		shown := m.shown()
		if m.text != "" {
			lines = append(lines, "  "+m.p.Dim("filter: ")+m.text)
		}
		size := min(10, max(1, m.height-5))
		cursor := min(m.cursor, max(0, len(shown)-1))
		start := max(0, min(cursor-size/2, len(shown)-size))
		end := min(len(shown), start+size)
		width := 0
		for _, o := range m.options {
			width = max(width, lipgloss.Width(o.Label))
		}
		width = min(width, max(8, m.width/2))
		for n := start; n < end; n++ {
			i := shown[n]
			o := m.options[i]
			prefix := "  "
			if n == cursor {
				prefix = mark + " "
			}
			box := ""
			if m.kind == "multi" {
				box = "[ ] "
				if m.picked[i] {
					box = "[x] "
				}
				if m.p.Unicode {
					box = "○ "
					if m.picked[i] {
						box = "● "
					}
				}
			}
			label := ansi.Truncate(o.Label, width, "…")
			padding := strings.Repeat(" ", max(0, width-lipgloss.Width(label)))
			if n == cursor {
				label = m.p.Bold(label)
			}
			line := prefix + box + label
			if o.Note != "" {
				line += padding + "  " + m.p.Dim(o.Note)
			}
			lines = append(lines, line)
		}
		if len(shown) == 0 {
			lines = append(lines, "  "+m.p.Dim("nothing matches"))
		}
		hint := "↑↓ move · type to filter · enter select"
		if !m.p.Unicode {
			hint = "up/down move · type to filter · enter select"
		}
		if m.kind == "multi" {
			hint = "space toggle · ctrl-a all · enter confirm"
		}
		if len(shown) > size {
			hint = fmt.Sprintf("%d/%d · ", cursor+1, len(shown)) + hint
		}
		lines = append(lines, "  "+m.p.Dim(hint))
	}
	for i, line := range lines {
		lines[i] = ansi.Truncate(line, max(1, m.width-1), "")
	}
	return strings.Join(lines, "\n") + "\n"
}

// run gives Bubble Tea sole ownership of the terminal until the question ends.
func (p *Prompter) run(m *prompt) error {
	m.p, m.width, m.height = p, 80, 24
	options := []tea.ProgramOption{tea.WithInput(p.In), tea.WithOutput(p.Out)}
	if p.OnStop != nil {
		options = append(options, tea.WithoutSignalHandler())
	}
	program := tea.NewProgram(m, options...)
	done := make(chan struct{})
	defer close(done)
	if p.OnStop != nil {
		p.OnStop(func() { program.Kill(); <-done })
		defer p.OnStop(nil)
	}
	_, err := program.Run()
	if err != nil {
		return err
	}
	if !m.done {
		return ErrInterrupted
	}
	return m.err
}

// Confirm asks a yes-or-no question; enter accepts the default.
func (p *Prompter) Confirm(q string, yes bool) (bool, error) {
	m := &prompt{kind: "confirm", question: q, yes: yes}
	err := p.run(m)
	return m.yes, err
}

// Select asks for one filtered choice, initially highlighting start.
func (p *Prompter) Select(q string, options []Option, start int) (int, error) {
	if len(options) == 0 {
		return 0, errors.New("no choices")
	}
	m := &prompt{kind: "select", question: q, options: options, cursor: min(max(start, 0), len(options)-1)}
	if err := p.run(m); err != nil {
		return 0, err
	}
	return m.shown()[m.cursor], nil
}

// MultiSelect edits a copy of chosen; space toggles one, ctrl-a toggles matching choices.
func (p *Prompter) MultiSelect(q string, options []Option, chosen []bool) ([]bool, error) {
	picked := make([]bool, len(options))
	copy(picked, chosen)
	m := &prompt{kind: "multi", question: q, options: options, picked: picked}
	err := p.run(m)
	return m.picked, err
}

// Input edits a line, using def when the submitted text is empty.
func (p *Prompter) Input(q, def string) (string, error) {
	m := &prompt{kind: "input", question: q, def: def}
	err := p.run(m)
	return m.answer(), err
}

// Say prints a completed action outside an active prompt.
func (p *Prompter) Say(mark, text string) { fmt.Fprintln(p.Out, p.Dim(mark)+" "+text) }

// Bold emphasizes primary text.
func (p *Prompter) Bold(text string) string { return p.paint("1", text) }

// Dim styles secondary text using the terminal palette.
func (p *Prompter) Dim(text string) string { return p.paint("2", text) }

// Title prints a heading and secondary context.
func (p *Prompter) Title(name, note string) { fmt.Fprintln(p.Out, p.Bold(name)+"  "+p.Dim(note)+"\n") }
