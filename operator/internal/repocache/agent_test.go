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

package repocache

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

const (
	ns      = "j2-test"
	node    = "node-a"
	key     = "app-0a1b2c3d"
	repoURL = "https://github.com/acme/app.git"

	gitClone  = "clone"
	gitConfig = "config"
)

// pinned is the `git config` call that writes one gc pin.
func pinned(kv [2]string) []string { return []string{gitConfig, kv[0], kv[1]} }

// fakeGit records every invocation and answers from a table keyed by the
// first argument. A clone that succeeds leaves a bare repo's HEAD behind, as
// git would; nothing else touches the disk.
type fakeGit struct {
	calls [][]string
	envs  [][]string
	fail  map[string]string // subcommand → error text (git's words)
}

func (g *fakeGit) Run(_ context.Context, dir string, env []string, args ...string) (string, error) {
	g.calls = append(g.calls, args)
	g.envs = append(g.envs, env)
	if msg, ok := g.fail[args[0]]; ok {
		if args[0] == gitClone {
			// git writes HEAD and config before it fetches; a failure mid-way
			// leaves them behind.
			_ = os.MkdirAll(args[len(args)-1], 0o755)
			_ = os.WriteFile(filepath.Join(args[len(args)-1], "HEAD"), []byte("ref: refs/heads/main\n"), 0o644)
		}
		return msg, errors.New(msg)
	}
	if args[0] == gitClone {
		dst := args[len(args)-1]
		if err := os.MkdirAll(dst, 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(dst, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
			return "", err
		}
	}
	_ = dir
	return "", nil
}

// subcommands lists the git subcommands invoked, in order.
func (g *fakeGit) subcommands() []string {
	out := make([]string, 0, len(g.calls))
	for _, c := range g.calls {
		out = append(out, c[0])
	}
	return out
}

func (g *fakeGit) has(args ...string) bool {
	return slices.ContainsFunc(g.calls, func(c []string) bool { return slices.Equal(c, args) })
}

func newScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	if err := corev1alpha1.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	return s
}

var fixedNow = time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)

// newAgent builds an agent over a fake client holding objs, a fake git, a
// temp cache directory, and a fixed clock.
func newAgent(t *testing.T, git *fakeGit, objs ...client.Object) *Agent {
	t.Helper()
	if git.fail == nil {
		git.fail = map[string]string{}
	}
	c := fake.NewClientBuilder().WithScheme(newScheme(t)).
		WithStatusSubresource(&corev1alpha1.Repo{}, &corev1alpha1.Sandbox{}).
		WithObjects(objs...).Build()
	return &Agent{
		Client:    c,
		Git:       git,
		CacheDir:  t.TempDir(),
		Namespace: ns,
		Node:      node,
		Home:      t.TempDir(),
		Now:       func() time.Time { return fixedNow },
	}
}

func repo(generation int64, nodes ...corev1alpha1.RepoNodeStatus) *corev1alpha1.Repo {
	return &corev1alpha1.Repo{
		ObjectMeta: metav1.ObjectMeta{Name: key, Namespace: ns, Generation: generation},
		Spec:       corev1alpha1.RepoSpec{URL: repoURL},
		Status:     corev1alpha1.RepoStatus{Nodes: nodes},
	}
}

// sandboxOn is a Sandbox scheduled onto `on`, naming the key, created at t.
func sandboxOn(name, on string, created time.Time) *corev1alpha1.Sandbox {
	return &corev1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, CreationTimestamp: metav1.NewTime(created)},
		Spec: corev1alpha1.SandboxSpec{
			Image: "harness:latest",
			Repos: []corev1alpha1.SandboxRepo{{Key: key, URL: repoURL}},
		},
		Status: corev1alpha1.SandboxStatus{Node: on},
	}
}

func ts(t time.Time) *metav1.Time { v := metav1.NewTime(t); return &v }

func reconcile1(t *testing.T, a *Agent) (reconcile.Result, error) {
	t.Helper()
	return a.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: key, Namespace: ns}})
}

// entry reads this node's status entry back from the API.
func entry(t *testing.T, a *Agent) *corev1alpha1.RepoNodeStatus {
	t.Helper()
	var r corev1alpha1.Repo
	if err := a.Get(context.Background(), types.NamespacedName{Name: key, Namespace: ns}, &r); err != nil {
		t.Fatalf("get repo: %v", err)
	}
	return a.own(&r)
}

func makePresent(t *testing.T, a *Agent) string {
	t.Helper()
	dir := a.dir(key)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestClonesWhenASandboxOnThisNodeNamesTheRepo(t *testing.T) {
	// ADR-0051: a cache is cloned onto a node the first time a Sandbox there
	// needs it — pinned before anything fetches (ADR-0004), and reported
	// present and fetched at once so the Sandbox's Ready can pass.
	git := &fakeGit{}
	a := newAgent(t, git, repo(1), sandboxOn("sb", node, fixedNow.Add(-time.Minute)))

	res, err := reconcile1(t, a)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !git.has(gitClone, "--bare", "--", repoURL, a.dir(key)) {
		t.Fatalf("expected a bare clone of the url into the cache, got %v", git.calls)
	}
	wantConfig := make([][]string, 0, 3+len(gcPins))
	wantConfig = append(wantConfig,
		[]string{gitConfig, "--", "remote.origin.url", repoURL},
		[]string{gitConfig, "--replace-all", fetchRefspecKey, "+refs/heads/*:refs/heads/*"},
		[]string{gitConfig, "--add", fetchRefspecKey, "+refs/tags/*:refs/tags/*"})
	for _, kv := range gcPins {
		wantConfig = append(wantConfig, pinned(kv))
	}
	for _, pin := range wantConfig {
		if !git.has(pin...) {
			t.Errorf("expected %v after the clone, got %v", pin, git.calls)
		}
	}
	if !present(a.dir(key)) {
		t.Fatal("the cache should be present after a clone")
	}
	if _, err := os.Stat(a.marker(key)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the clone marker must be gone once the clone is complete")
	}
	e := entry(t, a)
	if e == nil || !e.Present || !e.Synced || e.LastFetched == nil || e.LastError != "" || e.ObservedGeneration != 1 {
		t.Fatalf("expected present+synced+fetched at generation 1, got %+v", e)
	}
	if !e.LastFetched.Time.Equal(fixedNow) {
		t.Fatalf("lastFetched should be the attempt's instant, got %v", e.LastFetched)
	}
	if res.RequeueAfter != defaultRefreshInterval {
		t.Fatalf("expected a requeue at the refresh interval, got %v", res.RequeueAfter)
	}
	if !slices.Contains(git.envs[0], "GIT_TERMINAL_PROMPT=0") {
		t.Fatalf("git must never prompt, got env %v", git.envs[0])
	}
}

func TestTheURLReachesGitOnlyBehindADoubleDash(t *testing.T) {
	// ADR-0051: `spec.url` is a field a per-run url — run input — reaches. A
	// url spelled `--upload-pack=<command>` is an OPTION to git and runs a
	// shell as this pod, so every call that carries the url ends its options
	// with `--` first: the probe, the clone, and the re-point alike.
	evil := "--upload-pack=sh -c evil #@github.com:acme/app.git"
	withURL := func(r *corev1alpha1.Repo) *corev1alpha1.Repo { r.Spec.URL = evil; return r }
	operand := func(git *fakeGit, phase string) {
		t.Helper()
		carried := 0
		for _, c := range git.calls {
			for i, arg := range c {
				if arg != evil {
					continue
				}
				carried++
				if !slices.Contains(c[:i], "--") {
					t.Errorf("%s: the url must come after `--`, got %v", phase, c)
				}
			}
		}
		if carried == 0 {
			t.Errorf("%s: expected a git call carrying the url, got %v", phase, git.calls)
		}
	}

	git := &fakeGit{}
	a := newAgent(t, git, withURL(repo(1)))
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("probe: %v", err)
	}
	operand(git, "probe")

	git = &fakeGit{}
	a = newAgent(t, git, withURL(repo(1)), sandboxOn("sb", node, fixedNow.Add(-time.Minute)))
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("clone: %v", err)
	}
	operand(git, "clone")

	git = &fakeGit{}
	a = newAgent(t, git, withURL(repo(2,
		corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(fixedNow), LastFetched: ts(fixedNow), ObservedGeneration: 1},
	)))
	makePresent(t, a)
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("re-point: %v", err)
	}
	operand(git, "re-point")
}

func TestASandboxOnAnotherNodeIsNotDemand(t *testing.T) {
	git := &fakeGit{}
	a := newAgent(t, git, repo(1), sandboxOn("sb", "node-b", fixedNow))
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if got := git.subcommands(); !slices.Equal(got, []string{"ls-remote"}) {
		t.Fatalf("another node's Sandbox should leave this node probing, not cloning: %v", got)
	}
}

func TestProbesOncePerGenerationWhenNobodyAsks(t *testing.T) {
	// ADR-0048/0051: before any Sandbox asks, the agent probes the remote so
	// `j2 status` has a sync signal — once per spec generation, no clone.
	git := &fakeGit{}
	a := newAgent(t, git, repo(1))

	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !git.has("ls-remote", "--heads", "--", repoURL) {
		t.Fatalf("expected a probe, got %v", git.calls)
	}
	if present(a.dir(key)) {
		t.Fatal("a probe must not clone")
	}
	e := entry(t, a)
	if e == nil || e.Present || !e.Synced || e.ObservedGeneration != 1 || e.LastAttempt == nil {
		t.Fatalf("expected a synced, absent entry at generation 1, got %+v", e)
	}

	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(git.calls) != 1 {
		t.Fatalf("a synced probe at the current generation must not repeat, got %v", git.calls)
	}

	// A spec change is a new question.
	var r corev1alpha1.Repo
	if err := a.Get(context.Background(), types.NamespacedName{Name: key, Namespace: ns}, &r); err != nil {
		t.Fatal(err)
	}
	r.Generation = 2
	if err := a.Update(context.Background(), &r); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(git.calls) != 2 {
		t.Fatalf("a new generation must be probed again, got %v", git.calls)
	}
	if e := entry(t, a); e.ObservedGeneration != 2 {
		t.Fatalf("expected observedGeneration 2, got %+v", e)
	}
}

func TestProbeFailureIsReportedAndRetried(t *testing.T) {
	git := &fakeGit{fail: map[string]string{"ls-remote": "fatal: could not read Username for 'https://github.com'"}}
	a := newAgent(t, git, repo(1))
	_, err := reconcile1(t, a)
	if err == nil {
		t.Fatal("a failed probe must return an error so the queue retries with backoff")
	}
	e := entry(t, a)
	if e == nil || e.Synced || e.Present || e.LastError != "fatal: could not read Username for 'https://github.com'" {
		t.Fatalf("expected git's own words in lastError, got %+v", e)
	}
	// A failed probe is retried on the next look, same generation.
	_, _ = reconcile1(t, a)
	if len(git.calls) != 2 {
		t.Fatalf("expected the probe to be retried, got %v", git.calls)
	}
}

func TestFetchesOnDemandWhenASandboxWasCreatedSinceTheLastAttempt(t *testing.T) {
	// ADR-0051: on demand before an attach — a Sandbox created after the last
	// attempt asks for a fetch, so its Ready sees lastFetched ≥ its creation.
	git := &fakeGit{}
	last := fixedNow.Add(-time.Minute)
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(last), LastFetched: ts(last), ObservedGeneration: 1}),
		sandboxOn("sb", node, fixedNow.Add(-30*time.Second)),
	)
	dir := makePresent(t, a)

	res, err := reconcile1(t, a)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !git.has("fetch", "origin") {
		t.Fatalf("expected a fetch, got %v", git.calls)
	}
	if git.has(gitClone, "--bare", "--", repoURL, dir) {
		t.Fatal("a present cache is never re-cloned")
	}
	for _, kv := range gcPins {
		if !git.has(pinned(kv)...) {
			t.Fatalf("a present cache is re-pinned on every look (adopt-pin), missing %v in %v", kv, git.calls)
		}
	}
	e := entry(t, a)
	if !e.LastFetched.Time.Equal(fixedNow) || !e.Synced || !e.Present {
		t.Fatalf("expected lastFetched advanced to now, got %+v", e)
	}
	if res.RequeueAfter != defaultRefreshInterval {
		t.Fatalf("expected a requeue at the refresh interval, got %v", res.RequeueAfter)
	}
}

func TestFetchesOnTheIntervalAndWaitsOtherwise(t *testing.T) {
	git := &fakeGit{}
	fresh := fixedNow.Add(-time.Minute)
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(fresh), LastFetched: ts(fresh), ObservedGeneration: 1}),
	)
	makePresent(t, a)

	res, err := reconcile1(t, a)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if git.has("fetch", "origin") {
		t.Fatalf("a cache fetched a minute ago with nobody asking must wait, got %v", git.calls)
	}
	if res.RequeueAfter != 4*time.Minute {
		t.Fatalf("expected a requeue for the rest of the interval (4m), got %v", res.RequeueAfter)
	}

	// Past the interval: fetch.
	git2 := &fakeGit{}
	old := fixedNow.Add(-6 * time.Minute)
	b := newAgent(t, git2,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(old), LastFetched: ts(old), ObservedGeneration: 1}),
	)
	makePresent(t, b)
	if _, err := reconcile1(t, b); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !git2.has("fetch", "origin") {
		t.Fatalf("expected an interval fetch, got %v", git2.calls)
	}
}

func TestSpecChangeRepointsOriginAndFetches(t *testing.T) {
	git := &fakeGit{}
	fresh := fixedNow.Add(-time.Minute)
	a := newAgent(t, git,
		repo(2, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(fresh), LastFetched: ts(fresh), ObservedGeneration: 1}),
	)
	makePresent(t, a)
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !git.has(gitConfig, "--", "remote.origin.url", repoURL) || !git.has("fetch", "origin") {
		t.Fatalf("a new generation must re-point origin and fetch, got %v", git.calls)
	}
	if e := entry(t, a); e.ObservedGeneration != 2 {
		t.Fatalf("expected observedGeneration 2, got %+v", e)
	}
}

func TestFetchFailureKeepsLastFetchedAndDegradesToStale(t *testing.T) {
	// ADR-0051: freshness degrades, absence does not. The cache stays present
	// with the objects it holds; lastFetched still says when they were true.
	git := &fakeGit{fail: map[string]string{"fetch": "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host"}}
	old := fixedNow.Add(-10 * time.Minute)
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(old), LastFetched: ts(old), ObservedGeneration: 1}),
		sandboxOn("sb", node, fixedNow),
	)
	makePresent(t, a)

	res, err := reconcile1(t, a)
	if err != nil {
		t.Fatalf("a failed fetch degrades, it does not error: %v", err)
	}
	e := entry(t, a)
	if !e.Present || e.Synced || !strings.Contains(e.LastError, "Could not resolve host") {
		t.Fatalf("expected present, unsynced, with git's words, got %+v", e)
	}
	if !e.LastFetched.Time.Equal(old) {
		t.Fatalf("lastFetched must stay at the last success, got %v", e.LastFetched)
	}
	if !e.LastAttempt.Time.Equal(fixedNow) {
		t.Fatalf("lastAttempt must record the failed attempt, got %v", e.LastAttempt)
	}
	if !present(a.dir(key)) {
		t.Fatal("a stale cache is still a cache")
	}
	if res.RequeueAfter != defaultRefreshInterval {
		t.Fatalf("expected the next look at the interval, got %v", res.RequeueAfter)
	}
}

func TestCloneFailureLeavesNoCacheAndReports(t *testing.T) {
	// ADR-0051: a half clone is never present; the error is the Repo's status
	// for the operator's RepoCloneFailed and `j2 status`.
	git := &fakeGit{fail: map[string]string{"clone": "fatal: repository 'https://github.com/acme/app.git/' not found"}}
	a := newAgent(t, git, repo(1), sandboxOn("sb", node, fixedNow))

	_, err := reconcile1(t, a)
	if err == nil {
		t.Fatal("a failed clone must return an error so the queue retries with backoff")
	}
	if present(a.dir(key)) {
		t.Fatal("a failed clone must not leave a cache that reads as present")
	}
	if _, err := os.Stat(a.marker(key)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the clone marker must be cleared with the half clone")
	}
	e := entry(t, a)
	if e == nil || e.Present || e.Synced || e.LastError != "fatal: repository 'https://github.com/acme/app.git/' not found" || e.LastFetched != nil {
		t.Fatalf("expected an absent, unsynced entry with git's words, got %+v", e)
	}
	if !e.LastAttempt.Time.Equal(fixedNow) {
		t.Fatalf("lastAttempt must record the failed clone, got %v", e.LastAttempt)
	}
}

func TestCloneFailureKeepsTheDirectoryTheKubeletMade(t *testing.T) {
	// The kubelet creates the hostPath directory for the Sandbox pod before
	// the agent clones; a bind mount follows the inode, so the agent empties
	// the directory and clones into it again rather than replacing it.
	git := &fakeGit{fail: map[string]string{"clone": "fatal: early EOF"}}
	a := newAgent(t, git, repo(1), sandboxOn("sb", node, fixedNow))
	if err := os.MkdirAll(a.dir(key), 0o755); err != nil {
		t.Fatal(err)
	}
	_, _ = reconcile1(t, a)
	info, err := os.Stat(a.dir(key))
	if err != nil || !info.IsDir() {
		t.Fatalf("the directory itself must survive a failed clone: %v", err)
	}
	entries, _ := os.ReadDir(a.dir(key))
	if len(entries) != 0 {
		t.Fatalf("the failed clone's contents must be gone, got %d entries", len(entries))
	}
}

func TestAHalfCloneWithItsMarkerIsDiscarded(t *testing.T) {
	// A crash between the marker and the pin leaves HEAD behind; the marker
	// says it was never finished.
	git := &fakeGit{}
	a := newAgent(t, git, repo(1), sandboxOn("sb", node, fixedNow))
	makePresent(t, a)
	if err := os.WriteFile(a.marker(key), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !git.has(gitClone, "--bare", "--", repoURL, a.dir(key)) {
		t.Fatalf("a marked directory must be re-cloned, not fetched: %v", git.calls)
	}
}

func TestADeletedRepoIsEvictedOnlyOnceNothingOnThisNodeMountsIt(t *testing.T) {
	// ADR-0051: the cache agent removes the node copy on CR deletion, once no
	// pod on that node mounts it.
	git := &fakeGit{}
	a := newAgent(t, git, sandboxOn("sb", node, fixedNow))
	dir := makePresent(t, a)

	res, err := reconcile1(t, a)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !present(dir) {
		t.Fatal("a cache a Sandbox on this node still mounts must survive the Repo's deletion")
	}
	if res.RequeueAfter != evictRetry {
		t.Fatalf("expected a later look at eviction, got %v", res.RequeueAfter)
	}

	b := newAgent(t, git)
	dir = makePresent(t, b)
	if _, err := reconcile1(t, b); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a cache nothing mounts must be removed with its Repo")
	}
	if len(git.calls) != 0 {
		t.Fatalf("eviction needs no git, got %v", git.calls)
	}
}

func TestSweepAdoptsWhatIsMountedAndRemovesTheRest(t *testing.T) {
	// ADR-0004: a checkout found with no Repo resource is adopted and pinned
	// but not refreshed, and evicted like any other once nothing mounts it.
	git := &fakeGit{}
	a := newAgent(t, git, repo(1), sandboxOn("sb", node, fixedNow))
	// Named by a Repo: the reconciler's business, not the sweep's.
	makePresent(t, a)
	mounted := filepath.Join(a.CacheDir, "orphan-mounted")
	unmounted := filepath.Join(a.CacheDir, "orphan-unmounted")
	for _, d := range []string{mounted, unmounted} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	sb := sandboxOn("sb-orphan", node, fixedNow)
	sb.Spec.Repos = []corev1alpha1.SandboxRepo{{Key: "orphan-mounted", URL: "https://example.test/orphan.git"}}
	if err := a.Create(context.Background(), sb); err != nil {
		t.Fatal(err)
	}

	if err := a.Sweep(context.Background()); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if !present(mounted) {
		t.Fatal("an adopted cache a Sandbox mounts must stay")
	}
	if _, err := os.Stat(unmounted); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a cache no Repo names and nothing mounts must be removed")
	}
	if !present(a.dir(key)) {
		t.Fatal("a cache its Repo names is not the sweep's to touch")
	}
	pins := 0
	for _, c := range git.calls {
		if slices.Equal(c, pinned(gcPins[1])) {
			pins++
		}
	}
	if pins != 1 {
		t.Fatalf("exactly the adopted cache is pinned, got %v", git.calls)
	}
}

func TestAMissingSecretIsReportedWithoutTouchingGit(t *testing.T) {
	// ADR-0047/0051: the fix is the user's; no network attempt says so faster.
	git := &fakeGit{}
	r := repo(1)
	r.Spec.SecretRef = &corev1.LocalObjectReference{Name: "j2-git-ssh"}
	a := newAgent(t, git, r, sandboxOn("sb", node, fixedNow))

	if _, err := reconcile1(t, a); err == nil {
		t.Fatal("expected an error so the queue retries once the Secret exists")
	}
	if len(git.calls) != 0 {
		t.Fatalf("no git call may run without its credential, got %v", git.calls)
	}
	e := entry(t, a)
	want := `secret "j2-git-ssh" not found — create it (ADR-0047) or fix git.credentials`
	if e == nil || e.Present || e.Synced || e.LastError != want {
		t.Fatalf("expected %q in lastError, got %+v", want, e)
	}
}

func TestReportReplacesOnlyThisNodesEntry(t *testing.T) {
	git := &fakeGit{}
	other := corev1alpha1.RepoNodeStatus{Node: "node-b", Present: true, Synced: false, LastError: "theirs"}
	a := newAgent(t, git, repo(1, other, corev1alpha1.RepoNodeStatus{Node: node, Present: false, Synced: false, LastError: "old"}))
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	var r corev1alpha1.Repo
	if err := a.Get(context.Background(), types.NamespacedName{Name: key, Namespace: ns}, &r); err != nil {
		t.Fatal(err)
	}
	if len(r.Status.Nodes) != 2 {
		t.Fatalf("expected two entries, got %+v", r.Status.Nodes)
	}
	if r.Status.Nodes[0] != other {
		t.Fatalf("another node's entry must be left as written, got %+v", r.Status.Nodes[0])
	}
	if r.Status.Nodes[1].Node != node || !r.Status.Nodes[1].Synced || r.Status.Nodes[1].LastError != "" {
		t.Fatalf("expected this node's entry replaced by the probe's, got %+v", r.Status.Nodes[1])
	}
}

func TestReposOfSandboxMapsOnlyThisNode(t *testing.T) {
	a := newAgent(t, &fakeGit{})
	here := a.reposOfSandbox(context.Background(), sandboxOn("sb", node, fixedNow))
	if len(here) != 1 || here[0].Name != key || here[0].Namespace != ns {
		t.Fatalf("expected one request for the key, got %v", here)
	}
	if elsewhere := a.reposOfSandbox(context.Background(), sandboxOn("sb", "node-b", fixedNow)); len(elsewhere) != 0 {
		t.Fatalf("a Sandbox on another node is not this agent's, got %v", elsewhere)
	}
	if unscheduled := a.reposOfSandbox(context.Background(), sandboxOn("sb", "", fixedNow)); len(unscheduled) != 0 {
		t.Fatalf("an unscheduled Sandbox asks nothing of any node yet, got %v", unscheduled)
	}
}
