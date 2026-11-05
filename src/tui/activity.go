package tui

import (
	"fmt"
	"io"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

// activity is a quiet inline indicator for a single synchronous CLI operation.
// It never reads stdin or handles signals; the command retains its lifecycle.
type activity struct {
	label             string
	tick              int
	width             int
	unicode, finished bool
}

type activityTick time.Time
type activityDone struct{}

// Init starts the next animation tick.
func (m *activity) Init() tea.Cmd {
	return tea.Tick(100*time.Millisecond, func(t time.Time) tea.Msg { return activityTick(t) })
}

// Update animates until the owning operation finishes.
func (m *activity) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
	case activityTick:
		m.tick++
		return m, m.Init()
	case activityDone:
		m.finished = true
		return m, tea.Quit
	}
	return m, nil
}

// View clears transient progress when done, leaving the command to print its result.
func (m *activity) View() string {
	if m.finished {
		return ""
	}
	mark := string("|/-\\"[m.tick%4])
	if m.unicode {
		mark = string([]rune("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")[m.tick%10])
	}
	return ansi.Truncate(fmt.Sprintf("%s %s", mark, m.label), max(1, m.width-1), "") + "\n"
}

// Activity renders progress on an already-checked terminal while work runs on
// the caller's goroutine. Rendering failures never prevent the operation.
func Activity(out io.Writer, label string, unicode bool, onStop func(func()), work func() error) error {
	p := tea.NewProgram(&activity{label: label, unicode: unicode, width: 80}, tea.WithInput(nil), tea.WithOutput(out), tea.WithoutSignalHandler())
	done := make(chan struct{})
	if onStop != nil {
		onStop(func() { p.Kill(); <-done })
		defer onStop(nil)
	}
	go func() { defer close(done); _, _ = p.Run() }()
	defer func() { p.Send(activityDone{}); <-done }()
	return work()
}
