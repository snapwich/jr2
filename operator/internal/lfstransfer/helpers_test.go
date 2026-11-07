/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package lfstransfer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/snapwich/jr2/operator/internal/uploadpack"
)

// agentEnv makes the test binary act as jr2-lfs when git-lfs starts it: the
// integration test names the test binary as the custom transfer agent.
const agentEnv = "JR2_LFS_TEST_AGENT"

func TestMain(m *testing.M) {
	if os.Getenv(agentEnv) == "1" {
		os.Exit(Run(Options{Args: os.Args[1:]}))
	}
	os.Exit(m.Run())
}

const (
	testIdentity = "github.com/acme/my app%20x"
	attrsLFS     = "*.bin filter=lfs diff=lfs merge=lfs -text\n"
)

// blob is one large file's content, its object, and its pointer text.
type blob struct {
	data    []byte
	obj     Object
	pointer string
}

func newBlob(content string) blob {
	sum := sha256.Sum256([]byte(content))
	obj := Object{OID: hex.EncodeToString(sum[:]), Size: int64(len(content))}
	return blob{
		data:    []byte(content),
		obj:     obj,
		pointer: fmt.Sprintf("version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %d\n", obj.OID, obj.Size),
	}
}

// pod is a node cache and the clone that the attach makes off it.
type pod struct {
	cache string
	clone string
}

// isolate keeps the host's git config (a `git lfs install` there, say) out of
// the test.
func isolate(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "jr2")
	t.Setenv("GIT_AUTHOR_EMAIL", "jr2@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "jr2")
	t.Setenv("GIT_COMMITTER_EMAIL", "jr2@example.com")
	t.Setenv("JR2_CUSTODIAN_URL", "")
}

func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// makePod commits files (path -> content) to a remote, makes the bare cache
// off it and a `--shared` clone off the cache, with origin's ext:: url and the
// base in the clone's config, as the attach writes them.
func makePod(t *testing.T, files map[string]string) pod {
	t.Helper()
	isolate(t)
	root := t.TempDir()
	remote := filepath.Join(root, "remote")
	run(t, "", "init", "-q", "-b", "main", remote)
	for name, content := range files {
		p := filepath.Join(remote, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run(t, remote, "add", "-A")
	run(t, remote, "commit", "-qm", "first")
	cache := filepath.Join(root, "repos", "app-deadbeef")
	run(t, "", "clone", "-q", "--bare", remote, cache)
	clone := filepath.Join(root, "work", "app", "default")
	run(t, "", "clone", "-q", "--shared", "--no-checkout", cache, clone)
	url := "ext::/opt/jr2/bin/jr2-upload-pack %S " +
		strings.ReplaceAll(strings.ReplaceAll(testIdentity, "%", "%%"), " ", "% ")
	run(t, clone, "remote", "set-url", "origin", "--", url)
	run(t, clone, "config", "jr2.base", "main")
	return pod{cache: cache, clone: clone}
}

// land writes the blob into a store's lfs/objects, as the cache agent does.
func land(t *testing.T, lfsDir string, b blob) {
	t.Helper()
	p := objectPath(lfsDir, b.obj.OID)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, b.data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// custodian is a stand-in for the Custodian, the Orchestrator and the cache
// agent together: it takes the carrier's ask, lands the objects it can by
// writing them into the cache's lfs/objects, and answers.
type custodian struct {
	t      *testing.T
	cache  string
	server *httptest.Server

	mu    sync.Mutex
	asks  []askBody
	held  map[string]blob // what the "remote" can give
	error string          // the answer's error, when set
	code  int             // a status other than 200, when set
	raw   string          // a raw body, when set
}

func newCustodian(t *testing.T, cache string, held ...blob) *custodian {
	c := &custodian{t: t, cache: cache, held: map[string]blob{}}
	for _, b := range held {
		c.held[b.obj.OID] = b
	}
	c.server = httptest.NewServer(http.HandlerFunc(c.serve))
	t.Cleanup(c.server.Close)
	t.Setenv("JR2_CUSTODIAN_URL", c.server.URL)
	return c
}

func (c *custodian) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/fetch" {
		http.Error(w, "wrong route", http.StatusNotFound)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+uploadpack.SandboxTokenStandIn {
		http.Error(w, "wrong bearer", http.StatusUnauthorized)
		return
	}
	body, _ := io.ReadAll(r.Body)
	var ask askBody
	if err := json.Unmarshal(body, &ask); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if n := len(ask.LFS.Objects); n < 1 || n > MaxAskObjects {
		http.Error(w, fmt.Sprintf("%d objects", n), http.StatusBadRequest)
		return
	}
	c.mu.Lock()
	c.asks = append(c.asks, ask)
	code, raw, answerErr := c.code, c.raw, c.error
	for _, obj := range ask.LFS.Objects {
		if b, ok := c.held[obj.OID]; ok {
			land(c.t, filepath.Join(c.cache, "lfs"), b)
		}
	}
	c.mu.Unlock()
	if code != 0 {
		http.Error(w, "the stand-in refuses", code)
		return
	}
	if raw != "" {
		_, _ = io.WriteString(w, raw)
		return
	}
	answer := map[string]any{"answered": "2026-11-07T12:00:00.000Z"}
	if answerErr != "" {
		answer["error"] = answerErr
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"lfs": answer})
}

// set changes the stand-in's answer under its lock: the server reads the
// fields from other goroutines, and in the smudge tests from other processes.
func (c *custodian) set(change func(*custodian)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	change(c)
}

// answerError sets the answer's error.
func (c *custodian) answerError(words string) {
	c.set(func(c *custodian) { c.error = words })
}

func (c *custodian) asked() []askBody {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]askBody(nil), c.asks...)
}
