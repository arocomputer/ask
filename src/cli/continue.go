package cli

import (
	"fmt"
	"os"
	"strings"

	"github.com/arocomputer/ask/src/agent"
	"github.com/arocomputer/ask/src/home"
	"github.com/arocomputer/ask/src/runs"
)

// continueRun follows an explicit prompt or chooses recovery from the saved run state.
func continueRun(a *agent.Registry, opts home.Object, words []string) (int, error) {
	if len(words) == 0 || home.Trim(words[0]) == "" {
		return 0, home.Usage("ask continue needs a run; see ask runs")
	}
	ref := words[0]
	prompt := strings.Join(words[1:], " ")
	fromStdin := prompt == "-"
	if fromStdin && stdinTerminal() {
		return 0, home.Usage("no prompt: pipe it in after -")
	}
	if fromStdin {
		var err error
		prompt, err = home.ReadInput("-", "prompt")
		if err != nil {
			return 0, err
		}
	}
	if fromStdin && home.Trim(prompt) == "" {
		return 0, home.Usage("no prompt on stdin")
	}
	if home.Trim(prompt) != "" {
		if opts.Has("-C") {
			return 0, home.Usage("a follow-up uses its original directory; remove --directory")
		}
		if opts.Has("-j") {
			return 0, home.Usage("--jobs is for rerunning a batch without a prompt")
		}
		opts.Set("-c", ref)
		return runPrompt(a, opts, prompt)
	}
	r, at, err := runs.Open(a.Paths, ref)
	if err != nil {
		return 0, err
	}
	if runs.Owner(r) != 0 {
		return 0, home.Usage("%s is still running; use ask wait %s", ref, ref)
	}
	todo := 0
	for i, result := range r.Results {
		if !result.B("ok") && (at < 0 || len(r.Tasks) == 1 || at == i) {
			todo++
		}
	}
	if todo == 0 {
		return 0, home.Usage("%s is complete; give a prompt to continue the conversation (or pipe it with ask continue %s -)", ref, ref)
	}
	for key := range opts {
		if !has([]string{"-j", "--no-hooks", "--wait"}, key) {
			return 0, home.Usage("recovering a saved run keeps its original options; only --jobs, --no-hooks and --wait apply; give a prompt to change task options")
		}
	}
	jobs, err := jobCount(a, opts)
	if err != nil {
		return 0, err
	}
	var selected []int
	if at >= 0 && len(r.Tasks) > 1 {
		selected = []int{at}
	}
	if !opts.B("--wait") {
		return recoverWorker(a.Paths, r, jobs, !opts.B("--no-hooks"), selected...)
	}
	results, err := execute(a, r, jobs, !opts.B("--no-hooks"), nil, len(r.Tasks) > 1, true, selected...)
	if err != nil {
		return 0, err
	}
	if len(results) == 1 || len(selected) != 0 {
		index := 0
		if len(selected) != 0 {
			index = selected[0]
		}
		if !results[index].B("ok") {
			return 1, nil
		}
		fmt.Fprintln(os.Stdout, answerText(r.Tasks[index], results[index]))
		return 0, nil
	}
	fmt.Fprintln(os.Stdout, home.JSON(home.ResultRecords(results), true))
	for _, result := range results {
		if !result.B("ok") {
			return 1, nil
		}
	}
	return 0, nil
}
