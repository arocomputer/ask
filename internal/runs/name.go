package runs

import (
	"strconv"
	"strings"

	"github.com/arocomputer/ask/internal/find"
	"github.com/arocomputer/ask/internal/home"
)

// filler words say little about a task, so prompt-made names skip them.
var filler = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`a an the to for of in on at by from with into about and or but so
		if then than as is are was were be been being am do does did done can could would should will shall
		may might must i me my we us our you your it its this that these those there here what which who
		how why when where please just also very really let lets make sure some any all not no up out
		hey hi now quickly briefly`) {
		filler[w] = true
	}
}

// words lowercases text into ASCII letter-and-digit words.
func words(text string) []string {
	return strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	})
}

// join hyphenates words, stopping at max words or before exceeding 40 characters.
func join(list []string, max int) string {
	out := ""
	for i, w := range list {
		if i == max || len(out)+len(w)+1 > 41 {
			break
		}
		if out != "" {
			out += "-"
		}
		out += w
	}
	return out
}

// Slug names a run after the first meaningful words of its prompt, like add-rate-limiting-login.
// It returns "" when the prompt has no usable words.
func Slug(prompt string) string {
	keep := []string{}
	for _, w := range words(prompt) {
		if !filler[w] && (len(w) > 1 || w[0] >= '0' && w[0] <= '9') && (len(keep) == 0 || keep[len(keep)-1] != w) {
			keep = append(keep, w)
		}
	}
	return join(keep, 4)
}

// Clean turns a name chosen by a hook into a run name, keeping all its words.
func Clean(name string) string {
	return join(words(name), 8)
}

// Unique returns name, or name-2, name-3 and so on when an earlier run or worktree already uses it.
func Unique(p home.Paths, name string) string {
	if name == "" {
		return ""
	}
	used := map[string]bool{}
	for _, n := range find.List(p.Runs) {
		_, id, runName := folder(n)
		used[id], used[runName] = true, true
	}
	for _, n := range p.WorktreeNames() {
		used[n] = true
	}
	for i, next := 2, name; ; i++ {
		if !used[next] {
			return next
		}
		next = name + "-" + strconv.Itoa(i)
	}
}

// Inherit returns the name a follow-up of ref takes over, so the name keeps reaching
// the latest turn: the run's name. A batch task's follow-up starts its own line of turns,
// named RUN-TASK, made unique so it never takes the batch's or another run's name.
// Unnamed runs pass none on.
func Inherit(p home.Paths, ref string) string {
	prev, at, e := Open(p, ref)
	if e != nil || at < 0 || prev.Name == "" {
		return ""
	}
	if len(prev.Tasks) == 1 {
		return prev.Name
	}
	return Unique(p, Clean(prev.Name+"-"+prev.Tasks[at].S("id")))
}
