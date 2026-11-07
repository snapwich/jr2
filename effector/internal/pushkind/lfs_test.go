package pushkind

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/gittest"
	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// lfsRequest is one request that a test's LFS server saw.
type lfsRequest struct {
	Method, Path, Auth, Header string
	// Branch is what the remote's branch held when the request came.
	Branch string
}

// lfsServer is a Git LFS server for one test: the batch API (upload, with a verify action), the
// PUT of each object and its verify. It records every request, and holds what was uploaded.
type lfsServer struct {
	t       *testing.T
	mu      sync.Mutex
	seen    []lfsRequest
	objects map[string][]byte
	// branch reads the remote's branch, for the order of a request and the push.
	branch func() string
	// hrefs is where the batch answer sends a PUT and a verify; "" is the server itself.
	hrefs string
	// want is the Authorization that the batch needs; "" needs none.
	want string
	// refuse answers each object of a batch with an error; hold makes every PUT wait until the
	// test ends.
	refuse bool
	hold   chan struct{}
}

const hrefHeader = "X-Jr2-Href-Header"

func (s *lfsServer) record(r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seen = append(s.seen, lfsRequest{Method: r.Method, Path: r.URL.Path, Auth: r.Header.Get("Authorization"),
		Header: r.Header.Get(hrefHeader), Branch: s.branch()})
}

func (s *lfsServer) requests() []lfsRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]lfsRequest(nil), s.seen...)
}

func (s *lfsServer) held(oid string) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.objects[oid]
}

// batch answers POST <prefix>/objects/batch; base is the url that hrefs start with.
func (s *lfsServer) batch(w http.ResponseWriter, r *http.Request, base string) {
	if s.want != "" && r.Header.Get("Authorization") != s.want {
		w.Header().Set("WWW-Authenticate", `Basic realm="lfs"`)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	var req struct {
		Operation string `json:"operation"`
		Objects   []struct {
			Oid  string `json:"oid"`
			Size int64  `json:"size"`
		} `json:"objects"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Operation != "upload" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	type action struct {
		Href   string            `json:"href"`
		Header map[string]string `json:"header"`
	}
	type objectError struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	type object struct {
		Oid     string            `json:"oid"`
		Size    int64             `json:"size"`
		Actions map[string]action `json:"actions,omitempty"`
		Error   *objectError      `json:"error,omitempty"`
	}
	answer := struct {
		Transfer string   `json:"transfer"`
		Objects  []object `json:"objects"`
	}{Transfer: "basic"}
	if s.hrefs != "" {
		base = s.hrefs
	}
	header := map[string]string{hrefHeader: "from-the-answer"}
	for _, o := range req.Objects {
		obj := object{Oid: o.Oid, Size: o.Size}
		switch {
		case s.refuse:
			obj.Error = &objectError{Code: http.StatusForbidden, Message: "this server takes no upload"}
		case s.held(o.Oid) == nil:
			obj.Actions = map[string]action{
				"upload": {Href: base + "/up/" + o.Oid, Header: header},
				"verify": {Href: base + "/verify/" + o.Oid, Header: header},
			}
		}
		answer.Objects = append(answer.Objects, obj)
	}
	w.Header().Set("Content-Type", "application/vnd.git-lfs+json")
	_ = json.NewEncoder(w).Encode(answer)
}

// href answers a PUT or a verify that a batch answer named.
func (s *lfsServer) href(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/up/"):
		if s.hold != nil {
			<-s.hold
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		oid := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != oid {
			w.WriteHeader(http.StatusUnprocessableEntity)
			return
		}
		s.mu.Lock()
		s.objects[oid] = body
		s.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/verify/"):
		w.WriteHeader(http.StatusOK)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (s *lfsServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.record(r)
	if strings.HasSuffix(r.URL.Path, "/objects/batch") {
		base := "http://" + r.Host
		if r.TLS != nil {
			base = "https://" + r.Host
		}
		s.batch(w, r, base)
		return
	}
	s.href(w, r)
}

func newLFSServer(t *testing.T, f *fixture) *lfsServer {
	return &lfsServer{t: t, objects: map[string][]byte{}, branch: func() string { return remoteRef(f) }}
}

// lfsFixture is a push fixture whose runner has a real git-lfs; it skips without one.
func lfsFixture(t *testing.T, sign string) *fixture {
	t.Helper()
	program, err := exec.LookPath("git-lfs")
	if err != nil {
		t.Skip("no git-lfs")
	}
	f := newFixture(t, sign)
	f.runner.GitLFS = program
	return f
}

// largeFile commits a pointer at name in the Agent's Worktree. With store, the object goes into
// the Agent's lfs/objects, as a smudge or a clean leaves it. It answers the commit and the oid.
func largeFile(t *testing.T, f *fixture, name, content string, store bool) (string, string) {
	t.Helper()
	sum := sha256.Sum256([]byte(content))
	oid := hex.EncodeToString(sum[:])
	if store {
		putObject(t, f.pod.GitDir, oid, []byte(content))
	}
	pointer := fmt.Sprintf("version https://git-lfs.github.com/spec/v1\noid sha256:%s\nsize %d\n", oid, len(content))
	return f.pod.Commit("add "+name, map[string]string{name: pointer}), oid
}

func putObject(t *testing.T, gitDir, oid string, body []byte) {
	t.Helper()
	file := filepath.Join(gitDir, lfsRel(oid))
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, body, 0o644); err != nil {
		t.Fatal(err)
	}
}

// lfsConfigAtBase commits `.lfsconfig` naming server on the remote's main, and brings it into the
// node cache, as the cache agent's fetch does. The push's base is main.
func lfsConfigAtBase(t *testing.T, f *fixture, server string) {
	t.Helper()
	lfsConfigRawAtBase(t, f, "[lfs]\n\turl = "+server+"\n")
}

// lfsConfigRawAtBase commits raw as `.lfsconfig` on the remote's main, and brings it into the
// node cache.
func lfsConfigRawAtBase(t *testing.T, f *fixture, raw string) {
	t.Helper()
	seed := filepath.Join(f.pod.Root, "base-seed")
	gittest.Git(t, f.pod.Root, "clone", "-q", f.pod.Remote, seed)
	if err := os.WriteFile(filepath.Join(seed, ".lfsconfig"), []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	gittest.Git(t, seed, "add", ".lfsconfig")
	gittest.Git(t, seed, "commit", "-qm", "lfs server")
	gittest.Git(t, seed, "push", "-q", "origin", "HEAD:main")
	gittest.Git(t, f.pod.Cache, "fetch", "-q", "origin")
}

func (f *fixture) lfsRequest(sign bool) *wire.StartRequest {
	req := f.request(sign, nil)
	req.Push.Base = "main"
	return req
}

func puts(seen []lfsRequest) []lfsRequest {
	var out []lfsRequest
	for _, r := range seen {
		if r.Method == http.MethodPut {
			out = append(out, r)
		}
	}
	return out
}

func TestANewLargeFileIsUploadedBeforeTheBranchMoves(t *testing.T) {
	f := lfsFixture(t, "")
	lfs := newLFSServer(t, f)
	srv := httptest.NewServer(lfs)
	t.Cleanup(srv.Close)
	lfsConfigAtBase(t, f, srv.URL+"/lfs")
	before := remoteRef(f)
	content := "a large file's bytes\n"
	sha, oid := largeFile(t, f, "assets/big.bin", content, true)

	out := f.runner.Run(t.Context(), f.lfsRequest(false))
	if out.Outcome != wire.OutcomePushed || out.Push.Published != sha {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if string(lfs.held(oid)) != content {
		t.Fatalf("the server holds %q", lfs.held(oid))
	}
	for _, r := range lfs.requests() {
		if strings.Contains(r.Path, "/locks") {
			t.Fatalf("the push asked about locks: %+v", r)
		}
	}
	p := puts(lfs.requests())
	if len(p) != 1 || p[0].Path != "/up/"+oid {
		t.Fatalf("PUTs: %+v", p)
	}
	if p[0].Branch != before {
		t.Fatalf("the branch moved before the upload: it held %q", p[0].Branch)
	}
	if remoteRef(f) != sha {
		t.Fatal("the branch did not move after the upload")
	}

	// Pushed again: the remote holds it, so nothing is uploaded.
	n := len(lfs.requests())
	again := f.runner.Run(t.Context(), f.lfsRequest(false))
	if again.Outcome != wire.OutcomePushed || !again.Push.Unchanged {
		t.Fatalf("again: %+v %+v", again, again.Push)
	}
	if len(lfs.requests()) != n {
		t.Fatalf("an unchanged push spoke to the LFS server: %+v", lfs.requests()[n:])
	}

	// A next commit that keeps the file and adds none: no pointer is new, so no git-lfs runs.
	f.pod.Commit("small", map[string]string{"notes.txt": "n\n"})
	if next := f.runner.Run(t.Context(), f.lfsRequest(false)); next.Outcome != wire.OutcomePushed {
		t.Fatalf("next: %+v %+v", next, next.Push)
	}
	if len(lfs.requests()) != n {
		t.Fatalf("a push of no new pointer spoke to the LFS server: %+v", lfs.requests()[n:])
	}
}

func TestAnObjectOnlyTheNodeCacheHoldsIsUploaded(t *testing.T) {
	f := lfsFixture(t, "")
	lfs := newLFSServer(t, f)
	srv := httptest.NewServer(lfs)
	t.Cleanup(srv.Close)
	lfsConfigAtBase(t, f, srv.URL+"/lfs")
	content := "held by the node cache\n"
	sha, oid := largeFile(t, f, "big.bin", content, false)
	putObject(t, f.pod.Cache, oid, []byte(content))

	out := f.runner.Run(t.Context(), f.lfsRequest(false))
	if out.Outcome != wire.OutcomePushed || out.Push.Published != sha || string(lfs.held(oid)) != content {
		t.Fatalf("got %+v %+v, the server holds %q", out, out.Push, lfs.held(oid))
	}
}

func TestAnObjectTheAgentLacksIsRejectedAndTheBranchDoesNotMove(t *testing.T) {
	f := lfsFixture(t, "")
	lfs := newLFSServer(t, f)
	srv := httptest.NewServer(lfs)
	t.Cleanup(srv.Close)
	lfsConfigAtBase(t, f, srv.URL+"/lfs")
	before := remoteRef(f)
	largeFile(t, f, "assets/missing.bin", "never stored\n", false)

	out := f.runner.Run(t.Context(), f.lfsRequest(false))
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "upload" ||
		!strings.Contains(out.Reason, "assets/missing.bin") || !strings.Contains(out.Reason, "nothing was pushed") {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != before {
		t.Fatal("the branch moved")
	}
	if len(lfs.requests()) != 0 {
		t.Fatalf("the LFS server was asked: %+v", lfs.requests())
	}
}

func TestACorruptedObjectIsRejected(t *testing.T) {
	f := lfsFixture(t, "")
	lfs := newLFSServer(t, f)
	srv := httptest.NewServer(lfs)
	t.Cleanup(srv.Close)
	lfsConfigAtBase(t, f, srv.URL+"/lfs")
	before := remoteRef(f)
	content := "the real bytes\n"
	_, oid := largeFile(t, f, "big.bin", content, false)
	// The same size, other bytes: only the hash can see it.
	putObject(t, f.pod.GitDir, oid, []byte(strings.ToUpper(content)))

	out := f.runner.Run(t.Context(), f.lfsRequest(false))
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "upload" ||
		!strings.Contains(out.Reason, "big.bin") || !strings.Contains(out.Reason, "does not match its oid") {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != before || lfs.held(oid) != nil {
		t.Fatal("the branch moved, or the object went up")
	}
}

func TestAnObjectFileThatIsASymlinkIsNotFollowed(t *testing.T) {
	f := lfsFixture(t, "")
	lfs := newLFSServer(t, f)
	srv := httptest.NewServer(lfs)
	t.Cleanup(srv.Close)
	lfsConfigAtBase(t, f, srv.URL+"/lfs")
	content := "outside the git dir\n"
	_, oid := largeFile(t, f, "big.bin", content, false)
	outside := filepath.Join(f.pod.Root, "outside")
	if err := os.WriteFile(outside, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(f.pod.GitDir, lfsRel(oid))
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, file); err != nil {
		t.Fatal(err)
	}
	out := f.runner.Run(t.Context(), f.lfsRequest(false))
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "upload" || lfs.held(oid) != nil ||
		!strings.Contains(out.Reason, "the Agent's file was refused") || !strings.Contains(out.Reason, "symlink") {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
}

// A hard link may be a file outside the git dir: the opener refuses it, and the reason says why.
func TestAnObjectFileWithTwoLinksIsRefusedAndTheReasonSaysWhy(t *testing.T) {
	f := lfsFixture(t, "")
	lfs := newLFSServer(t, f)
	srv := httptest.NewServer(lfs)
	t.Cleanup(srv.Close)
	lfsConfigAtBase(t, f, srv.URL+"/lfs")
	content := "linked twice\n"
	_, oid := largeFile(t, f, "big.bin", content, true)
	if err := os.Link(filepath.Join(f.pod.GitDir, lfsRel(oid)), filepath.Join(f.pod.Root, "second-link")); err != nil {
		t.Fatal(err)
	}
	out := f.runner.Run(t.Context(), f.lfsRequest(false))
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "upload" || lfs.held(oid) != nil ||
		!strings.Contains(out.Reason, "big.bin") || !strings.Contains(out.Reason, "hard links") {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
}

// An include.path in the base's .lfsconfig is not followed: the Effector reads no other file as
// config, so the lfs.url that the Agent writes in its own config is not the server.
func TestAnIncludeInTheBasesLFSConfigIsNotFollowed(t *testing.T) {
	f := lfsFixture(t, "")
	lfs := newLFSServer(t, f)
	srv := httptest.NewServer(lfs)
	t.Cleanup(srv.Close)
	agentConfig := filepath.Join(f.pod.GitDir, "config")
	// The include comes last, so, if git followed it, its lfs.url would be the value.
	lfsConfigRawAtBase(t, f, "[lfs]\n\turl = "+srv.URL+"/lfs\n[include]\n\tpath = "+agentConfig+"\n")
	gittest.Git(t, f.pod.GitDir, "--git-dir="+f.pod.GitDir, "config", "lfs.url", srv.URL+"/chosen-by-the-agent")
	content := "the base names the server\n"
	_, oid := largeFile(t, f, "big.bin", content, true)

	out := f.runner.Run(t.Context(), f.lfsRequest(false))
	if out.Outcome != wire.OutcomePushed || string(lfs.held(oid)) != content {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	for _, r := range lfs.requests() {
		if !strings.HasPrefix(r.Path, "/lfs/") && !strings.HasPrefix(r.Path, "/up/") &&
			!strings.HasPrefix(r.Path, "/verify/") {
			t.Fatalf("a request went where the Agent's config said: %+v", r)
		}
	}
}

func TestASquashedPushUploadsTheSameObject(t *testing.T) {
	f := lfsFixture(t, "ssh")
	lfs := newLFSServer(t, f)
	srv := httptest.NewServer(lfs)
	t.Cleanup(srv.Close)
	lfsConfigAtBase(t, f, srv.URL+"/lfs")
	content := "squashed and large\n"
	sha, oid := largeFile(t, f, "big.bin", content, true)
	f.pod.Commit("more", map[string]string{"n.txt": "n\n"})
	req := f.lfsRequest(true)
	msg := "one squashed commit"
	req.Push.Squash = &msg

	out := f.runner.Run(t.Context(), req)
	if out.Outcome != wire.OutcomePushed || out.Push.Published == sha {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if string(lfs.held(oid)) != content {
		t.Fatalf("the server holds %q", lfs.held(oid))
	}
	if p := puts(lfs.requests()); len(p) != 1 || p[0].Branch == out.Push.Published {
		t.Fatalf("PUTs: %+v", p)
	}
}

// An ssh LFS server is accepted only on the host of an ssh push url, so the push's ssh key goes
// to no other host (ADR-0051's LFS rule).
func TestAnSSHLFSServerIsAcceptedOnlyOnThePushURLsHost(t *testing.T) {
	ssh := &call{spec: &wire.PushSpec{URL: "git@github.com:ourorg/app.git"}}
	sshURL := &call{spec: &wire.PushSpec{URL: "ssh://git@GitHub.com:22/ourorg/app.git"}}
	https := &call{spec: &wire.PushSpec{URL: "https://github.com/ourorg/app.git"}}
	for _, tc := range []struct {
		c    *call
		lfs  string
		want bool
	}{
		{ssh, "ssh://git@github.com/ourorg/app.git", true},
		{ssh, "git@GITHUB.com:ourorg/app.git", true},
		{sshURL, "git@github.com:ourorg/app.git", true},
		{ssh, "git+ssh://git@github.com/ourorg/app.git", true},
		{ssh, "https://lfs.example/x", true},
		{https, "https://lfs.example/x", true},
		{ssh, "ssh://git@evil.example/x.git", false},
		{ssh, "git@evil.example:x.git", false},
		{sshURL, "ssh://git@evil.example/x.git", false},
		{https, "ssh://git@github.com/ourorg/app.git", false},
		{https, "git@github.com:ourorg/app.git", false},
		{ssh, "ssh://-oProxyCommand=x/y", false},
		{ssh, "-oProxyCommand=x:y", false},
		{ssh, "ssh://git@github.com;x/y", false},
		{ssh, "file:///work/x", false},
		{ssh, "/work/x", false},
		{ssh, "ext::sh -c x", false},
		{ssh, "https://lfs.example/x y", false},
	} {
		if got := tc.c.lfsSchemeAllowed(tc.lfs); got != tc.want {
			t.Errorf("push %s, LFS %q: got %v, want %v", tc.c.spec.URL, tc.lfs, got, tc.want)
		}
	}
}

func TestAServerThatRefusesTheUploadIsRejectedAndTheBranchDoesNotMove(t *testing.T) {
	f := lfsFixture(t, "")
	lfs := newLFSServer(t, f)
	lfs.refuse = true
	srv := httptest.NewServer(lfs)
	t.Cleanup(srv.Close)
	lfsConfigAtBase(t, f, srv.URL+"/lfs")
	before := remoteRef(f)
	largeFile(t, f, "big.bin", "refused\n", true)

	out := f.runner.Run(t.Context(), f.lfsRequest(false))
	t.Logf("%s | %s", out.Reason, out.Push.Detail)
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "upload" || !strings.Contains(out.Reason, "big.bin") ||
		!strings.Contains(out.Push.Detail, "this server takes no upload") {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != before {
		t.Fatal("the branch moved")
	}
}

func TestAnUploadThatOutlivesTheTimeoutIsRejectedAndTheBranchDoesNotMove(t *testing.T) {
	f := lfsFixture(t, "")
	lfs := newLFSServer(t, f)
	lfs.hold = make(chan struct{})
	srv := httptest.NewServer(lfs)
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(lfs.hold) })
	lfsConfigAtBase(t, f, srv.URL+"/lfs")
	before := remoteRef(f)
	largeFile(t, f, "slow.bin", "slow\n", true)

	req := f.lfsRequest(false)
	req.TimeoutMs = 5_000
	start := time.Now()
	out := f.runner.Run(t.Context(), req)
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "upload" || !strings.Contains(out.Reason, "timeout") {
		t.Fatalf("got %+v %+v after %s", out, out.Push, time.Since(start))
	}
	if remoteRef(f) != before {
		t.Fatal("the branch moved")
	}
}

func TestASignedPushUploadsTheSameObject(t *testing.T) {
	f := lfsFixture(t, "ssh")
	lfs := newLFSServer(t, f)
	srv := httptest.NewServer(lfs)
	t.Cleanup(srv.Close)
	lfsConfigAtBase(t, f, srv.URL+"/lfs")
	content := "signed and large\n"
	sha, oid := largeFile(t, f, "big.bin", content, true)

	out := f.runner.Run(t.Context(), f.lfsRequest(true))
	if out.Outcome != wire.OutcomePushed || out.Push.Source != sha || out.Push.Published == sha {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if string(lfs.held(oid)) != content {
		t.Fatalf("the server holds %q", lfs.held(oid))
	}
	if p := puts(lfs.requests()); len(p) != 1 || p[0].Branch == out.Push.Published {
		t.Fatalf("PUTs: %+v", p)
	}
}

func TestAPushWithNoPointerStartsNoGitLFS(t *testing.T) {
	f := newFixture(t, "")
	marker := filepath.Join(f.pod.Root, "git-lfs-ran")
	fake := filepath.Join(f.pod.Root, "fake-git-lfs")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\ntouch '"+marker+"'\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	f.runner.GitLFS = fake
	// A small blob that looks almost like a pointer is not one.
	sha := f.pod.Commit("work", map[string]string{"a.txt": "a\n",
		"near.txt": "version https://git-lfs.github.com/spec/v1\noid sha256:xyz\nsize 3\n"})
	out := f.push(false, nil)
	if out.Outcome != wire.OutcomePushed || out.Push.Published != sha {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("git-lfs ran for a push with no pointer")
	}
}

// One TLS server is the Binding's host: git's smart HTTP, and the LFS server that git-lfs derives
// from the push url, each of which needs the token. The batch answer sends each href to a second
// TLS server, on another port, so another origin.
func TestAnHTTPSTokenGoesToTheBindingsHostOnlyAndAnHrefGetsOnlyTheAnswersHeaders(t *testing.T) {
	f := lfsFixture(t, "")
	backend := ""
	for _, dir := range []string{"/usr/lib/git-core", "/usr/libexec/git-core"} {
		if _, err := os.Stat(filepath.Join(dir, "git-http-backend")); err == nil {
			backend = filepath.Join(dir, "git-http-backend")
		}
	}
	if backend == "" {
		t.Skip("no git-http-backend")
	}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte(HelperUser+":"+token))
	lfs := newLFSServer(t, f)
	// The same LFS server answers on a second listener: another origin, which the hrefs name.
	other := httptest.NewTLSServer(lfs)
	t.Cleanup(other.Close)
	lfs.want, lfs.hrefs = want, other.URL
	git := &cgi.Handler{Path: backend, Env: []string{"GIT_PROJECT_ROOT=" + filepath.Dir(f.pod.Remote),
		"GIT_HTTP_EXPORT_ALL=1", "REMOTE_USER=bot", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1"}}
	var mu sync.Mutex
	var gitAuth []string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/info/lfs/") {
			lfs.ServeHTTP(w, r)
			return
		}
		mu.Lock()
		gitAuth = append(gitAuth, r.Header.Get("Authorization"))
		mu.Unlock()
		if r.Header.Get("Authorization") != want {
			w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		git.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	if err := os.WriteFile(filepath.Join(f.runner.GitRoot, "push", secrets.TokenFile), []byte(token+"\n"), 0o400); err != nil {
		t.Fatal(err)
	}
	ca := filepath.Join(f.pod.Root, "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o644); err != nil {
		t.Fatal(err)
	}
	f.runner.CAFile = ca
	f.runner.Scrubber = scrub.New(map[string]string{"git:push/token": token})
	content := "over https\n"
	sha, oid := largeFile(t, f, "big.bin", content, true)

	req := f.request(false, nil)
	req.Push.URL = srv.URL + "/" + filepath.Base(f.pod.Remote)
	out := f.runner.Run(t.Context(), req)
	if out.Outcome != wire.OutcomePushed || out.Push.Published != sha {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if string(lfs.held(oid)) != content {
		t.Fatalf("the server holds %q", lfs.held(oid))
	}
	batchWithToken := false
	var seen []lfsRequest
	for _, r := range lfs.requests() {
		if strings.HasSuffix(r.Path, "/objects/batch") {
			batchWithToken = batchWithToken || r.Auth == want
			continue
		}
		seen = append(seen, r)
	}
	if !batchWithToken {
		t.Fatalf("the Binding's LFS server never got the token: %+v", lfs.requests())
	}
	if len(seen) == 0 {
		t.Fatal("no href was asked")
	}
	for _, r := range seen {
		if r.Auth != "" {
			t.Fatalf("an href on another host got an Authorization: %+v", r)
		}
		if r.Header != "from-the-answer" {
			t.Fatalf("an href did not get the answer's header: %+v", r)
		}
	}
	if puts(seen)[0].Branch == sha {
		t.Fatal("the branch moved before the upload")
	}
	encoded, _ := wire.Encode(out)
	if strings.Contains(string(encoded), "tok-") {
		t.Fatalf("a token reached the output: %s", encoded)
	}
}

// A private LFS server that `.lfsconfig` names on another host gets no token: the upload fails
// with git-lfs's words, and nothing is pushed.
func TestAnLFSServerOnAnotherHostGetsNoToken(t *testing.T) {
	f := lfsFixture(t, "")
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte(HelperUser+":"+token))
	lfs := newLFSServer(t, f)
	lfs.want = want
	foreign := httptest.NewTLSServer(lfs)
	t.Cleanup(foreign.Close)
	srv, _ := tokenServer(t, filepath.Dir(f.pod.Remote))
	if err := os.WriteFile(filepath.Join(f.runner.GitRoot, "push", secrets.TokenFile), []byte(token+"\n"), 0o400); err != nil {
		t.Fatal(err)
	}
	ca := filepath.Join(f.pod.Root, "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o644); err != nil {
		t.Fatal(err)
	}
	f.runner.CAFile = ca
	lfsConfigAtBase(t, f, foreign.URL+"/lfs")
	before := remoteRef(f)
	largeFile(t, f, "big.bin", "private\n", true)

	req := f.lfsRequest(false)
	req.Push.URL = srv.URL + "/" + filepath.Base(f.pod.Remote)
	out := f.runner.Run(t.Context(), req)
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "upload" {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	for _, r := range lfs.requests() {
		if r.Auth != "" {
			t.Fatalf("the LFS server on another host got an Authorization: %+v", r)
		}
	}
	if remoteRef(f) != before {
		t.Fatal("the branch moved")
	}
}

func TestParsePointerTakesOnlyAPointer(t *testing.T) {
	oid := strings.Repeat("ab", 32)
	good := "version https://git-lfs.github.com/spec/v1\noid sha256:" + oid + "\nsize 12\n"
	if o, ok := parsePointer([]byte(good)); !ok || o.oid != oid || o.size != 12 {
		t.Fatalf("got %+v %v", o, ok)
	}
	for _, bad := range []string{
		strings.TrimSuffix(good, "\n"),
		strings.Replace(good, "size 12", "size -1", 1),
		strings.Replace(good, "size 12", "size 012", 1),
		strings.Replace(good, oid, strings.ToUpper(oid), 1),
		strings.Replace(good, "spec/v1", "spec/v2", 1),
		good + "extra\n",
		strings.Replace(good, "\noid", "\next-x-foo sha256:"+oid+"\noid", 1),
		strings.Replace(good, "\noid", "\next-0-foo sha256:short\noid", 1),
	} {
		if _, ok := parsePointer([]byte(bad)); ok {
			t.Fatalf("%q read as a pointer", bad)
		}
	}
	// The spec's extension lines come between the version and the oid.
	ext := strings.Replace(good, "\noid", "\next-0-foo sha256:"+strings.Repeat("cd", 32)+"\noid", 1)
	if o, ok := parsePointer([]byte(ext)); !ok || o.oid != oid || o.size != 12 {
		t.Fatalf("an extension pointer: got %+v %v", o, ok)
	}
}
