// Package update finds ask's latest release and replaces a directly installed ask with it,
// checking the archive against the release's checksums. Homebrew and go install keep their own.
package update

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Releases is where ask's releases live; $ASK_RELEASES replaces it, for testing.
func Releases() string {
	if r := os.Getenv("ASK_RELEASES"); r != "" {
		return strings.TrimSuffix(r, "/")
	}
	return "https://github.com/arocomputer/ask/releases"
}

// Latest returns the newest release's tag, read from where releases/latest redirects.
func Latest(timeout time.Duration) (string, error) {
	client := &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	r, e := client.Head(Releases() + "/latest")
	if e != nil {
		return "", e
	}
	r.Body.Close()
	tag := filepath.Base(r.Header.Get("Location"))
	if !Release(tag) {
		return "", fmt.Errorf("could not tell the latest release from %s", Releases())
	}
	return tag, nil
}

// Release reports whether version is a release tag, like v0.1.0.
func Release(version string) bool { _, ok := parts(version); return ok }

// parts splits vX.Y.Z into numbers.
func parts(v string) ([3]int, bool) {
	var n [3]int
	fields := strings.Split(strings.TrimPrefix(v, "v"), ".")
	if !strings.HasPrefix(v, "v") || len(fields) != 3 {
		return n, false
	}
	for i, f := range fields {
		x, e := strconv.Atoi(f)
		if e != nil || x < 0 {
			return n, false
		}
		n[i] = x
	}
	return n, true
}

// Newer reports whether release a is newer than release b.
func Newer(a, b string) bool {
	x, ok1 := parts(a)
	y, ok2 := parts(b)
	if !ok1 || !ok2 {
		return false
	}
	for i := range x {
		if x[i] != y[i] {
			return x[i] > y[i]
		}
	}
	return false
}

// Method is how this ask was installed: "brew", "go" (go install), or "direct" (the install
// script or an archive), judged by where its binary lives.
func Method() string {
	exe, _ := os.Executable()
	if real, e := filepath.EvalSymlinks(exe); e == nil {
		exe = real
	}
	if strings.Contains(exe, "/Cellar/") || strings.Contains(exe, "/homebrew/") {
		return "brew"
	}
	gopath := os.Getenv("GOPATH")
	if gopath == "" {
		h, _ := os.UserHomeDir()
		gopath = filepath.Join(h, "go")
	}
	gobin := os.Getenv("GOBIN")
	if gobin == "" {
		gobin = filepath.Join(gopath, "bin")
	}
	if filepath.Dir(exe) == gobin {
		return "go"
	}
	return "direct"
}

// Hint is how to update an install that ask doesn't update itself.
func Hint(method string) string {
	switch method {
	case "brew":
		return "brew upgrade ask"
	case "go":
		return "go install github.com/arocomputer/ask/cmd/ask@latest"
	}
	return "ask update"
}

// fetch downloads a release file.
func fetch(url string) ([]byte, error) {
	client := &http.Client{Timeout: 5 * time.Minute}
	r, e := client.Get(url)
	if e != nil {
		return nil, e
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, fmt.Errorf("%s: %s", url, r.Status)
	}
	return io.ReadAll(r.Body)
}

// Apply replaces the running binary with the release tag's, after checking its archive against
// the release's checksums; the swap is a rename beside it, so a failure leaves the old one.
func Apply(tag string) error {
	archive := fmt.Sprintf("ask_%s_%s_%s.tar.gz", tag, runtime.GOOS, runtime.GOARCH)
	base := Releases() + "/download/" + tag + "/"
	data, e := fetch(base + archive)
	if e != nil {
		return e
	}
	sums, e := fetch(base + "checksums.txt")
	if e != nil {
		return e
	}
	sum := sha256.Sum256(data)
	want := ""
	scan := bufio.NewScanner(strings.NewReader(string(sums)))
	for scan.Scan() {
		if f := strings.Fields(scan.Text()); len(f) == 2 && f[1] == archive {
			want = f[0]
		}
	}
	if want == "" || want != hex.EncodeToString(sum[:]) {
		return fmt.Errorf("checksum mismatch for %s; nothing was changed", archive)
	}
	z, e := gzip.NewReader(strings.NewReader(string(data)))
	if e != nil {
		return e
	}
	t := tar.NewReader(z)
	var binary []byte
	for {
		h, e := t.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return e
		}
		if h.Name == "ask" && h.Typeflag == tar.TypeReg {
			if binary, e = io.ReadAll(t); e != nil {
				return e
			}
		}
	}
	if binary == nil {
		return fmt.Errorf("%s has no ask binary", archive)
	}
	exe, e := os.Executable()
	if e != nil {
		return e
	}
	if real, e := filepath.EvalSymlinks(exe); e == nil {
		exe = real
	}
	next := filepath.Join(filepath.Dir(exe), ".ask.next")
	if e := os.WriteFile(next, binary, 0755); e != nil {
		return e
	}
	if e := os.Rename(next, exe); e != nil {
		os.Remove(next)
		return e
	}
	return nil
}
