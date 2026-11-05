package test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// TestUpdate pins ask update against a local stand-in for GitHub releases: --check reports a
// newer release, an update replaces the binary, a bad checksum changes nothing, and installer
// help works without needing the script on disk.
func TestUpdate(t *testing.T) {
	t.Run("installer help works from a file and from stdin", func(t *testing.T) {
		script, e := os.ReadFile(filepath.Join(root, "install.sh"))
		if e != nil {
			t.Fatal(e)
		}
		for _, stdin := range []bool{false, true} {
			cmd := exec.Command("sh", filepath.Join(root, "install.sh"), "--help")
			if stdin {
				cmd = exec.Command("sh", "-s", "--", "--help")
				cmd.Stdin = bytes.NewReader(script)
			}
			out, e := cmd.CombinedOutput()
			if e != nil {
				t.Fatalf("installer help: %s\n%s", e, out)
			}
			match(t, string(out), `--version vX\.Y\.Z`)
			match(t, string(out), `--dir DIR`)
			match(t, string(out), `Then run ask setup\.`)
		}
	})
	s := fresh(t)
	bin := filepath.Join(s.tmp, "bin", "ask")
	build := exec.Command("go", "build", "-ldflags", "-X main.version=v0.1.0", "-o", bin, ".")
	build.Dir = root
	if out, e := build.CombinedOutput(); e != nil {
		t.Fatalf("%s %s", e, out)
	}
	next := []byte("#!/bin/sh\necho v9.9.9\n")
	var archive bytes.Buffer
	z := gzip.NewWriter(&archive)
	w := tar.NewWriter(z)
	w.WriteHeader(&tar.Header{Name: "ask", Mode: 0755, Size: int64(len(next)), Typeflag: tar.TypeReg})
	w.Write(next)
	w.Close()
	z.Close()
	name := fmt.Sprintf("ask_v9.9.9_%s_%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	sum := sha256.Sum256(archive.Bytes())
	checksums := hex.EncodeToString(sum[:]) + "  " + name + "\n"
	server := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest":
			http.Redirect(rw, r, "/tag/v9.9.9", http.StatusFound)
		case "/download/v9.9.9/" + name:
			rw.Write(archive.Bytes())
		case "/download/v9.9.9/checksums.txt":
			rw.Write([]byte(checksums))
		default:
			http.NotFound(rw, r)
		}
	}))
	defer server.Close()
	run := func(args ...string) output {
		cmd := exec.Command(bin, args...)
		cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + s.tmp, "ASK_HOME=" + s.home, "ASK_RELEASES=" + server.URL}
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		e := cmd.Run()
		code := 0
		if x, ok := e.(*exec.ExitError); ok {
			code = x.ExitCode()
		}
		return output{code, stdout.String(), stderr.String()}
	}
	check := run("update", "--check")
	eq(t, check.code, 1)
	match(t, check.stderr, `ask: v9\.9\.9 is out \(you have v0\.1\.0\); update with: ask update`)
	good := checksums
	checksums = "0000  " + name + "\n"
	bad := run("update")
	match(t, bad.stderr, `checksum mismatch`)
	eq(t, run("--version").stdout, "v0.1.0\n")
	checksums = good
	eq(t, run("update").code, 0)
	b, _ := os.ReadFile(bin)
	eq(t, string(b), string(next))
}
