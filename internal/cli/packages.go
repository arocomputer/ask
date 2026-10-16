package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/arocomputer/ask/internal/find"
	"github.com/arocomputer/ask/internal/home"
	"github.com/arocomputer/ask/internal/packages"
	"github.com/arocomputer/ask/internal/process"
	"github.com/arocomputer/ask/internal/status"
)

// install clones or updates each named source and checks the agents it brings, or with no
// sources updates every package, retaining individual update failures.
func install(p home.Paths, words []string) (int, error) {
	code := 0
	for _, source := range words {
		line, e := packages.Install(p, source)
		if e != nil {
			return 0, e
		}
		fmt.Fprintln(os.Stderr, "ask: "+line)
		_, dir, _ := packages.Locate(p, source)
		if !checkAgents(p, dir) {
			code = 1
		}
	}
	if len(words) > 0 {
		return code, nil
	}
	all := packages.Installed(p)
	if len(all) == 0 {
		fmt.Fprintln(os.Stderr, "ask: no packages installed; ask install OWNER/REPO adds one")
	}
	for _, x := range all {
		line, e := packages.Update(p, x.Path)
		if e != nil {
			fmt.Fprintf(os.Stderr, "ask: %s: could not update: %s\n", x.Name, e)
			code = 1
		} else {
			fmt.Fprintln(os.Stderr, "ask: "+line)
		}
	}
	return code, nil
}

// checkAgents lists each agent a package brings, as ask will run it, and reports whether it is
// ready: whether yours or another package's agent of that name wins, and otherwise whether
// NAME models succeeds, with its reason when not. It returns false when an agent is not ready.
func checkAgents(p home.Paths, dir string) bool {
	ready := true
	for _, name := range find.List(filepath.Join(dir, "agents")) {
		path := filepath.Join(dir, "agents", name)
		if used := find.Path(p, "agents", name); used != path {
			fmt.Fprintf(os.Stderr, "ask: %s: %s is used instead of this package's; remove it to use this one\n", name, home.Tilde(used))
			continue
		}
		ok, text := readiness(p, name, path)
		if ok {
			fmt.Fprintf(os.Stderr, "ask: %s is ready%s\n", name, text)
		} else {
			fmt.Fprintf(os.Stderr, "ask: %s is not ready: %s\n", name, text)
			ready = false
		}
	}
	return ready
}

// readiness runs NAME models from path: ready with a note about its models, or not with the reason.
func readiness(p home.Paths, name, path string) (bool, string) {
	r := process.Run(path, []string{"models"}, process.Options{Env: p.Env(nil), Timeout: 60 * time.Second})
	if r.Code != 0 {
		why := process.Reason(r.Stderr)
		if why == "" {
			why = fmt.Sprintf("%s models exited %d", name, r.Code)
		}
		return false, why
	}
	ids := 0
	for _, l := range strings.Split(home.Trim(r.Stdout), "\n") {
		if home.Trim(l) != "" {
			ids++
		}
	}
	if ids == 0 {
		return true, fmt.Sprintf("; it lists no models, so name the ones you use, like ask -m %s:MODEL (see ask help models)", name)
	}
	return true, ": " + status.Plural(ids, "model") + ", see ask models"
}

// listPackages prints each installation and its directory contents.
func listPackages(p home.Paths) (int, error) {
	all := packages.Installed(p)
	if len(all) == 0 {
		fmt.Fprintln(os.Stderr, "ask: no packages installed; ask install OWNER/REPO adds one")
	}
	width := 0
	for _, x := range all {
		if len(x.Name) > width {
			width = len(x.Name)
		}
	}
	for _, x := range all {
		fmt.Fprintf(os.Stdout, "%-*s  %s\n", width, x.Name, packages.Contents(x.Path))
	}
	return 0, nil
}

// remove validates one package argument and removes its unambiguous installation.
func remove(p home.Paths, words []string) (int, error) {
	if len(words) != 1 {
		return 0, home.Usage("ask remove takes one package, like ask remove owner/repo")
	}
	line, e := packages.Remove(p, words[0])
	if e != nil {
		return 0, e
	}
	fmt.Fprintln(os.Stderr, "ask: "+line)
	return 0, nil
}
