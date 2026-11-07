/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package repocache

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

// recGit runs the real git and records each call's arguments.
type recGit struct {
	inner Git
	calls [][]string
}

func (g *recGit) Run(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	g.calls = append(g.calls, args)
	return g.inner.Run(ctx, dir, env, args...)
}

// lfsFetches counts the `git lfs fetch` calls.
func (g *recGit) lfsFetches() int {
	n := 0
	for _, c := range g.calls {
		if i := slices.Index(c, "lfs"); i >= 0 && i+1 < len(c) && c[i+1] == "fetch" {
			n++
		}
	}
	return n
}

// requireGitLFS skips a test when git-lfs is not on PATH, and keeps git away
// from the host's own config.
func requireGitLFS(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git-lfs"); err != nil {
		t.Skip("git-lfs is not on PATH")
	}
	home := t.TempDir()
	global := filepath.Join(home, "gitconfig")
	if err := os.WriteFile(global, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	for _, k := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"} {
		t.Setenv(k, "")
	}
	t.Setenv("NO_PROXY", "*")
	t.Setenv("no_proxy", "*")
}

// gitT runs git for a test fixture.
func gitT(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// lfsWorld is an LFS server (a git repository whose `.git/lfs/objects` git-lfs
// reads through a file:// url), the Repo that names it, and a node cache
// cloned from it, with this node's entry present and fresh: the git refresh
// is not due, so every Reconcile returns from it early.
type lfsWorld struct {
	a      *Agent
	git    *recGit
	server string
	cache  string
}

func newLFSWorld(t *testing.T) *lfsWorld {
	t.Helper()
	requireGitLFS(t)
	server := filepath.Join(t.TempDir(), "server")
	gitT(t, "", "init", "-q", "-b", "main", server)
	if err := os.WriteFile(filepath.Join(server, "README"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, server, "add", "README")
	gitT(t, server, "commit", "-q", "-m", "init")

	r := repo(1, corev1alpha1.RepoNodeStatus{
		Node: node, Present: true, Synced: true, Attempted: corev1alpha1.RepoAttemptFetch,
		ObservedGeneration: 1, LastAttempt: ts(fixedNow), LastFetched: ts(fixedNow),
	})
	r.Spec.URL = "file://" + server
	git := &recGit{inner: ExecGit()}
	a := newAgent(t, &fakeGit{}, r)
	a.Git = git
	cache := a.dir(key)
	gitT(t, "", "clone", "-q", "--bare", "file://"+server, cache)
	return &lfsWorld{a: a, git: git, server: server, cache: cache}
}

// put stores content as an LFS object in a git repository's own store (a
// server's, or a cache's) and gives its oid and size.
func put(t *testing.T, gitDir, content string) corev1alpha1.LFSObject {
	t.Helper()
	sum := sha256.Sum256([]byte(content))
	oid := hex.EncodeToString(sum[:])
	p := filepath.Join(gitDir, "lfs", "objects", oid[0:2], oid[2:4], oid)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return corev1alpha1.LFSObject{OID: oid, Size: int64(len(content))}
}

// askJSON is a `jr2.dev/lfs-<key>` value.
func askJSON(at, base string, objects ...corev1alpha1.LFSObject) string {
	items := make([]string, 0, len(objects))
	for _, o := range objects {
		items = append(items, fmt.Sprintf("%s %d", o.OID, o.Size))
	}
	raw, _ := json.Marshal(map[string]any{"at": at, "base": base, "objects": items})
	return string(raw)
}

// asking is a pod on this node that mounts the cache and carries an LFS ask.
func asking(name, value string) *corev1.Pod {
	pod := podOn(name, node, fixedNow.Add(-time.Hour))
	pod.Annotations = map[string]string{corev1alpha1.LFSAnnotation(key): value}
	return pod
}

// items reads this node's LFS items back from the API.
func items(t *testing.T, a *Agent) []corev1alpha1.RepoLFSAnswer {
	t.Helper()
	e := entry(t, a)
	if e == nil {
		t.Fatal("no entry for this node")
	}
	return e.LFS
}

// countFiles counts the files under a folder.
func countFiles(t *testing.T, root string) int {
	t.Helper()
	n := 0
	err := filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			n++
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

const at1 = "2026-11-07T12:00:00.123Z"

func TestADueLFSAskLandsInTheCacheAndTheCacheGainsNoGitObject(t *testing.T) {
	w := newLFSWorld(t)
	obj := put(t, filepath.Join(w.server, ".git"), "a large file\n")
	if err := w.a.Create(context.Background(), asking("sb", askJSON(at1, "", obj))); err != nil {
		t.Fatal(err)
	}
	before := countFiles(t, filepath.Join(w.cache, "objects"))

	// Under umask 077, git-lfs writes 0600 files and 0700 folders, so only
	// the agent's own change makes them readable by a pod's uid.
	old := syscall.Umask(0o077)
	_, err := reconcile1(t, w.a)
	syscall.Umask(old)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	got, err := os.ReadFile(lfsObjectPath(w.cache, obj.OID))
	if err != nil || string(got) != "a large file\n" {
		t.Fatalf("the object must land in <cache>/lfs/objects, got %q, %v", got, err)
	}
	if after := countFiles(t, filepath.Join(w.cache, "objects")); after != before {
		t.Fatalf("the cache's object store must gain no object: %d files before, %d after", before, after)
	}
	if w.git.lfsFetches() != 1 {
		t.Fatalf("expected one git lfs fetch, got %v", w.git.calls)
	}
	for _, c := range w.git.calls {
		if slices.Equal(c, []string{"fetch", "origin"}) {
			t.Fatalf("an LFS ask is not a git fetch, got %v", w.git.calls)
		}
	}
	it := items(t, w.a)
	if len(it) != 1 || it[0].Pod != "sb" || it[0].Asked != at1 || it[0].Error != "" || it[0].Attempted == nil || !it[0].Attempted.Time.Equal(fixedNow) {
		t.Fatalf("expected one item {sb, %s, now, no error}, got %+v", at1, it)
	}
	// A pod's uid 1000 reads the object through a read-only mount.
	for _, p := range []string{lfsObjectPath(w.cache, obj.OID)} {
		info, err := os.Stat(p)
		if err != nil || info.Mode().Perm()&0o004 == 0 {
			t.Fatalf("the object must be o+r, got %v, %v", info.Mode(), err)
		}
	}
	for p := filepath.Dir(lfsObjectPath(w.cache, obj.OID)); p != w.cache; p = filepath.Dir(p) {
		info, err := os.Stat(p)
		if err != nil || info.Mode().Perm()&0o005 != 0o005 {
			t.Fatalf("folder %s must be o+rx, got %v, %v", p, info.Mode(), err)
		}
	}
	// git-lfs installed no hook.
	hooks, _ := os.ReadDir(filepath.Join(w.cache, "hooks"))
	for _, h := range hooks {
		if !strings.HasSuffix(h.Name(), ".sample") {
			t.Fatalf("the agent must install no hook, found %s", h.Name())
		}
	}
	// The record is persistent: a second Reconcile serves nothing.
	if _, err := reconcile1(t, w.a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if w.git.lfsFetches() != 1 {
		t.Fatalf("a served ask is not served again, got %d fetches", w.git.lfsFetches())
	}
}

func TestAnObjectTheCacheHoldsIsNotFetched(t *testing.T) {
	w := newLFSWorld(t)
	obj := put(t, w.cache, "already here\n")
	if err := w.a.Create(context.Background(), asking("sb", askJSON(at1, "", obj))); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, w.a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if w.git.lfsFetches() != 0 {
		t.Fatalf("an object the cache holds is not fetched, got %v", w.git.calls)
	}
	if it := items(t, w.a); len(it) != 1 || it[0].Error != "" || it[0].Asked != at1 {
		t.Fatalf("the pod is answered with no error, got %+v", it)
	}
}

func TestOnlyTheMissingObjectsAreFetchedInOneFetchForEveryDuePod(t *testing.T) {
	w := newLFSWorld(t)
	held := put(t, w.cache, "held\n")
	one := put(t, filepath.Join(w.server, ".git"), "one\n")
	two := put(t, filepath.Join(w.server, ".git"), "two\n")
	for _, p := range []*corev1.Pod{
		asking("sb-1", askJSON(at1, "", held, one)),
		asking("sb-2", askJSON("2026-11-07T12:00:01Z", "", one, two)),
	} {
		if err := w.a.Create(context.Background(), p); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := reconcile1(t, w.a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if w.git.lfsFetches() != 1 {
		t.Fatalf("expected ONE git lfs fetch for both pods, got %v", w.git.calls)
	}
	var pointers []string
	for _, c := range w.git.calls {
		if c[0] == "update-index" {
			for i, arg := range c {
				if arg == "--cacheinfo" {
					pointers = append(pointers, c[i+1][strings.LastIndex(c[i+1], ",")+1:])
				}
			}
		}
	}
	slices.Sort(pointers)
	want := []string{one.OID, two.OID}
	slices.Sort(want)
	if !slices.Equal(pointers, want) {
		t.Fatalf("only the missing objects are asked of the server, once each: want %v, got %v", want, pointers)
	}
	it := items(t, w.a)
	if len(it) != 2 || it[0].Pod != "sb-1" || it[1].Pod != "sb-2" || it[0].Error != "" || it[1].Error != "" || it[1].Asked != "2026-11-07T12:00:01Z" {
		t.Fatalf("expected an item for each pod, got %+v", it)
	}
}

func TestAnObjectNotOnTheServerGivesAnErrorItem(t *testing.T) {
	w := newLFSWorld(t)
	missing := corev1alpha1.LFSObject{OID: strings.Repeat("ab", 32), Size: 5}
	if err := w.a.Create(context.Background(), asking("sb", askJSON(at1, "", missing))); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, w.a); err != nil {
		t.Fatalf("an LFS failure is an answer, not a retry: %v", err)
	}
	it := items(t, w.a)
	if len(it) != 1 || it[0].Asked != at1 || !strings.Contains(it[0].Error, missing.OID) || len(it[0].Error) > lfsErrorLimit+len("…") {
		t.Fatalf("expected an error item with git-lfs's words naming the oid, got %+v", it)
	}
}

func TestARestartedAgentDoesNotServeAgainButANewerAskIsServed(t *testing.T) {
	w := newLFSWorld(t)
	obj := put(t, filepath.Join(w.server, ".git"), "a\n")
	if err := w.a.Create(context.Background(), asking("sb", askJSON(at1, "", obj))); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, w.a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	// A new agent process: the only memory is the node entry.
	rec := &recGit{inner: ExecGit()}
	restarted := *w.a
	restarted.Git = rec
	if err := os.RemoveAll(filepath.Join(w.cache, "lfs")); err != nil {
		t.Fatal(err)
	}
	// The same instant in another form is not newer.
	sameInstant := "2026-11-07T13:00:00.123+01:00"
	var pod corev1.Pod
	if err := restarted.Get(context.Background(), client.ObjectKey{Namespace: ns, Name: "sb"}, &pod); err != nil {
		t.Fatal(err)
	}
	pod.Annotations[corev1alpha1.LFSAnnotation(key)] = askJSON(sameInstant, "", obj)
	if err := restarted.Update(context.Background(), &pod); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, &restarted); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if rec.lfsFetches() != 0 {
		t.Fatalf("a restart must not serve an ask again, got %v", rec.calls)
	}
	if it := items(t, &restarted); len(it) != 1 || it[0].Asked != at1 {
		t.Fatalf("the item must stay as served, got %+v", it)
	}
	pod.Annotations[corev1alpha1.LFSAnnotation(key)] = askJSON("2026-11-07T12:00:00.124Z", "", obj)
	if err := restarted.Update(context.Background(), &pod); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, &restarted); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if rec.lfsFetches() != 1 || !restarted.hasLFS(w.cache, obj.OID) {
		t.Fatalf("a newer ask is served, got %v", rec.calls)
	}
}

func TestTheItemOfAPodThatNoLongerMountsTheCacheIsRemoved(t *testing.T) {
	w := newLFSWorld(t)
	obj := put(t, filepath.Join(w.server, ".git"), "a\n")
	for _, p := range []*corev1.Pod{asking("sb-1", askJSON(at1, "", obj)), asking("sb-2", askJSON(at1, "", obj))} {
		if err := w.a.Create(context.Background(), p); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := reconcile1(t, w.a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if it := items(t, w.a); len(it) != 2 {
		t.Fatalf("expected two items, got %+v", it)
	}
	if err := w.a.Delete(context.Background(), asking("sb-1", "")); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, w.a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if it := items(t, w.a); len(it) != 1 || it[0].Pod != "sb-2" {
		t.Fatalf("the gone pod's item must go, the other stay, got %+v", it)
	}
	if w.git.lfsFetches() != 1 {
		t.Fatalf("removing an item fetches nothing, got %v", w.git.calls)
	}
}

func TestTheBasesLFSConfigNamesTheServerAndHEADsDoesNotOverrideIt(t *testing.T) {
	w := newLFSWorld(t)
	// The base names a second server; HEAD names one that does not exist.
	other := filepath.Join(t.TempDir(), "other")
	gitT(t, "", "init", "-q", "-b", "main", other)
	obj := put(t, filepath.Join(other, ".git"), "on the other server\n")
	writeCommit := func(branch, lfsURL string) {
		gitT(t, w.server, "checkout", "-q", "-B", branch, "main")
		if err := os.WriteFile(filepath.Join(w.server, ".lfsconfig"), []byte("[lfs]\n\turl = "+lfsURL+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		gitT(t, w.server, "add", ".lfsconfig")
		gitT(t, w.server, "commit", "-q", "-m", branch)
	}
	writeCommit("base", "file://"+other)
	writeCommit("head", "file:///nowhere")
	gitT(t, w.cache, "fetch", "-q", "file://"+w.server, "+refs/heads/*:refs/heads/*")
	gitT(t, w.cache, "symbolic-ref", "HEAD", "refs/heads/head")

	if err := w.a.Create(context.Background(), asking("sb", askJSON(at1, "base", obj))); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, w.a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if it := items(t, w.a); len(it) != 1 || it[0].Error != "" || !w.a.hasLFS(w.cache, obj.OID) {
		t.Fatalf("the object must come from the server the base names, got %+v", it)
	}
}

func TestABaseThatNamesAFileServerForAnHTTPRepoIsRefused(t *testing.T) {
	a := &Agent{Git: ExecGit()}
	requireGitLFS(t)
	dir := filepath.Join(t.TempDir(), "r")
	gitT(t, "", "init", "-q", "-b", "main", dir)
	if err := os.WriteFile(filepath.Join(dir, ".lfsconfig"), []byte("[lfs]\n\turl = file:///etc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "add", ".lfsconfig")
	gitT(t, dir, "commit", "-q", "-m", "x")
	if _, err := a.lfsEndpoint(context.Background(), dir, repoURL, "main"); err == nil || !strings.Contains(err.Error(), "file:///etc") {
		t.Fatalf("a file:// server for an https Repo must be refused, got %v", err)
	}
	if got, err := a.lfsEndpoint(context.Background(), dir, repoURL, "--upload-pack=x"); err == nil {
		t.Fatalf("a base that reads as an option must be refused, got %q", got)
	}
	if _, err := a.lfsEndpoint(context.Background(), dir, repoURL, "nope"); err == nil || !strings.Contains(err.Error(), "not in the node cache") {
		t.Fatalf("an unknown base must say so, got %v", err)
	}
}

func TestDerivedLFSURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/acme/app.git":   "https://github.com/acme/app.git/info/lfs",
		"https://github.com/acme/app":       "https://github.com/acme/app.git/info/lfs",
		"https://github.com/acme/app/":      "https://github.com/acme/app.git/info/lfs",
		"git://github.com/acme/app.git":     "https://github.com/acme/app.git/info/lfs",
		"git://github.com/acme/app":         "https://github.com/acme/app.git/info/lfs",
		"git://github.com:9418/acme/app/":   "https://github.com:9418/acme/app.git/info/lfs",
		"ssh://git@github.com/acme/app.git": "ssh://git@github.com/acme/app.git",
		"git@github.com:acme/app.git":       "git@github.com:acme/app.git",
		"file:///srv/app":                   "file:///srv/app",
	} {
		if got := derivedLFSURL(in); got != want {
			t.Errorf("derivedLFSURL(%q) = %q, want %q", in, got, want)
		}
	}
}

// derivedLFSURL agrees with git-lfs's own derivation from a remote's url: the
// same endpoint for http(s), git and file, and the same ssh host and path for
// ssh (ADR-0051).
func TestDerivedLFSURLIsWhatGitLFSDerives(t *testing.T) {
	requireGitLFS(t)
	dir := filepath.Join(t.TempDir(), "r")
	gitT(t, "", "init", "-q", "--bare", dir)
	env := func(args ...string) (endpoint, ssh string) {
		t.Helper()
		out := gitT(t, dir, append(args, "lfs", "env")...)
		for line := range strings.SplitSeq(out, "\n") {
			line = strings.TrimSpace(line)
			if v, ok := strings.CutPrefix(line, "Endpoint="); ok && endpoint == "" {
				endpoint = strings.TrimSuffix(v, " (auth=none)")
			} else if v, ok := strings.CutPrefix(line, "SSH="); ok && ssh == "" {
				ssh = v
			}
		}
		return endpoint, ssh
	}
	for _, in := range []string{
		"https://github.com/acme/app.git", "https://github.com/acme/app/", "http://127.0.0.1:8080/acme/app",
		"git://github.com/acme/app.git", "git://github.com:9418/acme/app/",
		"ssh://git@github.com/acme/app.git", "ssh://git@github.com:2222/acme/app", "git@github.com:acme/app.git",
		"file:///srv/app.git",
	} {
		gitT(t, dir, "config", "remote.origin.url", in)
		wantEndpoint, wantSSH := env()
		gotEndpoint, gotSSH := env("-c", "lfs.url="+derivedLFSURL(in))
		if wantSSH != "" {
			// ssh: the same ask to git-lfs-authenticate; the https fallback
			// differs, as derivedLFSURL says.
			if gotSSH != wantSSH {
				t.Errorf("%s: git-lfs asks ssh %q, the agent's lfs.url gives %q", in, wantSSH, gotSSH)
			}
			continue
		}
		if gotEndpoint != wantEndpoint || wantEndpoint == "" {
			t.Errorf("%s: git-lfs derives %q, the agent's lfs.url gives %q", in, wantEndpoint, gotEndpoint)
		}
	}
}

// The `.lfsconfig` at the cache's HEAD cannot stop an ask with
// lfs.fetchexclude or lfs.fetchinclude: the agent sets both to empty.
func TestHEADsFetchExcludeDoesNotStopTheAsk(t *testing.T) {
	w := newLFSWorld(t)
	obj := put(t, filepath.Join(w.server, ".git"), "excluded?\n")
	gitT(t, w.server, "checkout", "-q", "-B", "head", "main")
	if err := os.WriteFile(filepath.Join(w.server, ".lfsconfig"), []byte("[lfs]\n\tfetchexclude = *\n\tfetchinclude = nothing\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, w.server, "add", ".lfsconfig")
	gitT(t, w.server, "commit", "-q", "-m", "head")
	gitT(t, w.cache, "fetch", "-q", "file://"+w.server, "+refs/heads/*:refs/heads/*")
	gitT(t, w.cache, "symbolic-ref", "HEAD", "refs/heads/head")
	if err := w.a.Create(context.Background(), asking("sb", askJSON(at1, "main", obj))); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, w.a); err != nil {
		t.Fatal(err)
	}
	if it := items(t, w.a); len(it) != 1 || it[0].Error != "" || !w.a.hasLFS(w.cache, obj.OID) {
		t.Fatalf("HEAD's fetchexclude must not stop the ask, got %+v", it)
	}
}

// With no entry for this node in the Repo that the informer gives, a report
// of a served pod returns an error, so the queue tries again soon. With no
// pod served, there is nothing to wait for.
func TestAnLFSReportWithNoEntryYetTriesAgain(t *testing.T) {
	r := repo(1)
	a := newAgent(t, &fakeGit{}, r)
	served := []corev1alpha1.RepoLFSAnswer{{Pod: "sb", Asked: at1, Attempted: ts(fixedNow)}}
	if err := a.reportLFS(context.Background(), r, served, map[string]bool{"sb": true}); !errors.Is(err, errNoEntryYet) {
		t.Fatalf("expected errNoEntryYet, got %v", err)
	}
	if err := a.reportLFS(context.Background(), r, nil, map[string]bool{}); err != nil {
		t.Fatalf("with no pod served, expected no error, got %v", err)
	}
}

// The budget of one git-lfs run is the latest ask's: an older ask whose
// budget ran out does not cut the budget of a newer ask in the same run.
func TestAnOlderAskDoesNotCutTheBudgetOfANewerOne(t *testing.T) {
	w := newLFSWorld(t)
	obj := put(t, filepath.Join(w.server, ".git"), "shared\n")
	w.a.LFSTimeout = time.Minute
	old := fixedNow.Add(-2 * time.Minute).Format(time.RFC3339Nano)
	if err := w.a.Create(context.Background(), asking("old", askJSON(old, "", obj))); err != nil {
		t.Fatal(err)
	}
	if err := w.a.Create(context.Background(), asking("new", askJSON(at1, "", obj))); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, w.a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	it := items(t, w.a)
	if len(it) != 2 || w.git.lfsFetches() != 1 || !w.a.hasLFS(w.cache, obj.OID) {
		t.Fatalf("one git-lfs run serves both asks, got %+v (%d fetches)", it, w.git.lfsFetches())
	}
	for _, item := range it {
		if item.Error != "" {
			t.Fatalf("the object landed, so no item has an error, got %+v", it)
		}
	}
}

// A cache that a clone could not make answers each due pod with an error that
// says the cache is absent, also when the node had no entry before the clone.
func TestAnAbsentCacheAnswersEachDuePodThatItIsAbsent(t *testing.T) {
	obj := corev1alpha1.LFSObject{OID: strings.Repeat("cd", 32), Size: 1}
	for name, r := range map[string]*corev1alpha1.Repo{
		"an entry": repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: false, Synced: true, Attempted: corev1alpha1.RepoAttemptProbe, ObservedGeneration: 1}),
		"no entry": repo(1),
	} {
		t.Run(name, func(t *testing.T) {
			git := &fakeGit{fail: map[string]string{gitClone: "fatal: could not read from remote repository"}}
			a := newAgent(t, git, r, asking("sb", askJSON(at1, "", obj)))
			if _, err := reconcile1(t, a); err == nil {
				t.Fatal("the failed clone returns its error")
			}
			it := items(t, a)
			if len(it) != 1 || it[0].Asked != at1 || !strings.Contains(it[0].Error, "absent or still cloning") {
				t.Fatalf("expected an error item that says the cache is absent, got %+v", it)
			}
			if e := entry(t, a); e.Present || !strings.Contains(e.LastError, "could not read") {
				t.Fatalf("the clone's report stays, got %+v", e)
			}
		})
	}
}

// After a clone that works, the same Reconcile serves the ask from the new
// cache.
func TestAClonedCacheServesTheAskInTheSameReconcile(t *testing.T) {
	w := newLFSWorld(t)
	obj := put(t, filepath.Join(w.server, ".git"), "after the clone\n")
	if err := os.RemoveAll(w.cache); err != nil {
		t.Fatal(err)
	}
	if err := w.a.Create(context.Background(), asking("sb", askJSON(at1, "", obj))); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, w.a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if it := items(t, w.a); len(it) != 1 || it[0].Error != "" || !w.a.hasLFS(w.cache, obj.OID) {
		t.Fatalf("the clone, then the ask, got %+v", it)
	}
}

// A probe (no pod mounts the cache) removes the items of pods that left.
func TestAProbeRemovesTheItemsOfPodsThatLeft(t *testing.T) {
	git := &fakeGit{fail: map[string]string{"ls-remote": "fatal: unable to access"}}
	a := newAgent(t, git, repo(1, corev1alpha1.RepoNodeStatus{
		Node: node, Present: true, Synced: true, Attempted: corev1alpha1.RepoAttemptFetch, ObservedGeneration: 1,
		LFS: []corev1alpha1.RepoLFSAnswer{{Pod: "gone", Asked: at1, Attempted: ts(fixedNow)}},
	}))
	_, _ = reconcile1(t, a)
	if e := entry(t, a); e.Present || len(e.LFS) != 0 {
		t.Fatalf("the probe corrects the entry and the item of the gone pod goes, got %+v", e)
	}
}

// The LFS budget runs from the ask's `at`: an ask whose budget ran
// out before git-lfs could start is answered with an error, and git-lfs does
// not run.
func TestTheLFSBudgetRunsFromTheAsk(t *testing.T) {
	w := newLFSWorld(t)
	obj := put(t, filepath.Join(w.server, ".git"), "late\n")
	w.a.LFSTimeout = time.Minute
	late := fixedNow.Add(-2 * time.Minute).Format(time.RFC3339Nano)
	if err := w.a.Create(context.Background(), asking("sb", askJSON(late, "", obj))); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, w.a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if it := items(t, w.a); len(it) != 1 || !strings.Contains(it[0].Error, "budget") || w.git.lfsFetches() != 0 {
		t.Fatalf("an ask out of budget gets an error and no git-lfs, got %+v (%d fetches)", it, w.git.lfsFetches())
	}
}

// lfsServerAllowed refuses every LFS server that would make the agent read a
// path on the node, or use an ssh Repo's key on another host.
func TestLFSServerAllowed(t *testing.T) {
	const scp, sshURL, httpsURL, fileURL = "git@github.com:acme/app.git", "ssh://git@github.com:22/acme/app.git", "https://github.com/acme/app.git", "file:///srv/app"
	for _, c := range []struct {
		lfs, repo string
		ok        bool
	}{
		{"https://lfs.example.com/x", scp, true},
		{"http://[::1]:8080/x", httpsURL, true},
		{"https://github.com/acme/app.git/info/lfs", httpsURL, true},
		{"git@github.com:acme/app.git", scp, true},
		{"ssh://git@GitHub.com/acme/app.git", scp, true},
		{"github.com:acme/app.git", sshURL, true},
		{"file:///srv/other", fileURL, true},
		{"/cache/other-key", scp, false},
		{"./other", scp, false},
		{"../other", sshURL, false},
		{"other", scp, false},
		{"ssh://attacker.example/x", scp, false},
		{"attacker.example:x", sshURL, false},
		{"git@attacker.example:x", scp, false},
		{"git@github.com:acme/app.git", httpsURL, false},
		{"file:///srv/other", scp, false},
		{"file:///srv/other", httpsURL, false},
		{"ext::sh -c touch% /tmp/x", scp, false},
		{"github.com::x", scp, false},
		{"-oProxyCommand=x:y", scp, false},
		{"ssh://-oProxyCommand=x/y", scp, false},
		{"git://github.com/acme/app.git", scp, false},
		{"https://", scp, false},
	} {
		if got := lfsServerAllowed(c.lfs, c.repo); got != c.ok {
			t.Errorf("lfsServerAllowed(%q, %q) = %v, want %v", c.lfs, c.repo, got, c.ok)
		}
	}
}

// For an ssh Repo, a base whose .lfsconfig names a path (another Repo's
// cache on the node) or an ssh server on another host is refused: the object
// does not land and git-lfs does not run.
func TestAnSSHRepoRefusesALocalPathOrAnotherSSHHost(t *testing.T) {
	requireGitLFS(t)
	other := filepath.Join(t.TempDir(), "other-key")
	gitT(t, "", "init", "-q", "--bare", other)
	obj := put(t, other, "a file of another Repo\n")
	for _, lfsURL := range []string{other, "ssh://other.example/acme/app.git"} {
		t.Run(lfsURL, func(t *testing.T) {
			src := filepath.Join(t.TempDir(), "src")
			gitT(t, "", "init", "-q", "-b", "main", src)
			if err := os.WriteFile(filepath.Join(src, ".lfsconfig"), []byte("[lfs]\n\turl = "+lfsURL+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			gitT(t, src, "add", ".lfsconfig")
			gitT(t, src, "commit", "-q", "-m", "base")
			r := repo(1, corev1alpha1.RepoNodeStatus{
				Node: node, Present: true, Synced: true, Attempted: corev1alpha1.RepoAttemptFetch,
				ObservedGeneration: 1, LastAttempt: ts(fixedNow), LastFetched: ts(fixedNow),
			})
			r.Spec.URL = "git@example.com:acme/app.git"
			git := &recGit{inner: ExecGit()}
			a := newAgent(t, &fakeGit{}, r, asking("sb", askJSON(at1, "main", obj)))
			a.Git = git
			gitT(t, "", "clone", "-q", "--bare", "file://"+src, a.dir(key))
			// The refresh's fetch from the ssh url fails here; the serve still runs.
			_, _ = reconcile1(t, a)
			it := items(t, a)
			if len(it) != 1 || !strings.Contains(it[0].Error, "accepts") || a.hasLFS(a.dir(key), obj.OID) || git.lfsFetches() != 0 {
				t.Fatalf("the server must be refused, got %+v (%d fetches)", it, git.lfsFetches())
			}
		})
	}
}

// git reads .lfsconfig with no includes, so a committed include cannot make
// the agent read a file on the node.
func TestTheLFSConfigIsReadWithNoIncludes(t *testing.T) {
	requireGitLFS(t)
	node := filepath.Join(t.TempDir(), "node-file")
	if err := os.WriteFile(node, []byte("[lfs]\n\turl = https://from-the-node.example/x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "r")
	gitT(t, "", "init", "-q", "-b", "main", dir)
	if err := os.WriteFile(filepath.Join(dir, ".lfsconfig"), []byte("[include]\n\tpath = "+node+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, dir, "add", ".lfsconfig")
	gitT(t, dir, "commit", "-q", "-m", "x")
	a := &Agent{Git: ExecGit()}
	got, err := a.lfsEndpoint(context.Background(), dir, repoURL, "main")
	if err != nil || got != derivedLFSURL(repoURL) {
		t.Fatalf("the include must not be read, got %q, %v", got, err)
	}
}

// A report that changes other fields keeps the LFS items, and an LFS report
// keeps the other fields.
func TestTheGitReportAndTheLFSReportKeepEachOthersFields(t *testing.T) {
	git := &fakeGit{}
	old := fixedNow.Add(-time.Hour)
	served := corev1alpha1.RepoLFSAnswer{Pod: "sb", Asked: at1, Attempted: ts(old)}
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{
			Node: node, Present: true, Synced: true, Attempted: corev1alpha1.RepoAttemptFetch, ObservedGeneration: 1,
			LastAttempt: ts(old), LastFetched: ts(old), LFS: []corev1alpha1.RepoLFSAnswer{served},
		}),
		asking("sb", askJSON(at1, "", corev1alpha1.LFSObject{OID: strings.Repeat("ef", 32), Size: 1})),
	)
	makePresent(t, a)
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	e := entry(t, a)
	if !e.LastFetched.Time.Equal(fixedNow) {
		t.Fatalf("the interval fetch must report, got %+v", e)
	}
	if len(e.LFS) != 1 || e.LFS[0].Asked != at1 || !e.LFS[0].Attempted.Time.Equal(old) {
		t.Fatalf("the fetch's report must keep the LFS items, got %+v", e.LFS)
	}
	if slices.Contains(git.subcommands(), "lfs") {
		t.Fatalf("an ask already served is not served on the interval, got %v", git.calls)
	}
}

// lfsHost is an httptest LFS server that records the headers of each request
// it gets. Its batch answer sends each object's download to `hrefBase`, with
// one header of its own.
type lfsHost struct {
	srv      *httptest.Server
	url      string // the server's url, by the host name the test gives
	mu       sync.Mutex
	seen     []http.Header
	paths    []string
	needAuth string // the Authorization a batch must carry; "" for a public server
	hrefBase func() string
	store    map[string]string // oid → content
	redirect func() string     // when set, a batch answers 307 to this url
}

func newLFSHost(t *testing.T, hostName string) *lfsHost {
	t.Helper()
	h := &lfsHost{store: map[string]string{}}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h.srv = &httptest.Server{Listener: ln, Config: &http.Server{Handler: http.HandlerFunc(h.serve)}}
	h.srv.Start()
	h.url = "http://" + hostName + ":" + strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
	t.Cleanup(h.srv.Close)
	return h
}

func (h *lfsHost) serve(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	h.seen = append(h.seen, r.Header.Clone())
	h.paths = append(h.paths, r.URL.Path)
	h.mu.Unlock()
	if strings.HasSuffix(r.URL.Path, "/objects/batch") {
		if h.redirect != nil && (h.needAuth == "" || r.Header.Get("Authorization") == h.needAuth) {
			w.Header().Set("Location", h.redirect())
			w.WriteHeader(http.StatusTemporaryRedirect)
			return
		}
		if h.needAuth != "" && r.Header.Get("Authorization") != h.needAuth {
			w.Header().Set("LFS-Authenticate", `Basic realm="lfs"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var req struct {
			Objects []struct {
				OID  string `json:"oid"`
				Size int64  `json:"size"`
			} `json:"objects"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		type action struct {
			Href   string            `json:"href"`
			Header map[string]string `json:"header"`
		}
		type object struct {
			OID     string            `json:"oid"`
			Size    int64             `json:"size"`
			Actions map[string]action `json:"actions"`
		}
		out := struct {
			Transfer string   `json:"transfer"`
			Objects  []object `json:"objects"`
		}{Transfer: "basic"}
		for _, o := range req.Objects {
			out.Objects = append(out.Objects, object{OID: o.OID, Size: o.Size, Actions: map[string]action{
				"download": {Href: h.hrefBase() + "/objects/" + o.OID, Header: map[string]string{"X-Batch-Answer": "only-this"}},
			}})
		}
		w.Header().Set("Content-Type", "application/vnd.git-lfs+json")
		_ = json.NewEncoder(w).Encode(out)
		return
	}
	oid := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	h.mu.Lock()
	content, ok := h.store[oid]
	h.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	_, _ = io.WriteString(w, content)
}

// requests gives the recorded headers of the requests whose path ends with
// suffix.
func (h *lfsHost) requests(suffix string) []http.Header {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []http.Header
	for i, p := range h.paths {
		if strings.HasSuffix(p, suffix) {
			out = append(out, h.seen[i])
		}
	}
	return out
}

// TestTheTokenGoesToTheOriginHostOnlyAndAnHrefGetsOnlyTheAnswersHeaders proves
// ADR-0051's host rule against two hosts: the origin (127.0.0.1) holds the
// Repo, its LFS server needs the token, and its batch answer sends the
// download to a second host (localhost), as GitHub sends one to its object
// store. The second host gets no token, only the answer's header. Then the
// base's .lfsconfig names a private LFS server on the second host: it asks for
// a credential and gets none. Last, the origin's batch redirects to the second
// host: git-lfs follows it, and the second host gets no token.
func TestTheTokenGoesToTheOriginHostOnlyAndAnHrefGetsOnlyTheAnswersHeaders(t *testing.T) {
	requireGitLFS(t)
	origin := newLFSHost(t, "127.0.0.1")
	other := newLFSHost(t, "localhost")
	const user, token = "x-access-token", "s3cret-token"
	origin.needAuth = "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+token))
	origin.hrefBase = func() string { return other.url }
	other.hrefBase = func() string { return other.url }

	content := "a large file\n"
	sum := sha256.Sum256([]byte(content))
	obj := corev1alpha1.LFSObject{OID: hex.EncodeToString(sum[:]), Size: int64(len(content))}
	other.store[obj.OID] = content

	repoURLHTTP := origin.url + "/acme/app.git"
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "git", Namespace: ns},
		Data:       map[string][]byte{"username": []byte(user), "password": []byte(token)},
	}
	r := repo(1, corev1alpha1.RepoNodeStatus{
		Node: node, Present: true, Synced: true, Attempted: corev1alpha1.RepoAttemptFetch,
		ObservedGeneration: 1, LastAttempt: ts(fixedNow), LastFetched: ts(fixedNow),
	})
	r.Spec.URL = repoURLHTTP
	r.Spec.SecretRef = &corev1.LocalObjectReference{Name: "git"}
	pod := asking("sb", askJSON(at1, "", obj))
	a := newAgent(t, &fakeGit{}, r, secret, pod)
	a.Git = ExecGit()
	a.LFSTimeout = time.Minute
	// The cache: any bare repository with a HEAD, and a branch whose
	// .lfsconfig names the second host.
	src := filepath.Join(t.TempDir(), "src")
	gitT(t, "", "init", "-q", "-b", "main", src)
	if err := os.WriteFile(filepath.Join(src, "README"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, src, "add", "README")
	gitT(t, src, "commit", "-q", "-m", "init")
	gitT(t, src, "checkout", "-q", "-b", "elsewhere")
	if err := os.WriteFile(filepath.Join(src, ".lfsconfig"), []byte("[lfs]\n\turl = "+other.url+"/lfs\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitT(t, src, "add", ".lfsconfig")
	gitT(t, src, "commit", "-q", "-m", "elsewhere")
	gitT(t, src, "checkout", "-q", "main")
	gitT(t, "", "clone", "-q", "--bare", "file://"+src, a.dir(key))

	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if it := items(t, a); len(it) != 1 || it[0].Error != "" || !a.hasLFS(a.dir(key), obj.OID) {
		t.Fatalf("the object must land through the origin's batch, got %+v", it)
	}
	batches := origin.requests("/acme/app.git/info/lfs/objects/batch")
	if len(batches) == 0 || batches[len(batches)-1].Get("Authorization") != origin.needAuth {
		t.Fatalf("the origin's LFS server must get the token, got %v", batches)
	}
	downloads := other.requests("/objects/" + obj.OID)
	if len(downloads) != 1 {
		t.Fatalf("expected one download from the second host, got %d", len(downloads))
	}
	if got := downloads[0].Get("Authorization"); got != "" {
		t.Fatalf("an href on another host must get no token, got Authorization %q", got)
	}
	if got := downloads[0].Get("X-Batch-Answer"); got != "only-this" {
		t.Fatalf("an href must get the answer's headers, got %v", downloads[0])
	}
	for name := range downloads[0] {
		if strings.EqualFold(name, "Cookie") || strings.EqualFold(name, "Proxy-Authorization") {
			t.Fatalf("an href must get only the answer's headers, got %s", name)
		}
	}

	// The base names a private LFS server on the second host. It challenges,
	// but no token goes there, so the ask fails with git-lfs's words.
	other.needAuth = "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+token))
	if err := os.RemoveAll(filepath.Join(a.dir(key), "lfs")); err != nil {
		t.Fatal(err)
	}
	if err := a.Get(context.Background(), client.ObjectKeyFromObject(pod), pod); err != nil {
		t.Fatal(err)
	}
	pod.Annotations[corev1alpha1.LFSAnnotation(key)] = askJSON("2026-11-07T12:00:05Z", "elsewhere", obj)
	if err := a.Update(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if it := items(t, a); len(it) != 1 || it[0].Error == "" || a.hasLFS(a.dir(key), obj.OID) {
		t.Fatalf("a private LFS server on another host gets no token, so the ask fails, got %+v", it)
	}
	otherBatches := other.requests("/lfs/objects/batch")
	if len(otherBatches) == 0 {
		t.Fatal("the base's .lfsconfig must name the LFS server")
	}
	for _, h := range otherBatches {
		if h.Get("Authorization") != "" {
			t.Fatalf("an LFS server on another host must get no token, got %v", h)
		}
	}

	// The origin's batch redirects to the second host. Whatever git-lfs does
	// with the redirect, the second host gets no token.
	origin.redirect = func() string { return other.url + "/moved/info/lfs/objects/batch" }
	if err := a.Get(context.Background(), client.ObjectKeyFromObject(pod), pod); err != nil {
		t.Fatal(err)
	}
	pod.Annotations[corev1alpha1.LFSAnnotation(key)] = askJSON("2026-11-07T12:00:10Z", "", obj)
	if err := a.Update(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	for _, h := range other.requests("/moved/info/lfs/objects/batch") {
		if h.Get("Authorization") != "" {
			t.Fatalf("a batch redirected to another host must get no token, got %v", h)
		}
	}
}
