// fake implements the test agent contract without calling a model or the network.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// writeReport replaces the report exactly as a user agent would.
func writeReport(v map[string]any) {
	b, _ := json.Marshal(v)
	if e := os.WriteFile(os.Getenv("ASK_REPORT"), b, 0600); e != nil {
		panic(e)
	}
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "models" {
		fmt.Println("small\tSmall One\nbig")
		return
	}
	b, e := io.ReadAll(os.Stdin)
	if e != nil {
		panic(e)
	}
	stdin := string(b)
	cwd, _ := os.Getwd()
	call := map[string]any{"pid": os.Getpid(), "stdin": stdin, "cwd": cwd}
	for key, env := range map[string]string{"access": "ASK_ACCESS", "model": "ASK_MODEL", "effort": "ASK_EFFORT", "session": "ASK_SESSION", "title": "ASK_TITLE", "contract": "ASK_CONTRACT", "max_cost": "ASK_MAX_COST"} {
		if v, ok := os.LookupEnv(env); ok {
			call[key] = v
		}
	}
	if schema := os.Getenv("ASK_SCHEMA"); schema != "" {
		b, e := os.ReadFile(schema)
		if e != nil {
			panic(e)
		}
		var v any
		if e = json.Unmarshal(b, &v); e != nil {
			panic(e)
		}
		call["schema"] = v
	}
	if log := os.Getenv("FAKE_LOG"); log != "" {
		f, e := os.OpenFile(log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if e != nil {
			panic(e)
		}
		b, _ := json.Marshal(call)
		_, e = f.Write(append(b, '\n'))
		f.Close()
		if e != nil {
			panic(e)
		}
	}
	session := os.Getenv("ASK_SESSION")
	if session == "" {
		session = fmt.Sprintf("s-%d", os.Getpid())
	}
	writeReport(map[string]any{"session": session})
	if text := os.Getenv("FAKE_WRITE"); text != "" {
		file, content, _ := strings.Cut(text, "=")
		if e := os.WriteFile(file, []byte(content), 0600); e != nil {
			panic(e)
		}
	}
	if os.Getenv("FAKE_COMMIT") != "" {
		cmd := exec.Command("git", "commit", "-qam", "fake")
		if e := cmd.Run(); e != nil {
			panic(e)
		}
	}
	if os.Getenv("FAKE_IGNORE_TERM") != "" {
		signal.Ignore(syscall.SIGTERM)
	}
	matches := func(key string) bool { s := os.Getenv(key); return s != "" && strings.Contains(stdin, s) }
	if matches("FAKE_SPEND") {
		writeReport(map[string]any{"session": session, "input": 100, "output": 10, "cost": 3.0})
		for {
			time.Sleep(time.Second)
		}
	}
	if matches("FAKE_HANG") {
		for {
			time.Sleep(time.Second)
		}
	}
	if matches("FAKE_SLOW") {
		time.Sleep(300 * time.Millisecond)
	}
	report := map[string]any{"name": "Fake 1.0", "session": session}
	if note, ok := os.LookupEnv("FAKE_NOTE"); ok {
		report["note"] = note
	}
	if os.Getenv("FAKE_NO_USAGE") == "" {
		report["input"] = 10
		report["output"] = 5
		report["cached"] = 2
		report["cost"] = 0.01
	}
	writeReport(report)
	if matches("FAKE_FAIL") {
		fmt.Fprintln(os.Stderr, "fake boom")
		os.Exit(1)
	}
	answer, ok := os.LookupEnv("FAKE_ANSWER")
	if !ok {
		parts := strings.Split(strings.TrimSpace(stdin), "\n")
		answer = "fake: " + parts[len(parts)-1]
	}
	fmt.Println(answer)
	if code := os.Getenv("FAKE_EXIT"); code != "" {
		var n int
		_, _ = fmt.Sscan(code, &n)
		os.Exit(n)
	}
}
