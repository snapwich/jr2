/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package uploadpack

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The answer's keys, and the stand-in timestamps the tests date a cache with.
const (
	keyFetched = "fetched"
	keyStale   = "stale"
	keyAsOf    = "asOf"
	someTime   = "2026-09-13T12:00:00.000Z"
	earlier    = "2026-09-13T11:55:00.000Z"
	someURL    = "http://127.0.0.1:7777"
	identity   = "github.com/acme/app"
)

// A pod's checkouts, built for real: a bare cache the way the cache agent
// leaves one, the `git clone --shared` the attach makes off it, and the branch
// worktree beside it (ADR-0004's Project layout). The alternates discovery is
// the one part of this program that reads git's own bookkeeping, so it is
// tested against git's own bookkeeping.
type pod struct {
	cache    string // the "node cache": /repos/<key>
	dflt     string // the pod-local clone: <slot>/default
	worktree string // the branch worktree beside it
}

func layout(t *testing.T) pod {
	t.Helper()
	requireGit(t)
	root := t.TempDir()
	remote := filepath.Join(root, "remote")
	git(t, "", "init", "-q", "-b", "main", remote)
	if err := os.WriteFile(filepath.Join(remote, "README"), []byte("j2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, remote, "add", "README")
	git(t, remote, "commit", "-qm", "first")

	cache := filepath.Join(root, "repos", "app-deadbeef")
	git(t, "", "clone", "-q", "--bare", remote, cache)

	slot := filepath.Join(root, "work", "app")
	if err := os.MkdirAll(slot, 0o755); err != nil {
		t.Fatal(err)
	}
	dflt := filepath.Join(slot, "default")
	git(t, "", "clone", "-q", "--shared", cache, dflt)
	worktree := filepath.Join(slot, "feature")
	git(t, dflt, "worktree", "add", "-q", worktree, "-b", "feature")

	return pod{cache: cache, dflt: dflt, worktree: worktree}
}

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH")
	}
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_AUTHOR_NAME=j2", "GIT_AUTHOR_EMAIL=j2@example.invalid",
		"GIT_COMMITTER_NAME=j2", "GIT_COMMITTER_EMAIL=j2@example.invalid",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func TestCacheDirIsFoundFromTheCloneAndFromTheWorktree(t *testing.T) {
	p := layout(t)
	for name, dir := range map[string]string{"clone": p.dflt, "worktree": p.worktree} {
		t.Run(name, func(t *testing.T) {
			got, err := CacheDir(dir)
			if err != nil {
				t.Fatalf("CacheDir(%s): %v", dir, err)
			}
			if got != p.cache {
				t.Fatalf("CacheDir(%s) = %q, want %q", dir, got, p.cache)
			}
		})
	}
}

func TestCacheDirRefusesACheckoutThatBorrowsFromNoCache(t *testing.T) {
	requireGit(t)
	alone := filepath.Join(t.TempDir(), "alone")
	git(t, "", "init", "-q", "-b", "main", alone)
	if _, err := CacheDir(alone); err == nil || !strings.Contains(err.Error(), "borrows from no node cache") {
		t.Fatalf("CacheDir(a plain repo) = %v, want a no-cache error", err)
	}
	notARepo := t.TempDir()
	if _, err := CacheDir(notARepo); err == nil || !strings.Contains(err.Error(), "not a git checkout") {
		t.Fatalf("CacheDir(a plain directory) = %v, want a not-a-checkout error", err)
	}
}

// The exec boundary: what the program would have become.
type exec1 struct {
	path string
	argv []string
	env  []string
	ran  bool
}

func (e *exec1) fn(path string, argv []string, env []string) error {
	e.path, e.argv, e.env, e.ran = path, argv, env, true
	return nil
}

// adapter stands in for the loopback Adapter: it records the body it was asked
// with and answers what the test names.
func adapter(t *testing.T, status int, body any) (*httptest.Server, *string) {
	t.Helper()
	asked := new(string)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/fetch" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		read, _ := io.ReadAll(r.Body)
		*asked = string(read)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		switch b := body.(type) {
		case string:
			_, _ = io.WriteString(w, b)
		default:
			_ = json.NewEncoder(w).Encode(b)
		}
	}))
	t.Cleanup(server.Close)
	return server, asked
}

func run(t *testing.T, p pod, args []string, env []string, client *http.Client) (int, string, *exec1) {
	t.Helper()
	e := &exec1{}
	var stderr bytes.Buffer
	code := Run(Options{
		Args:   args,
		Dir:    p.worktree,
		Env:    env,
		Getenv: func(string) string { return "" },
		Stderr: &stderr,
		Client: client,
		Exec:   e.fn,
	})
	return code, stderr.String(), e
}

func TestAFetchThatLandsExecsUploadPackOnTheCacheAndSaysNothing(t *testing.T) {
	p := layout(t)
	server, asked := adapter(t, http.StatusOK, map[string]any{keyFetched: someTime})

	code, stderr, e := run(t, p, []string{ServiceUploadPack, identity, server.URL}, nil, server.Client())

	if code != 0 {
		t.Fatalf("exit %d, want 0", code)
	}
	if stderr != "" {
		t.Fatalf("stderr = %q, want nothing said", stderr)
	}
	if *asked != `{"identity":"`+identity+`"}` {
		t.Fatalf("the ask carried %q", *asked)
	}
	if !e.ran {
		t.Fatal("nothing was exec'd")
	}
	if want := []string{"git", "upload-pack", p.cache}; !slices.Equal(e.argv, want) {
		t.Fatalf("argv = %q, want %q", e.argv, want)
	}
	if filepath.Base(e.path) != "git" {
		t.Fatalf("exec'd %q, want git", e.path)
	}
}

func TestAStaleAnswerWarnsOnceAndServesTheCacheAnyway(t *testing.T) {
	p := layout(t)
	server, _ := adapter(t, http.StatusOK, map[string]any{
		keyStale: "fatal: could not read Username for 'https://github.com'",
		keyAsOf:  earlier,
	})

	code, stderr, e := run(t, p, []string{ServiceUploadPack, identity, server.URL}, nil, server.Client())

	if code != 0 || !e.ran {
		t.Fatalf("exit %d, exec'd %v — a failed ask must still serve the cache", code, e.ran)
	}
	want := "warning: j2: remote fetch failed (fatal: could not read Username for 'https://github.com'); " +
		"serving the cache as of " + earlier + "\n"
	if stderr != want {
		t.Fatalf("stderr =\n%q\nwant\n%q", stderr, want)
	}
}

func TestAStaleAnswerWithNoTimeSaysTheCacheIsOfAnUnknownTime(t *testing.T) {
	p := layout(t)
	server, _ := adapter(t, http.StatusOK, map[string]any{keyStale: "the cache has never been fetched", keyAsOf: nil})

	_, stderr, e := run(t, p, []string{ServiceUploadPack, identity, server.URL}, nil, server.Client())

	want := "warning: j2: remote fetch failed (the cache has never been fetched); serving the cache as of an unknown time\n"
	if stderr != want || !e.ran {
		t.Fatalf("stderr = %q (exec'd %v), want %q", stderr, e.ran, want)
	}
}

func TestEveryOtherAnswerIsAlsoOneWarningAndTheSameExec(t *testing.T) {
	p := layout(t)
	cases := map[string]struct {
		status int
		body   any
		reason string
	}{
		"a status that is not 200": {http.StatusForbidden, "not this Sandbox's Repo", "the adapter answered 403 Forbidden: not this Sandbox's Repo"},
		"a body that is not json":  {http.StatusOK, "<html>nope</html>", "the adapter's answer is not the shape j2 speaks:"},
		"a body that names neither": {http.StatusOK, map[string]any{},
			"the adapter's answer named neither a fetch nor a staleness"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			server, _ := adapter(t, c.status, c.body)
			code, stderr, e := run(t, p, []string{ServiceUploadPack, identity, server.URL}, nil, server.Client())
			if code != 0 || !e.ran {
				t.Fatalf("exit %d, exec'd %v — freshness degrades, absence does not", code, e.ran)
			}
			if !strings.HasPrefix(stderr, "warning: j2: remote fetch failed ("+c.reason) ||
				!strings.HasSuffix(stderr, "serving the cache as of an unknown time\n") {
				t.Fatalf("stderr = %q, want a warning naming %q", stderr, c.reason)
			}
			if strings.Count(stderr, "\n") != 1 {
				t.Fatalf("stderr = %q, want exactly one line", stderr)
			}
		})
	}
}

func TestAnAdapterThatCannotBeReachedIsOneWarningAndTheSameExec(t *testing.T) {
	p := layout(t)
	server, _ := adapter(t, http.StatusOK, map[string]any{keyFetched: someTime})
	url := server.URL
	server.Close() // nothing is listening any more

	code, stderr, e := run(t, p, []string{ServiceUploadPack, identity, url}, nil, http.DefaultClient)

	if code != 0 || !e.ran {
		t.Fatalf("exit %d, exec'd %v — a dead Adapter must not fail a fetch", code, e.ran)
	}
	if !strings.HasPrefix(stderr, "warning: j2: remote fetch failed (") ||
		!strings.HasSuffix(stderr, "serving the cache as of an unknown time\n") ||
		strings.Count(stderr, "\n") != 1 {
		t.Fatalf("stderr = %q, want one warning line", stderr)
	}
}

func TestOnlyTheTwoReadsAreServed(t *testing.T) {
	p := layout(t)
	code, stderr, e := run(t, p, []string{"git-receive-pack", identity}, nil, http.DefaultClient)
	if code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if e.ran {
		t.Fatal("a push must not reach the cache")
	}
	if !strings.Contains(stderr, "git-receive-pack") || !strings.Contains(stderr, ServiceUploadPack) ||
		!strings.Contains(stderr, ServiceUploadArchive) {
		t.Fatalf("stderr = %q, want it to name the service asked for and the ones served", stderr)
	}
}

// `git archive --remote=origin` asks for the OTHER read, and it read the cache
// directly while `origin` was a path (ADR-0053). It goes through the same ask
// and the same cache, so the export is of the remote's now.
func TestAnArchiveAsksTheSameAndExecsUploadArchiveOnTheCache(t *testing.T) {
	p := layout(t)
	server, asked := adapter(t, http.StatusOK, map[string]any{keyFetched: someTime})

	code, stderr, e := run(t, p, []string{ServiceUploadArchive, identity, server.URL}, nil, server.Client())

	if code != 0 || stderr != "" {
		t.Fatalf("exit %d, stderr %q — a landed fetch says nothing", code, stderr)
	}
	if *asked != `{"identity":"`+identity+`"}` {
		t.Fatalf("the ask carried %q", *asked)
	}
	if want := []string{"git", "upload-archive", p.cache}; !slices.Equal(e.argv, want) {
		t.Fatalf("argv = %q, want %q", e.argv, want)
	}
}

func TestTooFewArgumentsPrintsTheUsage(t *testing.T) {
	p := layout(t)
	code, stderr, e := run(t, p, []string{ServiceUploadPack}, nil, http.DefaultClient)
	if code != 1 || e.ran {
		t.Fatalf("exit %d, exec'd %v, want 1 and nothing exec'd", code, e.ran)
	}
	if stderr != "usage: j2-upload-pack <service> <identity> [adapter-url]\n" {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestACheckoutWithNoCacheFailsRatherThanServingSomethingElse(t *testing.T) {
	server, _ := adapter(t, http.StatusOK, map[string]any{keyFetched: someTime})
	e := &exec1{}
	var stderr bytes.Buffer
	code := Run(Options{
		Args:   []string{ServiceUploadPack, identity, server.URL},
		Dir:    t.TempDir(),
		Getenv: func(string) string { return "" },
		Stderr: &stderr,
		Client: server.Client(),
		Exec:   e.fn,
	})
	if code != 1 || e.ran {
		t.Fatalf("exit %d, exec'd %v, want 1 and nothing exec'd", code, e.ran)
	}
}

func TestUploadPackServesTheCacheAndNotTheCallersOwnRepository(t *testing.T) {
	p := layout(t)
	server, _ := adapter(t, http.StatusOK, map[string]any{keyFetched: someTime})

	env := []string{
		"GIT_DIR=" + filepath.Join(p.dflt, ".git", "worktrees", "feature"),
		"GIT_WORK_TREE=" + p.worktree,
		"GIT_ALTERNATE_OBJECT_DIRECTORIES=" + filepath.Join(p.cache, "objects"),
		"GIT_PROTOCOL=version=2",
		"PATH=/usr/bin:/bin",
	}
	_, _, e := run(t, p, []string{ServiceUploadPack, identity, server.URL}, env, server.Client())

	for _, gone := range []string{"GIT_DIR=", "GIT_WORK_TREE=", "GIT_ALTERNATE_OBJECT_DIRECTORIES="} {
		for _, entry := range e.env {
			if strings.HasPrefix(entry, gone) {
				t.Fatalf("%s survived into the server subcommand's environment: it would serve the caller's own repository", gone)
			}
		}
	}
	if !slices.Contains(e.env, "GIT_PROTOCOL=version=2") {
		t.Fatal("GIT_PROTOCOL was dropped: it names no repository, and a caller that exported one meant it")
	}
	if !slices.Contains(e.env, "PATH=/usr/bin:/bin") {
		t.Fatal("the rest of the environment must survive")
	}
}

func TestTheAdapterUrlIsTheArgumentThenTheEnvironmentThenLoopback(t *testing.T) {
	cases := []struct {
		name string
		args []string
		env  string
		want string
	}{
		{"the third argument wins", []string{ServiceUploadPack, "id", "http://127.0.0.1:9999"}, someURL, "http://127.0.0.1:9999"},
		{"then the environment", []string{ServiceUploadPack, "id"}, someURL, someURL},
		{"then the loopback default", []string{ServiceUploadPack, "id"}, "", DefaultAdapterURL},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := adapterURL(Options{Args: c.args, Getenv: func(string) string { return c.env }})
			if got != c.want {
				t.Fatalf("adapterURL = %q, want %q", got, c.want)
			}
		})
	}
}

func TestTheWarningIsAlwaysOneLine(t *testing.T) {
	p := layout(t)
	server, _ := adapter(t, http.StatusOK, map[string]any{keyStale: "fatal: bad\nremote: and more\n", keyAsOf: earlier})
	_, stderr, _ := run(t, p, []string{ServiceUploadPack, identity, server.URL}, nil, server.Client())
	if strings.Count(stderr, "\n") != 1 {
		t.Fatalf("stderr = %q, want exactly one line", stderr)
	}
	if !strings.Contains(stderr, "(fatal: bad remote: and more)") {
		t.Fatalf("stderr = %q, want git's words folded onto one line", stderr)
	}
}
