package test

import (
	"path/filepath"
	"testing"
)

// TestEnvironment exercises policy at the real agent launch boundary, with no vendor CLI.
func TestEnvironment(t *testing.T) {
	t.Run("add and remove adjust defaults without exposing contract fields", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("echo", `cat >/dev/null; printf '%s|%s|%s|%s\n' "$KEPT" "$EXTRA" "$REMOVED" "$ASK_ACCESS"`)
		s.json(filepath.Join(s.home, "agents", "echo.environment.json"), object{"inherit": []string{"PATH", "KEPT", "REMOVED"}})
		s.json(filepath.Join(s.home, "environment.json"), object{"agents": object{"echo": object{"add": []string{"EXTRA"}, "remove": []string{"REMOVED", "ASK_ACCESS"}}}})
		r := s.run([]string{"-m", "echo:small", "hi"}, "", map[string]string{"KEPT": "kept", "EXTRA": "extra", "REMOVED": "removed"})
		eq(t, r.code, 0)
		eq(t, r.stdout, "kept|extra||read\n")
	})
	t.Run("inherit is exact and contract fields win over parent values", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("echo", `cat >/dev/null; printf '%s|%s|%s|%s|%s|%s|%s\n' "$KEPT" "$DROPPED" "$ASK_ACCESS" "$ASK_SESSION" "$ASK_ENVIRONMENT" "$ASK_CONTRACT" "$ASK_ENVIRONMENT_REQUESTED"`)
		s.json(filepath.Join(s.home, "environment.json"), object{"agents": object{"echo": object{"inherit": []string{"PATH", "HOME", "KEPT", "ASK_ACCESS", "ASK_ENVIRONMENT"}}}})
		r := s.run([]string{"-m", "echo:small", "hi"}, "", map[string]string{"KEPT": "kept", "DROPPED": "private-sentinel", "ASK_ACCESS": "write", "ASK_SESSION": "outer", "ASK_ENVIRONMENT": `{"mcp":true}`, "ASK_ENVIRONMENT_REQUESTED": `{"mcp":true}`})
		eq(t, r.code, 0)
		eq(t, r.stdout, "kept||read|||1|\n")
		noMatch(t, r.stderr, "private-sentinel")
	})
	t.Run("manifest defaults apply to models and tasks and configuration replaces inheritance", func(t *testing.T) {
		s := fresh(t)
		s.script("agents", "echo", `if [ "$1" = models ]; then [ -z "$DROPPED" ] || exit 1; echo small; exit; fi
cat >/dev/null
printf '%s|%s|%s|%s\n' "$KEPT" "$DROPPED" "$ASK_ENVIRONMENT" "$ASK_ENVIRONMENT_REQUESTED"`)
		s.json(filepath.Join(s.home, "agents", "echo.environment.json"), object{"inherit": []string{"PATH", "HOME", "KEPT"}, "integrations": object{"mcp": false}})
		s.env["KEPT"], s.env["DROPPED"] = "kept", "private-sentinel"
		eq(t, s.ask("models").code, 0)
		eq(t, s.ask("-m", "echo:small", "hi").stdout, "kept||{\"mcp\":false}|{}\n")
		s.json(filepath.Join(s.home, "environment.json"), object{"agents": object{"echo": object{"inherit": []string{"PATH", "HOME"}, "integrations": object{"mcp": true}}}})
		eq(t, s.ask("-m", "echo:small", "hi").stdout, "||{\"mcp\":true}|{\"mcp\":true}\n")
	})
	t.Run("a local executable override does not inherit a packaged adapter declaration", func(t *testing.T) {
		s := fresh(t)
		eq(t, s.ask("install", "pi").code, 0)
		s.localAgent("pi", `cat >/dev/null; echo overridden`)
		s.json(filepath.Join(s.home, "environment.json"), object{"agents": object{"pi": object{"integrations": object{"mcp": false}}}})
		r := s.ask("-m", "pi:small", "hi")
		eq(t, r.code, 1)
		match(t, r.stderr, "cannot enforce")
		eq(t, r.stdout, "")
	})
	t.Run("an empty inherit list still supplies the fresh contract", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("echo", `printf '%s|%s|%s|%s\n' "$KEPT" "$HOME" "$ASK_MODEL" "$ASK_CONTRACT"`)
		s.json(filepath.Join(s.home, "environment.json"), object{"agents": object{"echo": object{"inherit": []string{}}}})
		s.env["KEPT"] = "private-sentinel"
		r := s.ask("-m", "echo:small", "hi")
		eq(t, r.code, 0)
		eq(t, r.stdout, "||small|1\n")
	})
	t.Run("unsupported integration restrictions fail before running the agent", func(t *testing.T) {
		s := fresh(t)
		s.json(filepath.Join(s.home, "environment.json"), object{"agents": object{"fake": object{"integrations": object{"mcp": false}}}})
		r := s.ask("-m", "fake:small", "hi")
		eq(t, r.code, 1)
		match(t, r.stderr, "cannot enforce")
		eq(t, len(s.calls()), 0)
	})
	t.Run("malformed policy fails closed without echoing configuration contents", func(t *testing.T) {
		for _, config := range []string{`{private-sentinel`, `null`, `{"agents":null}`, `{"agents":{"fake":{"inherit":null}}}`, `{"agents":{"fake":{"inherit":["private-sentinel=secret"]}}}`, `{"agents":{"fake":{"integrations":{"mcp":"private-sentinel"}}}}`, `{"agents":{"fake":{"private-sentinel":true}}}`, `{"agents":{"fake":{"integrations":{"private-sentinel":false}}}}`} {
			s := fresh(t)
			s.write(filepath.Join(s.home, "environment.json"), config)
			r := s.ask("-m", "fake:small", "hi")
			eq(t, r.code, 1)
			noMatch(t, r.stderr, "private-sentinel")
			eq(t, len(s.calls()), 0)
		}
	})
	t.Run("Ask task hooks retain their environment under an agent policy", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("echo", `cat >/dev/null; echo answer`)
		s.json(filepath.Join(s.home, "environment.json"), object{"agents": object{"echo": object{"inherit": []string{"PATH", "HOME"}}}})
		s.hook("policy", []string{"task"}, `cat >/dev/null; echo "$POLICY_ENV" > "$HOME/policy-ran"`)
		s.env["POLICY_ENV"] = "present"
		eq(t, s.ask("-m", "echo:small", "hi").code, 0)
		eq(t, s.read(filepath.Join(s.tmp, "policy-ran")), "present\n")
	})
	t.Run("installation readiness uses the selected executable's policy", func(t *testing.T) {
		s := fresh(t)
		repo := filepath.Join(s.tmp, "src", "team", "tools")
		s.mkdir(repo)
		git := s.gitAt(repo)
		git("init", "-q", "-b", "main")
		s.scriptAt(repo, "agents", "echo", `printf '%s|%s|%s' "$KEPT" "$DROPPED" "$ASK_ENVIRONMENT_REQUESTED" > "$HOME/readiness-env"; echo small`)
		s.json(filepath.Join(repo, "agents", "echo.environment.json"), object{"inherit": []string{"PATH", "HOME", "KEPT"}, "integrations": object{"mcp": false}})
		git("add", ".")
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture")
		s.env["KEPT"], s.env["DROPPED"] = "kept", "private-sentinel"
		r := s.ask("install", repo)
		eq(t, r.code, 0)
		eq(t, s.read(filepath.Join(s.tmp, "readiness-env")), "kept||{}")
		noMatch(t, r.stderr, `echo\.environment\.json`)
	})
}
