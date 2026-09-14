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
	"sigs.k8s.io/controller-runtime/pkg/event"
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

// fakeGit records every invocation — its arguments, its environment, and
// how much of a budget its context carried (zero for none) — and answers
// from a table keyed by the first argument. A clone that succeeds leaves a
// bare repo's HEAD behind, as git would; nothing else touches the disk.
type fakeGit struct {
	calls   [][]string
	envs    [][]string
	budgets []time.Duration
	fail    map[string]string // subcommand → error text (git's words)
}

func (g *fakeGit) Run(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	g.calls = append(g.calls, args)
	g.envs = append(g.envs, env)
	var budget time.Duration
	if deadline, ok := ctx.Deadline(); ok {
		budget = time.Until(deadline)
	}
	g.budgets = append(g.budgets, budget)
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

// count is how many times exactly this invocation was made.
func (g *fakeGit) count(args ...string) int {
	n := 0
	for _, c := range g.calls {
		if slices.Equal(c, args) {
			n++
		}
	}
	return n
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
		WithStatusSubresource(&corev1alpha1.Repo{}).
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

// podOn is a Sandbox's pod scheduled onto `on`, mounting the key's cache the
// way the operator mounts it — a hostPath volume at HostPath(ns, key) —
// created at t.
func podOn(name, on string, created time.Time) *corev1.Pod {
	return podMounting(name, on, created, key)
}

func podMounting(name, on string, created time.Time, keys ...string) *corev1.Pod {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, CreationTimestamp: metav1.NewTime(created)},
		Spec: corev1.PodSpec{
			NodeName:   on,
			Containers: []corev1.Container{{Name: "harness", Image: "harness:latest"}},
			Volumes: []corev1.Volume{{
				Name:         "work",
				VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
			}},
		},
		Status: corev1.PodStatus{Phase: corev1.PodRunning},
	}
	for _, k := range keys {
		pod.Spec.Volumes = append(pod.Spec.Volumes, corev1.Volume{
			Name:         "repo-" + k,
			VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: HostPath(ns, k)}},
		})
	}
	return pod
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
	a := newAgent(t, git, repo(1), podOn("sb", node, fixedNow.Add(-time.Minute)))

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
	a = newAgent(t, git, withURL(repo(1)), podOn("sb", node, fixedNow.Add(-time.Minute)))
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

func TestAPodOnAnotherNodeIsNotDemand(t *testing.T) {
	git := &fakeGit{}
	a := newAgent(t, git, repo(1), podOn("sb", "node-b", fixedNow))
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if got := git.subcommands(); !slices.Equal(got, []string{"ls-remote"}) {
		t.Fatalf("another node's pod should leave this node probing, not cloning: %v", got)
	}
}

func TestATerminatedPodIsNotDemandButATerminatingOneIs(t *testing.T) {
	// A pod whose containers are done (Failed, Succeeded) holds no mount; one
	// the kubelet is still tearing down does, until it is gone.
	failed := podOn("sb-failed", node, fixedNow)
	failed.Status.Phase = corev1.PodFailed
	git := &fakeGit{}
	a := newAgent(t, git, repo(1), failed)
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if got := git.subcommands(); !slices.Equal(got, []string{"ls-remote"}) {
		t.Fatalf("a Failed pod mounts nothing, so this node probes: %v", got)
	}

	terminating := podOn("sb-terminating", node, fixedNow)
	terminating.DeletionTimestamp = ts(fixedNow)
	terminating.Finalizers = []string{"kubernetes"}
	git = &fakeGit{}
	b := newAgent(t, git, repo(1), terminating)
	if _, err := reconcile1(t, b); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !git.has(gitClone, "--bare", "--", repoURL, b.dir(key)) {
		t.Fatalf("a terminating pod still mounts the cache and is demand, got %v", git.calls)
	}
}

func TestRemoteGitCallsAreBudgetedAndLocalOnesAreNot(t *testing.T) {
	// A git child that hangs would hold this node's one worker and every
	// other Repo's fetch with it: each call to the remote carries its budget —
	// clone its own, fetch and probe theirs — while `git config` in the cache
	// carries none.
	budgetOf := func(git *fakeGit, sub string) time.Duration {
		t.Helper()
		for i, c := range git.calls {
			if c[0] == sub {
				return git.budgets[i]
			}
		}
		t.Fatalf("no %s call in %v", sub, git.calls)
		return 0
	}
	within := func(got, want time.Duration) bool { return got > want-time.Minute && got <= want }

	git := &fakeGit{}
	a := newAgent(t, git, repo(1), podOn("sb", node, fixedNow))
	a.CloneTimeout, a.FetchTimeout = 7*time.Minute, 3*time.Minute
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("clone: %v", err)
	}
	if got := budgetOf(git, gitClone); !within(got, 7*time.Minute) {
		t.Fatalf("the clone must carry CloneTimeout, got %v", got)
	}
	if got := budgetOf(git, gitConfig); got != 0 {
		t.Fatalf("a local git config call needs no budget, got %v", got)
	}

	git = &fakeGit{}
	b := newAgent(t, git, repo(1))
	b.FetchTimeout = 3 * time.Minute
	if _, err := reconcile1(t, b); err != nil {
		t.Fatalf("probe: %v", err)
	}
	if got := budgetOf(git, "ls-remote"); !within(got, 3*time.Minute) {
		t.Fatalf("the probe must carry FetchTimeout, got %v", got)
	}

	git = &fakeGit{}
	old := fixedNow.Add(-10 * time.Minute)
	c := newAgent(t, git, repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(old), LastFetched: ts(old), ObservedGeneration: 1}))
	makePresent(t, c)
	if _, err := reconcile1(t, c); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if got := budgetOf(git, "fetch"); !within(got, defaultFetchTimeout) {
		t.Fatalf("an unset FetchTimeout means the default, got %v", got)
	}
}

func TestTheFetchASandboxWaitsOnCarriesTheShortBudget(t *testing.T) {
	// ADR-0051: a Sandbox's Ready is held on the fetch before its attach, and
	// "freshness degrades, absence does not" is only true if that fetch fails
	// inside the wait — a hung remote must become a stale Ready, not a
	// provision that times out. So the on-demand fetch carries its own short
	// budget, while the interval fetch, with nobody waiting, keeps the full
	// one; a cache the on-demand fetch could not refresh in time is landed by
	// the interval fetch afterwards.
	budgetOf := func(git *fakeGit) time.Duration {
		t.Helper()
		for i, c := range git.calls {
			if c[0] == "fetch" {
				return git.budgets[i]
			}
		}
		t.Fatalf("no fetch call in %v", git.calls)
		return 0
	}
	within := func(got, want time.Duration) bool { return got > want-time.Second && got <= want }
	warm := func(last time.Time) corev1alpha1.RepoNodeStatus {
		return corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(last), LastFetched: ts(last), ObservedGeneration: 1}
	}

	// A pod created since the last attempt: on demand, the default short budget.
	git := &fakeGit{}
	a := newAgent(t, git, repo(1, warm(fixedNow.Add(-time.Minute))), podOn("sb", node, fixedNow.Add(-30*time.Second)))
	makePresent(t, a)
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("on-demand fetch: %v", err)
	}
	if got := budgetOf(git); !within(got, defaultOnDemandFetchTimeout) {
		t.Fatalf("the fetch a Sandbox waits on must carry the on-demand budget (%v), got %v", defaultOnDemandFetchTimeout, got)
	}
	if defaultOnDemandFetchTimeout >= defaultFetchTimeout {
		t.Fatalf("the on-demand budget (%v) must be the short one, inside the interval budget (%v)", defaultOnDemandFetchTimeout, defaultFetchTimeout)
	}

	// The same demand with the flag set: the flag's value.
	git = &fakeGit{}
	b := newAgent(t, git, repo(1, warm(fixedNow.Add(-time.Minute))), podOn("sb", node, fixedNow.Add(-30*time.Second)))
	b.OnDemandFetchTimeout, b.FetchTimeout = 20*time.Second, 3*time.Minute
	makePresent(t, b)
	if _, err := reconcile1(t, b); err != nil {
		t.Fatalf("on-demand fetch: %v", err)
	}
	if got := budgetOf(git); !within(got, 20*time.Second) {
		t.Fatalf("an on-demand fetch must carry OnDemandFetchTimeout, not FetchTimeout, got %v", got)
	}

	// The interval, with the same pod already served by an earlier attempt:
	// nobody waits, so the full budget.
	git = &fakeGit{}
	c := newAgent(t, git, repo(1, warm(fixedNow.Add(-6*time.Minute))), podOn("sb", node, fixedNow.Add(-10*time.Minute)))
	c.OnDemandFetchTimeout, c.FetchTimeout = 20*time.Second, 3*time.Minute
	makePresent(t, c)
	if _, err := reconcile1(t, c); err != nil {
		t.Fatalf("interval fetch: %v", err)
	}
	if got := budgetOf(git); !within(got, 3*time.Minute) {
		t.Fatalf("an interval fetch must carry FetchTimeout, got %v", got)
	}
}

func TestOwnStatusWritesDoNotWakeTheAgent(t *testing.T) {
	// The agent writes its node's entry and then returns an error for the
	// backoff; if that write's event re-queued the key the backoff would never
	// apply and a bad credential would be retried once per second from every
	// node. A Repo wakes the agent on creation, deletion, and a spec change.
	events := repoEvents()
	before := repo(1)
	after := repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: false, Synced: false, LastAttempt: ts(fixedNow), LastError: "fatal: Authentication failed"})
	after.ResourceVersion = "2"
	if events.Update(event.UpdateEvent{ObjectOld: before, ObjectNew: after}) {
		t.Fatal("a status-only write must not wake the agent")
	}
	if !events.Update(event.UpdateEvent{ObjectOld: before, ObjectNew: repo(2)}) {
		t.Fatal("a spec change (new generation) must wake the agent")
	}
	if !events.Create(event.CreateEvent{Object: before}) {
		t.Fatal("a new Repo must wake the agent")
	}
	if !events.Delete(event.DeleteEvent{Object: before}) {
		t.Fatal("a deleted Repo must wake the agent, so it evicts")
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
	if e == nil || e.Present || !e.Synced || e.Attempted != corev1alpha1.RepoAttemptProbe || e.ObservedGeneration != 1 || e.LastAttempt == nil {
		t.Fatalf("expected a synced, absent entry at generation 1 that says it was a probe, got %+v", e)
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
	// The entry says it was a probe: a Sandbox that lands on this node next is
	// held for the clone, not failed for an error no clone produced.
	if e.Attempted != corev1alpha1.RepoAttemptProbe {
		t.Fatalf("a failed probe must say it was a probe, got %+v", e)
	}
	// A failed probe is retried on the next look, same generation.
	_, _ = reconcile1(t, a)
	if len(git.calls) != 2 {
		t.Fatalf("expected the probe to be retried, got %v", git.calls)
	}
}

func TestAVanishedCacheIsReportedAbsent(t *testing.T) {
	// ADR-0051: the entry is what places Sandboxes and what `j2 status`
	// shows. One that says present for a cache this node no longer holds (the
	// directory removed by hand, the node re-imaged under its name) must not
	// stand until a pod happens to land and force a clone: the probe rewrites
	// it absent on the next look.
	git := &fakeGit{}
	old := fixedNow.Add(-10 * time.Minute)
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, Attempted: corev1alpha1.RepoAttemptFetch, LastAttempt: ts(old), LastFetched: ts(old), ObservedGeneration: 1}),
	)

	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !git.has("ls-remote", "--heads", "--", repoURL) {
		t.Fatalf("a present entry over a missing cache must be probed, got %v", git.calls)
	}
	e := entry(t, a)
	if e == nil || e.Present || !e.Synced || e.Attempted != corev1alpha1.RepoAttemptProbe || e.LastFetched != nil {
		t.Fatalf("expected the entry rewritten absent by the probe, got %+v", e)
	}

	// Corrected once: an absent, synced entry at this generation is skipped.
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(git.calls) != 1 {
		t.Fatalf("an absent, synced entry must not be probed again, got %v", git.calls)
	}
}

func TestPinFailureOnAPresentCacheIsReportedBeforeTheBackoff(t *testing.T) {
	// ADR-0048/0051: every failure is in the entry. A pin refused on a
	// present cache (a checkout another uid owns, a read-only disk) returns
	// an error for the backoff, but the entry says present, unsynced, with
	// git's words first — so the Sandbox waiting here goes Ready stale
	// instead of Pending until its budget expires, and `j2 status` names the
	// cause. Nothing fetches into a cache that cannot be pinned (ADR-0004).
	git := &fakeGit{fail: map[string]string{gitConfig: "fatal: detected dubious ownership in repository at '/var/lib/j2/j2-test/repos/app-0a1b2c3d'"}}
	old := fixedNow.Add(-10 * time.Minute)
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, Attempted: corev1alpha1.RepoAttemptFetch, LastAttempt: ts(old), LastFetched: ts(old), ObservedGeneration: 1}),
		podOn("sb", node, fixedNow),
	)
	makePresent(t, a)

	_, err := reconcile1(t, a)
	if err == nil {
		t.Fatal("a failed pin must return an error so the queue retries with backoff")
	}
	if slices.Contains(git.subcommands(), "fetch") {
		t.Fatalf("nothing fetches into a cache that cannot be pinned, got %v", git.calls)
	}
	e := entry(t, a)
	if e == nil || !e.Present || e.Synced || e.Attempted != corev1alpha1.RepoAttemptFetch || !strings.Contains(e.LastError, "dubious ownership") {
		t.Fatalf("expected present, unsynced, with git's words, got %+v", e)
	}
	if e.LastAttempt == nil || !e.LastAttempt.Time.Equal(fixedNow) {
		t.Fatalf("lastAttempt must record the failed pin, got %v", e.LastAttempt)
	}
	if e.LastFetched == nil || !e.LastFetched.Time.Equal(old) {
		t.Fatalf("lastFetched must stay at the last success, got %v", e.LastFetched)
	}
	if e.ObservedGeneration != 1 {
		t.Fatalf("expected observedGeneration 1, got %+v", e)
	}
}

func TestFetchesOnDemandWhenAPodWasCreatedSinceTheLastAttempt(t *testing.T) {
	// ADR-0051: on demand before an attach — a pod created after the last
	// attempt asks for a fetch, so its Sandbox's Ready sees lastFetched ≥ its
	// creation (the pod is the younger of the two).
	git := &fakeGit{}
	last := fixedNow.Add(-time.Minute)
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(last), LastFetched: ts(last), ObservedGeneration: 1}),
		podOn("sb", node, fixedNow.Add(-30*time.Second)),
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
	if !e.LastFetched.Time.Equal(fixedNow) || !e.Synced || !e.Present || e.Attempted != corev1alpha1.RepoAttemptFetch {
		t.Fatalf("expected lastFetched advanced to now by a fetch, got %+v", e)
	}
	if res.RequeueAfter != defaultRefreshInterval {
		t.Fatalf("expected a requeue at the refresh interval, got %v", res.RequeueAfter)
	}
}

// TestAnAskOnAPodIsDemandAfterItsCreation pins the in-pod fetch (ADR-0053):
// a pod older than the last attempt asks for nothing, until the operator
// copies an ask onto it. The ask is a mark, not a queue — the newest ask over
// the pods on this node is the bar, and a fetch that already started after it
// satisfies every pod that raised it.
func TestAnAskOnAPodIsDemandAfterItsCreation(t *testing.T) {
	last := fixedNow.Add(-time.Minute)
	born := fixedNow.Add(-10 * time.Minute)
	entryAt := func() corev1alpha1.RepoNodeStatus {
		return corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(last), LastFetched: ts(last), ObservedGeneration: 1}
	}
	asked := func(ask string) *corev1.Pod {
		pod := podOn("sb", node, born)
		if ask != "" {
			pod.Annotations = map[string]string{corev1alpha1.AskedAnnotation(key): ask}
		}
		return pod
	}
	fetches := func(t *testing.T, pod *corev1.Pod) bool {
		t.Helper()
		git := &fakeGit{}
		a := newAgent(t, git, repo(1, entryAt()), pod)
		makePresent(t, a)
		if _, err := reconcile1(t, a); err != nil {
			t.Fatalf("reconcile: %v", err)
		}
		return git.has("fetch", "origin")
	}

	if fetches(t, asked("")) {
		t.Fatal("a pod older than the last attempt asks for nothing; the interval is what fetches")
	}
	if fetches(t, asked(last.Add(-time.Minute).UTC().Format(time.RFC3339))) {
		t.Fatal("an ask the last attempt already answered must not fetch again — the mark coalesces")
	}
	if !fetches(t, asked(fixedNow.Add(-30*time.Second).UTC().Format(time.RFC3339))) {
		t.Fatal("an ask marked since the last attempt is demand")
	}
	if fetches(t, asked("whenever")) {
		t.Fatal("an unparseable ask is treated as absent")
	}
	// The agent stamps every attempt at the second, and the ask is raised to
	// the NEXT one: an attempt that began half a second before the ask cannot
	// hold what the ask is about, so it does not answer it. The cost of being
	// wrong this way round is a wait of under a second before the next fetch;
	// the other way round is a `git fetch` that reports success without the
	// commit (ADR-0053).
	if !fetches(t, asked(last.Add(500*time.Millisecond).UTC().Format(time.RFC3339Nano))) {
		t.Fatal("an ask made after the attempt began, inside its second, is still an ask")
	}
	if fetches(t, asked(last.UTC().Format(time.RFC3339))) {
		t.Fatal("an attempt that began at the ask's own instant answers it — the mark coalesces")
	}
}

// TestTheNewestAskOverTheNodesPodsWins pins the coalescer over pods: two
// Sandboxes on this node share one cache, so the bar is the later of their
// asks and one fetch answers both (ADR-0053).
func TestTheNewestAskOverTheNodesPodsWins(t *testing.T) {
	last := fixedNow.Add(-time.Minute)
	born := fixedNow.Add(-10 * time.Minute)
	quiet := podOn("quiet", node, born)
	loud := podOn("loud", node, born)
	loud.Annotations = map[string]string{corev1alpha1.AskedAnnotation(key): fixedNow.Add(-30 * time.Second).UTC().Format(time.RFC3339)}

	git := &fakeGit{}
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(last), LastFetched: ts(last), ObservedGeneration: 1}),
		quiet, loud,
	)
	makePresent(t, a)
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !git.has("fetch", "origin") {
		t.Fatalf("one pod's ask is the whole node's demand, got %v", git.calls)
	}
	e := entry(t, a)
	if !e.LastFetched.Time.Equal(fixedNow) {
		t.Fatalf("the attempt's start is what answers both asks, got %+v", e)
	}
}

// TestAnAskInsideTheAttemptsOwnSecondWaitsForTheTopOfTheNextAndFetchesOnce
// pins what ADR-0053's rounding costs, and that it costs a wait rather than a
// fetch. Every stamp this agent writes is the attempt's start AT THE SECOND,
// and an ask is raised to the NEXT whole second so that no fetch which began
// before it can answer it — so an attempt that began inside the ask's own
// second would be stamped BELOW the bar it was made for, and nothing it
// reported could settle that ask. Fetching then would buy the remote a second
// round trip for every `git fetch` in a pod; the agent waits out the rest of
// the second instead and fetches once, stamped at the bar. Sleeping out the
// refresh interval is the one thing it may not do: that is a `git fetch` in
// the pod waiting out its caller's whole budget.
func TestAnAskInsideTheAttemptsOwnSecondWaitsForTheTopOfTheNextAndFetchesOnce(t *testing.T) {
	last := fixedNow.Add(-time.Minute)
	pod := podOn("sb", node, fixedNow.Add(-10*time.Minute))
	// The Orchestrator marks the CR with milliseconds, and the agent wakes in
	// the same second — its clock, kept at the second, reads `now` as fixedNow.
	pod.Annotations = map[string]string{
		corev1alpha1.AskedAnnotation(key): fixedNow.Add(300 * time.Millisecond).UTC().Format(time.RFC3339Nano),
	}

	git := &fakeGit{}
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(last), LastFetched: ts(last), ObservedGeneration: 1}),
		pod,
	)
	a.Now = func() time.Time { return fixedNow.Add(450 * time.Millisecond) }
	makePresent(t, a)
	result, err := reconcile1(t, a)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if git.has("fetch", "origin") {
		t.Fatalf("a fetch begun inside the ask's own second could not answer it, so none is made, got %v", git.calls)
	}
	if e := entry(t, a); !e.LastAttempt.Time.Equal(last) {
		t.Fatalf("waiting is not an attempt; the entry stands as it was, got %+v", e)
	}
	// The remainder of THIS second on the raw clock — not a whole one.
	if result.RequeueAfter != 550*time.Millisecond {
		t.Fatalf("the agent comes back at the top of the ask's second, not in %s", result.RequeueAfter)
	}

	// At the top of that second, the fetch — once — with the stamp that answers.
	a.Now = func() time.Time { return fixedNow.Add(time.Second + 20*time.Millisecond) }
	result, err = reconcile1(t, a)
	if err != nil {
		t.Fatalf("reconcile at the ask's second: %v", err)
	}
	if n := git.count("fetch", "origin"); n != 1 {
		t.Fatalf("one ask, one fetch; got %d in %v", n, git.calls)
	}
	if e := entry(t, a); !e.LastFetched.Time.Equal(fixedNow.Add(time.Second)) {
		t.Fatalf("the stamp is the attempt's start, at the ask's second, got %+v", e)
	}
	if result.RequeueAfter != defaultRefreshInterval {
		t.Fatalf("an answered ask owes no second fetch; the next wake is the interval, got %s", result.RequeueAfter)
	}
}

// TestAFetchDueAnywayInsideAnAsksSecondRunsNowAndComesBackForTheAsk is the
// other side of that wait: a fetch the interval (or a spec change, or a first
// attempt) owes runs at once, whatever second it is — and since its stamp
// cannot settle an ask raised to the next second, the agent comes back at the
// top of that second for it rather than sleeping out the interval.
func TestAFetchDueAnywayInsideAnAsksSecondRunsNowAndComesBackForTheAsk(t *testing.T) {
	last := fixedNow.Add(-defaultRefreshInterval - time.Second)
	pod := podOn("sb", node, fixedNow.Add(-10*time.Minute))
	pod.Annotations = map[string]string{
		corev1alpha1.AskedAnnotation(key): fixedNow.Add(300 * time.Millisecond).UTC().Format(time.RFC3339Nano),
	}

	git := &fakeGit{}
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(last), LastFetched: ts(last), ObservedGeneration: 1}),
		pod,
	)
	makePresent(t, a)
	result, err := reconcile1(t, a)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !git.has("fetch", "origin") {
		t.Fatalf("the interval is due; the ask does not postpone it, got %v", git.calls)
	}
	if e := entry(t, a); !e.LastFetched.Time.Equal(fixedNow) {
		t.Fatalf("the stamp is the attempt's start, got %+v", e)
	}
	if result.RequeueAfter != time.Second {
		t.Fatalf("that stamp cannot settle the ask, so the agent comes back at the top of its second, not in %s", result.RequeueAfter)
	}
}

// TestAnAnsweredAskSleepsTheInterval is the other half: a fetch whose stamp
// clears the bar owes nothing more, so the next wake is the refresh interval
// and a fetch in the pod costs the remote exactly one round trip.
func TestAnAnsweredAskSleepsTheInterval(t *testing.T) {
	last := fixedNow.Add(-time.Minute)
	pod := podOn("sb", node, fixedNow.Add(-10*time.Minute))
	// Marked a moment BEFORE this attempt's second, so the ask is raised to the
	// second this attempt is stamped with and the stamp answers it.
	pod.Annotations = map[string]string{
		corev1alpha1.AskedAnnotation(key): fixedNow.Add(-300 * time.Millisecond).UTC().Format(time.RFC3339Nano),
	}

	git := &fakeGit{}
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(last), LastFetched: ts(last), ObservedGeneration: 1}),
		pod,
	)
	makePresent(t, a)
	result, err := reconcile1(t, a)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !git.has("fetch", "origin") {
		t.Fatalf("an ask marked since the last attempt is demand, got %v", git.calls)
	}
	if result.RequeueAfter != defaultRefreshInterval {
		t.Fatalf("an answered ask owes no second fetch; the next wake is the interval, got %s", result.RequeueAfter)
	}
}

// TestAnAskOnAPodElsewhereIsNotDemand: the ask rides a pod, and a pod on
// another node is not this node's demand — the same rule a creation follows.
func TestAnAskOnAPodElsewhereIsNotDemand(t *testing.T) {
	last := fixedNow.Add(-time.Minute)
	elsewhere := podOn("sb", "node-b", fixedNow.Add(-10*time.Minute))
	elsewhere.Annotations = map[string]string{corev1alpha1.AskedAnnotation(key): fixedNow.UTC().Format(time.RFC3339)}

	git := &fakeGit{}
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(last), LastFetched: ts(last), ObservedGeneration: 1}),
		elsewhere,
	)
	makePresent(t, a)
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if git.has("fetch", "origin") {
		t.Fatalf("an ask on another node's pod is not demand here, got %v", git.calls)
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
		podOn("sb", node, fixedNow),
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
	a := newAgent(t, git, repo(1), podOn("sb", node, fixedNow))

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
	a := newAgent(t, git, repo(1), podOn("sb", node, fixedNow))
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
	a := newAgent(t, git, repo(1), podOn("sb", node, fixedNow))
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

func TestADeletedRepoIsEvictedOnlyOnceNoPodOnThisNodeMountsIt(t *testing.T) {
	// ADR-0051: the cache agent removes the node copy on CR deletion, once no
	// pod on that node mounts it. The pod is what holds the bind mount: here
	// its Sandbox resource is already gone (no finalizer holds it) and the
	// pod is still terminating.
	git := &fakeGit{}
	terminating := podOn("sb", node, fixedNow)
	terminating.DeletionTimestamp = ts(fixedNow)
	terminating.Finalizers = []string{"kubernetes"}
	a := newAgent(t, git, terminating)
	dir := makePresent(t, a)

	res, err := reconcile1(t, a)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if !present(dir) {
		t.Fatal("a cache a pod on this node still mounts must survive the Repo's deletion")
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
	a := newAgent(t, git, repo(1), podOn("sb", node, fixedNow))
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
	if err := a.Create(context.Background(), podMounting("sb-orphan", node, fixedNow, "orphan-mounted")); err != nil {
		t.Fatal(err)
	}

	if err := a.Sweep(context.Background()); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if !present(mounted) {
		t.Fatal("an adopted cache a pod mounts must stay")
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

func TestSweepAdoptsNothingFromAMountedDirectoryWithNoClone(t *testing.T) {
	// The kubelet creates a Sandbox's hostPath leaf (`DirectoryOrCreate`)
	// before any clone lands in it; with the Repo gone, the sweep finds an
	// empty mounted directory. There is no clone to pin, and the directory
	// must stay for the pod's bind mount.
	git := &fakeGit{}
	a := newAgent(t, git)
	empty := filepath.Join(a.CacheDir, "orphan-empty")
	if err := os.MkdirAll(empty, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := a.Create(context.Background(), podMounting("sb-orphan", node, fixedNow, "orphan-empty")); err != nil {
		t.Fatal(err)
	}

	if err := a.Sweep(context.Background()); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if len(git.calls) != 0 {
		t.Fatalf("a directory with no clone has nothing to pin, got %v", git.calls)
	}
	if info, err := os.Stat(empty); err != nil || !info.IsDir() {
		t.Fatalf("the kubelet's directory must survive while the pod mounts it: %v", err)
	}
}

func TestAMissingSecretIsReportedWithoutTouchingGit(t *testing.T) {
	// ADR-0047/0051: the fix is the user's; no network attempt says so faster.
	git := &fakeGit{}
	r := repo(1)
	r.Spec.SecretRef = &corev1.LocalObjectReference{Name: "j2-git-ssh"}
	a := newAgent(t, git, r, podOn("sb", node, fixedNow))

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

func TestReposOfPodMapsOnlyThisNodesCacheMounts(t *testing.T) {
	a := newAgent(t, &fakeGit{})
	here := a.reposOfPod(context.Background(), podOn("sb", node, fixedNow))
	if len(here) != 1 || here[0].Name != key || here[0].Namespace != ns {
		t.Fatalf("expected one request for the key, got %v", here)
	}
	if elsewhere := a.reposOfPod(context.Background(), podOn("sb", "node-b", fixedNow)); len(elsewhere) != 0 {
		t.Fatalf("a pod on another node is not this agent's, got %v", elsewhere)
	}
	if unscheduled := a.reposOfPod(context.Background(), podOn("sb", "", fixedNow)); len(unscheduled) != 0 {
		t.Fatalf("an unscheduled pod asks nothing of any node yet, got %v", unscheduled)
	}
	// Only volumes over this Instance's cache directory are cache mounts: a
	// hostPath elsewhere, another Instance's directory, or the directory
	// itself (the agent's own mount) names no Repo.
	other := podOn("other", node, fixedNow)
	other.Spec.Volumes = []corev1.Volume{
		{Name: "docker", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/var/run/docker.sock"}}},
		{Name: "theirs", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: HostPath("other-ns", key)}}},
		{Name: "cache", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: HostDir(ns)}}},
	}
	if got := a.reposOfPod(context.Background(), other); len(got) != 0 {
		t.Fatalf("no volume over a cache leaf, so no request, got %v", got)
	}
}
