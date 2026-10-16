package cli

import (
	"bufio"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"

	official "github.com/arocomputer/ask/packages"

	"github.com/arocomputer/ask/docs"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/status"
)

// docsWeb is where the same pages are on the web, for --url.
const docsWeb = "https://github.com/arocomputer/ask/blob/main/"

// page is one documentation page: its name for ask docs, where it lives, and its text.
type page struct{ Name, Path, Text string }

// pages returns ask's documentation and the official agents' READMEs, by name: docs/usage.md is
// usage, docs/README.md is index, packages/claude/README.md is claude.
func pages() []page {
	out := []page{}
	entries, _ := fs.ReadDir(docs.FS, ".")
	for _, e := range entries {
		b, _ := fs.ReadFile(docs.FS, e.Name())
		name := strings.TrimSuffix(e.Name(), ".md")
		if name == "README" {
			name = "index"
		}
		out = append(out, page{name, "docs/" + e.Name(), string(b)})
	}
	agents, _ := fs.ReadDir(official.FS, ".")
	for _, e := range agents {
		if b, err := fs.ReadFile(official.FS, e.Name()+"/README.md"); err == nil {
			out = append(out, page{e.Name(), "packages/" + e.Name() + "/README.md", string(b)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// summaries are the "what it covers" lines of the docs index table, by page.
func summaries(all []page) map[string]string {
	out := map[string]string{"index": "Every page, and where to start"}
	for _, pg := range all {
		if pg.Name != "index" {
			continue
		}
		for _, l := range strings.Split(pg.Text, "\n") {
			cells := strings.Split(l, "|")
			if len(cells) < 4 {
				continue
			}
			if m := mdLinks.FindStringSubmatch(cells[1]); m != nil {
				if local := localLink.FindStringSubmatch(m[2]); local != nil {
					out[local[1]] = strings.ReplaceAll(strings.TrimSpace(cells[2]), "`", "")
				}
			}
		}
	}
	return out
}

// summary is a page's first sentence outside code, for pages the index doesn't describe.
func (pg page) summary() string {
	para, titled, code := []string{}, false, false
	for _, l := range strings.Split(pg.Text, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "```") {
			code = !code
			continue
		}
		switch {
		case code:
		case strings.HasPrefix(l, "# "):
			titled = true
		case !titled || strings.HasPrefix(l, "#") || strings.HasPrefix(l, "|"):
		case l == "" && len(para) > 0:
			titled = false
		case l != "":
			para = append(para, l)
		}
	}
	first := strings.Join(para, " ")
	if i := strings.Index(first, ". "); i > 0 {
		first = first[:i+1]
	}
	return strings.ReplaceAll(mdLinks.ReplaceAllString(first, "$1"), "`", "")
}

var (
	mdLinks   = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)
	localLink = regexp.MustCompile(`^(?:\.\./)*(?:docs/)?([a-z]+)\.md(#.*)?$`)
	inline    = regexp.MustCompile("`([^`]+)`")
)

// render styles markdown for a terminal: headings bold, code blocks indented, inline code bold,
// and links shown as their text, with links to other pages as `ask docs PAGE`.
func render(text string, color bool) string {
	bold := func(s string) string {
		if color {
			return "\x1b[1m" + s + "\x1b[0m"
		}
		return s
	}
	dim := func(s string) string {
		if color {
			return "\x1b[2m" + s + "\x1b[0m"
		}
		return s
	}
	var b strings.Builder
	code := false
	for _, l := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), "```") {
			code = !code
			continue
		}
		if code {
			b.WriteString("    " + l + "\n")
			continue
		}
		l = mdLinks.ReplaceAllStringFunc(l, func(m string) string {
			parts := mdLinks.FindStringSubmatch(m)
			if local := localLink.FindStringSubmatch(parts[2]); local != nil {
				name := local[1]
				if name == "readme" {
					name = "index"
				}
				return parts[1] + dim(" (ask docs "+name+")")
			}
			if strings.HasPrefix(parts[2], "http") {
				return parts[1] + dim(" ("+parts[2]+")")
			}
			return parts[1]
		})
		l = inline.ReplaceAllString(l, bold("$1"))
		l = strings.ReplaceAll(strings.ReplaceAll(l, "**", ""), "<br>", "")
		if strings.HasPrefix(l, "#") {
			l = bold(strings.TrimLeft(l, "# "))
		}
		b.WriteString(l + "\n")
	}
	return b.String()
}

// docsCommand runs ask docs: the list of pages, one page, a search, or a page's web address.
// A terminal gets styled text, through a pager when it's longer than the screen; anything else
// gets the markdown.
func docsCommand(opts home.Object, words []string) (int, error) {
	all := pages()
	if opts.Has("--search") {
		term := strings.ToLower(opts.S("--search"))
		found := 0
		for _, pg := range all {
			for n, l := range strings.Split(pg.Text, "\n") {
				if term != "" && strings.Contains(strings.ToLower(l), term) {
					fmt.Fprintf(os.Stdout, "%s:%d  %s\n", pg.Name, n+1, strings.TrimSpace(l))
					found++
				}
			}
		}
		if found == 0 {
			fmt.Fprintf(os.Stderr, "ask: nothing in the docs mentions %q\n", opts.S("--search"))
			return 1, nil
		}
		return 0, nil
	}
	if len(words) == 0 {
		if opts.B("--url") {
			fmt.Fprintln(os.Stdout, docsWeb+"docs/README.md")
			return 0, nil
		}
		color := status.CanStyle(os.Stdout)
		width, _ := status.TerminalSize()
		covers := summaries(all)
		for _, pg := range all {
			first := covers[pg.Name]
			if first == "" {
				first = pg.summary()
			}
			if status.IsTerminal(os.Stdout) && len([]rune(first)) > width-17 && width > 30 {
				first = string([]rune(first)[:width-18]) + "…"
			}
			name := fmt.Sprintf("%-14s", pg.Name)
			if color {
				name = "\x1b[1m" + name + "\x1b[0m"
				first = "\x1b[2m" + first + "\x1b[0m"
			}
			fmt.Fprintf(os.Stdout, "%s  %s\n", name, first)
		}
		fmt.Fprintln(os.Stderr, "\nask docs PAGE shows one · --search TERM finds a word · --raw prints markdown")
		return 0, nil
	}
	if len(words) > 1 {
		return 0, home.Usage("ask docs takes one page, like ask docs settings")
	}
	want := strings.ToLower(strings.TrimSuffix(words[0], ".md"))
	matches := []page{}
	for _, pg := range all {
		if pg.Name == want {
			matches = []page{pg}
			break
		}
		if strings.HasPrefix(pg.Name, want) {
			matches = append(matches, pg)
		}
	}
	if len(matches) != 1 {
		names := []string{}
		for _, pg := range matches {
			names = append(names, pg.Name)
		}
		if len(names) == 0 {
			for _, pg := range all {
				names = append(names, pg.Name)
			}
			return 0, home.Usage("no page %q; pages: %s", words[0], strings.Join(names, ", "))
		}
		return 0, home.Usage("%q could be %s", words[0], strings.Join(names, " or "))
	}
	pg := matches[0]
	if opts.B("--url") {
		fmt.Fprintln(os.Stdout, docsWeb+pg.Path)
		return 0, nil
	}
	if opts.B("--raw") || !status.IsTerminal(os.Stdout) {
		fmt.Fprint(os.Stdout, pg.Text)
		return 0, nil
	}
	text := render(pg.Text, status.CanStyle(os.Stdout))
	_, height := status.TerminalSize()
	if strings.Count(text, "\n") >= height-1 {
		if pager, e := exec.LookPath("less"); e == nil && os.Getenv("PAGER") != "cat" {
			cmd := exec.Command(pager, "-FRX")
			cmd.Stdin, cmd.Stdout, cmd.Stderr = strings.NewReader(text), os.Stdout, os.Stderr
			if cmd.Run() == nil {
				return 0, nil
			}
		}
	}
	w := bufio.NewWriter(os.Stdout)
	w.WriteString(text)
	w.Flush()
	return 0, nil
}
