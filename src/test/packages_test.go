package test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestPackages pins ask install, update and remove: official agents, git packages, and the sources ask refuses.
func TestPackages(t *testing.T) {
	t.Run("the expanded harness packages install offline and expose their docs", func(t *testing.T) {
		s := fresh(t)
		for _, name := range []string{"copilot", "gemini", "pi", "e"} {
			s.script("agents", name, `echo explicit-model`)
			r := s.ask("install", name)
			eq(t, r.code, 0)
			match(t, r.stderr, `installed ask/packages/`+name+`: agents: `+name)
			path := filepath.Join(s.home, "packages", "ask", "packages", name, "agents", name)
			if info, err := os.Stat(path); err != nil || info.Mode()&0111 == 0 {
				t.Fatalf("%s launcher not installed as executable: %v", name, err)
			}
			eq(t, s.ask("docs", name, "--raw").code, 0)
		}
	})
	t.Run("a package from git adds agents, hooks and commands; yours win; install alone updates it", func(t *testing.T) {
		s := fresh(t)
		repo := filepath.Join(s.tmp, "src", "team", "tools")
		s.mkdir(repo)
		git := s.gitAt(repo)
		git("init", "-q", "-b", "main")
		s.scriptAt(repo, "agents", "fake", "echo 'package agent'")
		s.scriptAt(repo, "commands", "hello", "echo 'hello v1'")
		git("add", ".")
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v1")
		installed := s.ask("install", repo)
		match(t, installed.stderr, `installed local/team/tools: agents: fake · commands: hello`)
		eq(t, s.ask("hello").stdout, "hello v1\n")
		eq(t, s.ask("-m", "fake:small", "hi").stdout, "fake: hi\n")
		match(t, s.ask("packages").stdout, `(?m)^local/team/tools  agents: fake · commands: hello$`)
		s.scriptAt(repo, "commands", "hello", "echo 'hello v2'")
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "v2")
		match(t, s.ask("install").stderr, `local/team/tools: updated`)
		eq(t, s.ask("hello").stdout, "hello v2\n")
		match(t, s.ask("remove", "tools").stderr, `removed local/team/tools`)
		eq(t, s.ask("hello").code, 2)
	})
	t.Run("install refuses sources that leave the packages folder, hide their host or look like options", func(t *testing.T) {
		s := fresh(t)
		for _, source := range []string{"https://../../code", "https://example.com/../tools", "evil.example:x@github.com:acme/tools", "-oProxyCommand=x:acme/tools"} {
			r := s.ask("install", "--", source)
			eq(t, r.code, 2)
			match(t, r.stderr, `cannot tell where`)
		}
	})
	t.Run("OWNER/REPO means GitHub even beside a folder of that name", func(t *testing.T) {
		s := fresh(t)
		repo := filepath.Join(s.tmp, "acme", "tools")
		s.mkdir(repo)
		git := s.gitAt(repo)
		git("init", "-q", "-b", "main")
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "v1")
		github := map[string]string{"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "url." + s.tmp + "/.insteadOf", "GIT_CONFIG_VALUE_0": "https://github.com/"}
		match(t, s.run([]string{"install", "acme/tools"}, "", github).stderr, `installed github.com/acme/tools`)
		match(t, s.run([]string{"install", "acme/tools"}, "", github).stderr, `up to date`)
	})
	t.Run("install refuses a local folder whose name leaves no package name", func(t *testing.T) {
		s := fresh(t)
		repo := filepath.Join(s.tmp, "team", "...git")
		s.mkdir(repo)
		s.gitAt(repo)("init", "-q", "-b", "main")
		r := s.ask("install", repo)
		eq(t, r.code, 2)
		eq(t, exists(filepath.Join(s.home, "packages")), false)
	})
	t.Run("install refuses a source other than the one installed in its place", func(t *testing.T) {
		s := fresh(t)
		for _, owner := range []string{"a", "b"} {
			repo := filepath.Join(s.tmp, owner, "team", "tools")
			s.mkdir(repo)
			git := s.gitAt(repo)
			git("init", "-q", "-b", "main")
			git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "v1")
		}
		match(t, s.ask("install", filepath.Join(s.tmp, "a", "team", "tools")).stderr, `installed local/team/tools`)
		r := s.ask("install", filepath.Join(s.tmp, "b", "team", "tools"))
		eq(t, r.code, 2)
		match(t, r.stderr, `local/team/tools is installed from .*/a/team/tools; remove it first`)
		match(t, s.ask("install", filepath.Join(s.tmp, "a", "team", "tools")).stderr, `local/team/tools: up to date`)
	})
	t.Run("ask install NAME installs the official agent built into ask, even beside a folder NAME", func(t *testing.T) {
		s := fresh(t)
		s.mkdir(filepath.Join(s.tmp, "claude"))
		r := s.ask("install", "claude")
		match(t, r.stderr, `(?m)^ask: installed ask/packages/claude: agents: claude$`)
		match(t, r.stderr, `(?m)^ask: claude is (ready|not ready)`)
		agent := filepath.Join(s.home, "packages", "ask", "packages", "claude", "agents", "claude")
		info, e := os.Stat(agent)
		if e != nil || info.Mode()&0111 == 0 {
			t.Fatalf("agent not executable: %v %v", info, e)
		}
		match(t, s.ask("packages").stdout, `(?m)^ask/packages/claude +agents: claude$`)
		match(t, s.ask("install", "claude").stderr, `ask/packages/claude: up to date`)
		os.WriteFile(agent, []byte("#!/bin/sh\necho stale\n"), 0755)
		os.WriteFile(filepath.Join(filepath.Dir(filepath.Dir(agent)), ".ask-version"), []byte("old\n"), 0644)
		s.ask("runs")
		eq(t, strings.Contains(s.read(agent), "stale"), false)
		bad := s.ask("install", "not-an-official-agent")
		eq(t, bad.code, 2)
		match(t, bad.stderr, `no official agent "not-an-official-agent"; ask installs .* by name`)
	})
	t.Run("ask install says whether each agent a package brings is ready", func(t *testing.T) {
		s := fresh(t)
		repo := filepath.Join(s.tmp, "acme", "ask-demo")
		s.mkdir(repo)
		git := s.gitAt(repo)
		git("init", "-q", "-b", "main")
		s.scriptAt(repo, "agents", "demo", `[ "$1" = models ] && printf 'm1\tM1\n'`)
		s.scriptAt(repo, "agents", "broken", `echo "broken needs its CLI: install it from example.com" >&2; exit 1`)
		s.scriptAt(repo, "agents", "fake", `echo shadowed`)
		git("add", ".")
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v1")
		github := map[string]string{"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "url." + s.tmp + "/.insteadOf", "GIT_CONFIG_VALUE_0": "https://github.com/"}
		r := s.run([]string{"install", "acme/ask-demo"}, "", github)
		eq(t, r.code, 1)
		match(t, r.stderr, `installed github.com/acme/ask-demo`)
		match(t, r.stderr, `(?m)^ask: demo is ready: 1 model, see ask models$`)
		match(t, r.stderr, `(?m)^ask: broken is not ready: broken needs its CLI: install it from example.com$`)
		match(t, r.stderr, `(?m)^ask: fake: .*agents/fake is used instead of this package's`)
	})
}
