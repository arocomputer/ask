package cli

import (
	"regexp"
	"strings"
)

var assignment = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)

// shellInput is what a simple command reads from a heredoc and the file its stdout goes to.
// Stdin is set only for a heredoc ask can read literally: a quoted delimiter, or a body
// without expansions.
type shellInput struct {
	Stdin    string
	HasStdin bool
	Out      string
}

// heredoc is a heredoc whose body starts after the line that opened it.
type heredoc struct {
	command      int
	delim        string
	strip, quote bool
}

// shellCommands splits literal simple commands without executing expansions or shell code,
// with each command's heredoc and stdout file in inputs.
// Unsupported syntax and incomplete quotes, escapes, redirects or heredocs make the whole input unusable.
func shellCommands(s string) (commands [][]string, inputs []shellInput, ok bool) {
	commands = [][]string{}
	words := []string{}
	var word strings.Builder
	var input shellInput
	var pending []heredoc
	active, redirect, skip, out, descriptor := false, false, false, false, true
	quote := byte(0)
	flush := func() {
		if active {
			if skip {
				if out {
					input.Out = word.String()
				}
				skip, out = false, false
			} else {
				words = append(words, word.String())
			}
			word.Reset()
			active = false
			descriptor = true
		}
	}
	finish := func() bool {
		flush()
		if skip || redirect {
			return false
		}
		if len(words) > 0 {
			commands = append(commands, words)
			inputs = append(inputs, input)
			words = nil
		}
		input = shellInput{}
		return true
	}
	// bodies reads the pending heredocs' bodies after the newline at i, returning the index of
	// the newline that ends the last delimiter line, or -1 when a delimiter never comes.
	bodies := func(i int) int {
		for _, h := range pending {
			var body strings.Builder
			for {
				if i >= len(s) {
					return -1
				}
				end := strings.IndexByte(s[i+1:], '\n')
				if end < 0 {
					end = len(s)
				} else {
					end += i + 1
				}
				line := s[i+1 : end]
				i = end
				if h.strip {
					line = strings.TrimLeft(line, "\t")
				}
				if line == h.delim {
					break
				}
				body.WriteString(line + "\n")
			}
			text := body.String()
			if h.command < len(commands) && (h.quote || !strings.ContainsAny(text, "$`\\")) {
				inputs[h.command].Stdin, inputs[h.command].HasStdin = text, true
			}
		}
		pending = nil
		return i
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if quote == '\'' {
			if c == '\'' {
				quote = 0
			} else {
				word.WriteByte(c)
			}
			continue
		}
		if c == '\\' {
			if i+1 == len(s) {
				return nil, nil, false
			}
			i++
			next := s[i]
			if next == '\n' {
				continue
			}
			active = true
			descriptor = false
			redirect = false
			if quote == '"' && !strings.ContainsRune("$`\"\\", rune(next)) {
				word.WriteByte('\\')
			}
			word.WriteByte(next)
			continue
		}
		if quote == '"' {
			if c == '"' {
				quote = 0
			} else {
				if c == '`' || c == '$' {
					return nil, nil, false
				}
				word.WriteByte(c)
			}
			continue
		}
		switch c {
		case '\'', '"':
			quote = c
			descriptor = false
			active = true
			redirect = false
		case ' ', '\t', '\r':
			flush()
		case '#':
			if active {
				word.WriteByte(c)
			} else {
				for i < len(s) && s[i] != '\n' {
					i++
				}
				i--
			}
		case '$', '`', '(', ')', '{', '}':
			return nil, nil, false
		case '<', '>':
			fd := ""
			if active && descriptor && allDigits(word.String()) {
				fd = word.String()
				word.Reset()
				active = false
			} else {
				flush()
			}
			if skip {
				return nil, nil, false
			}
			if c == '<' && strings.HasPrefix(s[i:], "<<") {
				h, next, ok := heredocStart(s, i+2)
				if !ok {
					return nil, nil, false
				}
				h.command = len(commands)
				pending = append(pending, h)
				i = next - 1
				continue
			}
			skip = true
			out = c == '>' && (fd == "" || fd == "1")
			if i+1 < len(s) && (s[i+1] == c || s[i+1] == '&' || s[i+1] == '|') {
				i++
				out = out && s[i] != '&'
			}
		case ';', '|', '&', '\n':
			if c == '\n' && redirect {
				if len(pending) > 0 {
					return nil, nil, false
				}
				continue
			}
			if (c == '|' || c == '&' || c == ';') && len(words) == 0 && !active {
				return nil, nil, false
			}
			if !finish() {
				return nil, nil, false
			}
			if c == '\n' && len(pending) > 0 {
				if i = bodies(i); i < 0 {
					return nil, nil, false
				}
				continue
			}
			if (c == '|' || c == '&') && i+1 < len(s) && s[i+1] == c {
				i++
				redirect = true
			}
			if c == '|' {
				redirect = true
			}
		default:
			redirect = false
			active = true
			if c < '0' || c > '9' {
				descriptor = false
			}
			word.WriteByte(c)
		}
	}
	if quote != 0 || !finish() || len(pending) > 0 {
		return nil, nil, false
	}
	return commands, inputs, true
}

// heredocStart reads a heredoc's optional - and its delimiter word after <<, returning the
// index after the word. A quoted delimiter, wholly or in part, keeps the body literal.
func heredocStart(s string, i int) (heredoc, int, bool) {
	h := heredoc{}
	if i < len(s) && s[i] == '<' {
		return h, i, false // a here-string
	}
	if i < len(s) && s[i] == '-' {
		h.strip = true
		i++
	}
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	var delim strings.Builder
	quote := byte(0)
	for ; i < len(s); i++ {
		c := s[i]
		if quote != 0 {
			if c == quote {
				quote = 0
			} else {
				delim.WriteByte(c)
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote, h.quote = c, true
			continue
		}
		if c == '\\' && i+1 < len(s) {
			i++
			delim.WriteByte(s[i])
			h.quote = true
			continue
		}
		if strings.IndexByte(" \t\n;|&<>()$`", c) >= 0 {
			break
		}
		delim.WriteByte(c)
	}
	h.delim = delim.String()
	return h, i, quote == 0 && h.delim != ""
}

// allDigits recognizes a redirect's optional file descriptor.
func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
