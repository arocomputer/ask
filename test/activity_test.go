package test

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// TestActivity exercises the optional agent transport without a vendor CLI or network.
func TestActivity(t *testing.T) {
	t.Run("private events survive detached execution independently of answers and reports", func(t *testing.T) {
		s := fresh(t)
		stale := filepath.Join(s.tmp, "stale.jsonl")
		s.write(stale, "untouched\n")
		s.env["ASK_EVENTS"] = stale
		s.env["ASK_HOME"] = "home"
		s.script("agents", "activity", `if [ "$1" = models ]; then
  printf '%s' "${ASK_EVENTS-unset}" > "$HOME/models-env"
  echo small
  exit 0
fi
cat >/dev/null
case "$ASK_EVENTS" in /*) ;; *) exit 2 ;; esac
test -f "$ASK_EVENTS" && test ! -s "$ASK_EVENTS" || exit 3
printf '%s' "$ASK_EVENTS" > "$HOME/event-path"
printf '%s\n' '{"type":"message","text":"hello 🐧"}' '{"type":"reasoning","text":"public summary"}' '{"type":"tool","text":"checking","tool":"check"}' '{"type":"tool_result","text":"passed","tool":"check"}' >> "$ASK_EVENTS"
printf '{"type":' >> "$ASK_EVENTS"
echo '{"session":"activity-session","input":7,"cost":0.01}' > "$ASK_REPORT"
echo answer`)
		s.json(filepath.Join(s.home, "environment.json"), object{"agents": object{"activity": object{"inherit": []string{"PATH", "HOME", "ASK_EVENTS"}, "remove": []string{"ASK_EVENTS"}}}})
		launch := s.ask("-m", "activity:small", "go")
		eq(t, launch.code, 0)
		r := s.ask("wait", strings.TrimSpace(launch.stdout))
		eq(t, r.code, 0)
		eq(t, r.stdout, "answer\n")
		path := filepath.Join(s.home, "runs", s.dirs()[0], "events-0.jsonl")
		eq(t, s.read(filepath.Join(s.tmp, "event-path")), path)
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		eq(t, info.Mode().Perm(), os.FileMode(0600))
		lines := strings.Split(s.read(path), "\n")
		eq(t, len(lines), 5)
		for i, kind := range []string{"message", "reasoning", "tool", "tool_result"} {
			eq(t, obj(t, lines[i]).s("type"), kind)
		}
		eq(t, obj(t, lines[0]).s("text"), "hello 🐧")
		eq(t, obj(t, lines[2]).s("tool"), "check")
		eq(t, lines[4], `{"type":`)
		eq(t, s.read(stale), "untouched\n")
		eq(t, s.read(filepath.Join(s.tmp, "models-env")), "unset")
		result := s.runFile("results.json")[0]
		eq(t, result.s("session"), "activity-session")
		jsonEqual(t, result["usage"], object{"input": 7, "cost": 0.01})
		noMatch(t, r.stdout+r.stderr, `public summary|checking|hello 🐧`)
	})
	t.Run("all hook follow-up rounds append to one file without leaking the path to hooks or commands", func(t *testing.T) {
		s := fresh(t)
		s.env["ASK_EVENTS"] = filepath.Join(s.tmp, "inherited.jsonl")
		s.localAgent("activity", `cat >/dev/null
printf '%s\n' "$ASK_EVENTS" >> "$HOME/event-paths"
printf '%s\n' '{"type":"message","text":"round"}' >> "$ASK_EVENTS"
echo '{"session":"activity-session"}' > "$ASK_REPORT"
echo answer`)
		s.script("hooks", "again", `printf '%s:%s\n' "$1" "${ASK_EVENTS-unset}" >> "$HOME/hook-env"
if [ "$1" = events ]; then printf 'task\nresult\ntitle\nname\n'; exit 0; fi
cat >/dev/null
if [ "$1" = result ]; then echo '{"followup":"again"}'; fi`)
		r := s.ask("--wait", "-m", "activity:small", "go")
		eq(t, r.code, 0)
		eq(t, r.stdout, "answer\n")
		path := filepath.Join(s.home, "runs", s.dirs()[0], "events-0.jsonl")
		eq(t, s.read(filepath.Join(s.tmp, "event-paths")), strings.Repeat(path+"\n", 4))
		eq(t, s.read(path), strings.Repeat("{\"type\":\"message\",\"text\":\"round\"}\n", 4))
		seen := map[string]int{}
		for _, line := range strings.Fields(s.read(filepath.Join(s.tmp, "hook-env"))) {
			event, value, _ := strings.Cut(line, ":")
			eq(t, value, "unset")
			seen[event]++
		}
		eq(t, seen["result"], 4)
		eq(t, seen["task"], 1)
		eq(t, seen["title"], 4)
		s.script("commands", "event-env", `printf '%s' "${ASK_EVENTS-unset}"`)
		eq(t, s.ask("event-env").stdout, "unset")
	})
	t.Run("concurrent batch positions keep independent streams and resume preserves a partial tail", func(t *testing.T) {
		s := fresh(t)
		s.localAgent("activity", `prompt=$(cat)
printf '%s' "$ASK_EVENTS" > "$HOME/$prompt-path"
if [ "$prompt" = beta ] && [ -e "$HOME/retry" ]; then
  printf ' finished"}\n' >> "$ASK_EVENTS"
else
  printf '{"type":"message","text":"%s"}\n' "$prompt" >> "$ASK_EVENTS"
  touch "$HOME/$prompt-started"
  while [ ! -e "$HOME/alpha-started" ] || [ ! -e "$HOME/beta-started" ]; do sleep 0.01; done
  if [ "$prompt" = beta ]; then
    printf '{"type":"tool_result","text":"🐧' >> "$ASK_EVENTS"
    touch "$HOME/retry"
    exit 1
  fi
fi
printf '{"type":"tool_result","text":"%s done"}\n' "$prompt" >> "$ASK_EVENTS"
echo "$prompt answer"`)
		r := s.run([]string{"batch", "--wait", "-m", "activity:small", "-j", "2", "-"}, `[{"id":"same","prompt":"alpha"},{"id":"same","prompt":"beta"}]`, nil)
		eq(t, r.code, 1)
		dir := filepath.Join(s.home, "runs", s.dirs()[0])
		alpha, beta := filepath.Join(dir, "events-0.jsonl"), filepath.Join(dir, "events-1.jsonl")
		eq(t, s.read(filepath.Join(s.tmp, "alpha-path")), alpha)
		eq(t, s.read(filepath.Join(s.tmp, "beta-path")), beta)
		first := s.read(alpha)
		partial := s.read(beta)
		eq(t, partial, "{\"type\":\"message\",\"text\":\"beta\"}\n{\"type\":\"tool_result\",\"text\":\"🐧")
		if err := os.Chmod(beta, 0644); err != nil {
			t.Fatal(err)
		}
		r = s.ask("batch", "--wait", "--resume", dir)
		eq(t, r.code, 0)
		eq(t, stringsField(objects(t, r.stdout), "answer"), []string{"alpha answer", "beta answer"})
		eq(t, s.read(alpha), first)
		eq(t, s.read(beta), partial+" finished\"}\n{\"type\":\"tool_result\",\"text\":\"beta done\"}\n")
		info, err := os.Stat(beta)
		if err != nil {
			t.Fatal(err)
		}
		eq(t, info.Mode().Perm(), os.FileMode(0600))
	})
	t.Run("unsafe event paths disable optional activity without failing resumed answers", func(t *testing.T) {
		for _, kind := range []string{"symlink", "hardlink", "directory", "fifo"} {
			t.Run(kind, func(t *testing.T) {
				s := fresh(t)
				first := s.run([]string{"--wait", "-m", "fake:small", "fail"}, "", map[string]string{"FAKE_FAIL": "fail"})
				eq(t, first.code, 1)
				dir := filepath.Join(s.home, "runs", s.dirs()[0])
				path := filepath.Join(dir, "events-0.jsonl")
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				target := filepath.Join(s.tmp, "private-target")
				s.write(target, "untouched\n")
				var err error
				switch kind {
				case "symlink":
					err = os.Symlink(target, path)
				case "hardlink":
					err = os.Link(target, path)
				case "directory":
					err = os.Mkdir(path, 0700)
				case "fifo":
					err = syscall.Mkfifo(path, 0600)
				}
				if err != nil {
					t.Fatal(err)
				}
				s.env["ASK_EVENTS"] = target
				if err := os.Remove(filepath.Join(s.home, "agents", "fake")); err != nil {
					t.Fatal(err)
				}
				s.localAgent("fake", `cat >/dev/null; printf '%s' "${ASK_EVENTS-unset}" > "$HOME/event-env"; echo answer`)
				r := s.ask("batch", "--wait", "--resume", dir)
				eq(t, r.code, 0)
				eq(t, objects(t, r.stdout)[0].s("answer"), "answer")
				eq(t, s.read(filepath.Join(s.tmp, "event-env")), "unset")
				eq(t, s.read(target), "untouched\n")
				info, err := os.Stat(target)
				if err != nil {
					t.Fatal(err)
				}
				eq(t, info.Mode().Perm(), os.FileMode(0600))
			})
		}
	})
}
