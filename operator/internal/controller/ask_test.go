/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package controller

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

const (
	askKey  = "app-0a1b2c3d"
	askURL  = "https://github.com/acme/app.git"
	askNode = "node-a"
)

var (
	askCreated = metav1.NewTime(time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC))
	askBefore  = metav1.NewTime(askCreated.Add(-time.Minute))
	askAfter   = metav1.NewTime(askCreated.Add(time.Minute))
	askLater   = metav1.NewTime(askCreated.Add(2 * time.Minute))
)

// askedSandbox is a Sandbox naming one Repo, created at askCreated, carrying
// the given ask annotation value for that key ("" = none).
func askedSandbox(ask string) *corev1alpha1.Sandbox {
	var annotations map[string]string
	if ask != "" {
		annotations = map[string]string{corev1alpha1.AskedAnnotation(askKey): ask}
	}
	return &corev1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name: "sb", Namespace: nsDefault,
			CreationTimestamp: askCreated,
			Annotations:       annotations,
		},
		Spec: corev1alpha1.SandboxSpec{
			Image: testHarnessImage,
			Repos: []corev1alpha1.SandboxRepo{{Key: askKey, URL: askURL}},
		},
	}
}

func askRepo(entries ...corev1alpha1.RepoNodeStatus) map[string]*corev1alpha1.Repo {
	return map[string]*corev1alpha1.Repo{askKey: {Status: corev1alpha1.RepoStatus{Nodes: entries}}}
}

// TestRepoStatuses pins the standing per-key entry ADR-0053 adds to the Sandbox
// status — the thing a fetch inside the pod waits on. Unlike Ready, it is
// recomputed every reconcile and it is measured against the ASK, not against
// the Sandbox's creation alone: a creation is an ask, and every `jr2.dev/asked-`
// annotation the Orchestrator marks afterwards is another one.
//
// `fetched` and `attempted` are the node's own stamps, reported whatever they
// say: a reader compares them against the entry's own `asked`, and a landing
// OLDER than the ask is what a degraded answer names the cache's objects by.
// `error` is the one field scoped to the ask — git's words about an attempt
// made before it are not an answer to this one, and a caller told otherwise
// would be refused a fetch on the strength of a minutes-old failure.
func TestRepoStatuses(t *testing.T) {
	cases := []struct {
		name      string
		ask       string
		node      string
		repos     map[string]*corev1alpha1.Repo
		want      []corev1alpha1.SandboxRepoStatus
		wantEmpty bool
	}{
		{
			name:      "no node yet reports nothing — there is no cache to report on",
			node:      "",
			repos:     askRepo(corev1alpha1.RepoNodeStatus{Node: askNode, Present: true, Synced: true, LastFetched: &askAfter}),
			wantEmpty: true,
		},
		{
			name:  "no Repo resource leaves the ask unanswered, not failed",
			node:  askNode,
			repos: map[string]*corev1alpha1.Repo{},
			want:  []corev1alpha1.SandboxRepoStatus{{Key: askKey, Asked: askCreated}},
		},
		{
			name:  "no entry for this node leaves the ask unanswered",
			node:  askNode,
			repos: askRepo(corev1alpha1.RepoNodeStatus{Node: "node-b", Present: true, Synced: true, LastFetched: &askAfter}),
			want:  []corev1alpha1.SandboxRepoStatus{{Key: askKey, Asked: askCreated}},
		},
		{
			name:  "a creation is an ask: a fetch since it answers it",
			node:  askNode,
			repos: askRepo(corev1alpha1.RepoNodeStatus{Node: askNode, Present: true, Synced: true, LastAttempt: &askAfter, LastFetched: &askAfter}),
			want:  []corev1alpha1.SandboxRepoStatus{{Key: askKey, Asked: askCreated, Fetched: &askAfter, Attempted: &askAfter}},
		},
		{
			// The bar moves, and the older fetch is still REPORTED — it is
			// simply behind the bar. That is the reading a caller makes, and
			// the timestamp a degraded answer dates the cache by.
			name:  "an ask after creation moves the bar past the older fetch, which is still named",
			ask:   askAfter.UTC().Format(time.RFC3339),
			node:  askNode,
			repos: askRepo(corev1alpha1.RepoNodeStatus{Node: askNode, Present: true, Synced: true, LastAttempt: &askCreated, LastFetched: &askCreated}),
			want:  []corev1alpha1.SandboxRepoStatus{{Key: askKey, Asked: askAfter, Fetched: &askCreated, Attempted: &askCreated}},
		},
		{
			name:  "and the fetch that follows the ask answers it",
			ask:   askAfter.UTC().Format(time.RFC3339),
			node:  askNode,
			repos: askRepo(corev1alpha1.RepoNodeStatus{Node: askNode, Present: true, Synced: true, LastAttempt: &askLater, LastFetched: &askLater}),
			want:  []corev1alpha1.SandboxRepoStatus{{Key: askKey, Asked: askAfter, Fetched: &askLater, Attempted: &askLater}},
		},
		{
			name:  "an ask before creation never moves the bar backwards",
			ask:   askBefore.UTC().Format(time.RFC3339),
			node:  askNode,
			repos: askRepo(corev1alpha1.RepoNodeStatus{Node: askNode, Present: true, Synced: true, LastAttempt: &askAfter, LastFetched: &askAfter}),
			want:  []corev1alpha1.SandboxRepoStatus{{Key: askKey, Asked: askCreated, Fetched: &askAfter, Attempted: &askAfter}},
		},
		{
			name:  "an unparseable ask is treated as absent",
			ask:   "whenever",
			node:  askNode,
			repos: askRepo(corev1alpha1.RepoNodeStatus{Node: askNode, Present: true, Synced: true, LastAttempt: &askAfter, LastFetched: &askAfter}),
			want:  []corev1alpha1.SandboxRepoStatus{{Key: askKey, Asked: askCreated, Fetched: &askAfter, Attempted: &askAfter}},
		},
		{
			// The degraded answer, whole: git's words for THIS ask's attempt,
			// and the older landing they leave standing — "serving the cache
			// as of <fetched>" is written from exactly these two fields.
			name: "an attempt for this ask that failed carries git's words beside the cache's date",
			ask:  askAfter.UTC().Format(time.RFC3339),
			node: askNode,
			repos: askRepo(corev1alpha1.RepoNodeStatus{
				Node: askNode, Present: true, Synced: false,
				LastAttempt: &askLater, LastFetched: &askCreated, LastError: "could not read from remote",
			}),
			want: []corev1alpha1.SandboxRepoStatus{{Key: askKey, Asked: askAfter, Fetched: &askCreated, Attempted: &askLater, Error: "could not read from remote"}},
		},
		{
			name: "a failure that predates the ask is not this ask's answer",
			ask:  askLater.UTC().Format(time.RFC3339),
			node: askNode,
			repos: askRepo(corev1alpha1.RepoNodeStatus{
				Node: askNode, Present: true, Synced: false,
				LastAttempt: &askAfter, LastFetched: &askCreated, LastError: "could not read from remote",
			}),
			want: []corev1alpha1.SandboxRepoStatus{{Key: askKey, Asked: askLater, Fetched: &askCreated, Attempted: &askAfter}},
		},
		{
			name: "a cold node that could not clone answers the ask with the error",
			node: askNode,
			repos: askRepo(corev1alpha1.RepoNodeStatus{
				Node: askNode, Present: false, Synced: false,
				Attempted: corev1alpha1.RepoAttemptClone, LastAttempt: &askAfter, LastError: "repository not found",
			}),
			want: []corev1alpha1.SandboxRepoStatus{{Key: askKey, Asked: askCreated, Attempted: &askAfter, Error: "repository not found"}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := repoStatuses(context.Background(), askedSandbox(tc.ask), tc.node, tc.repos)
			if tc.wantEmpty {
				if got != nil {
					t.Fatalf("want no entries, got %+v", got)
				}
				return
			}
			if len(got) != len(tc.want) {
				t.Fatalf("want %d entries, got %+v", len(tc.want), got)
			}
			for i, want := range tc.want {
				if !sameRepoStatus(got[i], want) {
					t.Fatalf("entry %d: want %s, got %s", i, showRepoStatus(want), showRepoStatus(got[i]))
				}
			}
		})
	}

	t.Run("one entry per key, in declaration order", func(t *testing.T) {
		two := askedSandbox("")
		two.Spec.Repos = append(two.Spec.Repos, corev1alpha1.SandboxRepo{Key: "docs-4e5f6a7b", URL: "https://github.com/acme/docs.git"})
		got := repoStatuses(context.Background(), two, askNode, askRepo())
		if len(got) != 2 || got[0].Key != askKey || got[1].Key != "docs-4e5f6a7b" {
			t.Fatalf("want both keys in declaration order, got %+v", got)
		}
	})

	t.Run("a Sandbox naming no Repo reports nothing", func(t *testing.T) {
		none := askedSandbox("")
		none.Spec.Repos = nil
		if got := repoStatuses(context.Background(), none, askNode, nil); got != nil {
			t.Fatalf("want no entries, got %+v", got)
		}
	})

	// The node stamps every attempt with its START, at the second. So the ask
	// is raised to the NEXT second: a fetch that began before the ask cannot
	// hold what the ask is about, and counting it would answer a `git fetch`
	// with the commit it was asking for still missing (ADR-0053). The node
	// raises its own copy of the annotation the same way, so both sides read
	// one bar.
	t.Run("the ask is raised to the second after it", func(t *testing.T) {
		sandbox := askedSandbox(askAfter.Add(500 * time.Millisecond).UTC().Format(time.RFC3339Nano))
		next := metav1.NewTime(askAfter.Add(time.Second))
		got := repoStatuses(context.Background(), sandbox, askNode,
			askRepo(corev1alpha1.RepoNodeStatus{Node: askNode, Present: true, Synced: true, LastAttempt: &askAfter, LastFetched: &askAfter}))
		if len(got) != 1 {
			t.Fatalf("want one entry, got %+v", got)
		}
		if !got[0].Asked.Equal(&next) {
			t.Fatalf("the ask should be raised to %v, got %v", next, got[0].Asked)
		}
		// The stamps are reported whatever they say; it is the comparison
		// against this entry's own `asked` that leaves the ask outstanding.
		if got[0].Fetched == nil || !got[0].Fetched.Before(&got[0].Asked) {
			t.Fatalf("a fetch that began before the ask must not clear it, got %+v", got)
		}
	})
}

func sameRepoStatus(a, b corev1alpha1.SandboxRepoStatus) bool {
	sameTime := func(x, y *metav1.Time) bool {
		if x == nil || y == nil {
			return x == nil && y == nil
		}
		return x.Equal(y)
	}
	return a.Key == b.Key && a.Asked.Equal(&b.Asked) && sameTime(a.Fetched, b.Fetched) &&
		sameTime(a.Attempted, b.Attempted) && a.Error == b.Error
}

func showRepoStatus(s corev1alpha1.SandboxRepoStatus) string {
	show := func(t *metav1.Time) string {
		if t == nil {
			return "-"
		}
		return t.UTC().Format(time.RFC3339)
	}
	return s.Key + " asked=" + s.Asked.UTC().Format(time.RFC3339) +
		" fetched=" + show(s.Fetched) + " attempted=" + show(s.Attempted) + " error=" + s.Error
}

// TestAsksReachThePod pins the copy: the Orchestrator marks the ask on the CR,
// and the cache agent reads demand off pods alone (ADR-0051), so the operator
// carries every `jr2.dev/asked-` annotation across — and nothing else. An ask
// already on the pod costs no write, because the CR is PATCHed on every lease
// renewal and a PATCH per renewal would wake every cache agent on the node.
func TestAsksReachThePod(t *testing.T) {
	scheme := newScheme(t)
	sandbox := askedSandbox(askAfter.UTC().Format(time.RFC3339))
	sandbox.Annotations[keepaliveAnnotation] = askLater.UTC().Format(time.RFC3339)
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Name: sandbox.Name, Namespace: nsDefault,
		Annotations: map[string]string{"kubectl.kubernetes.io/default-container": "harness"},
	}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(sandbox, pod).Build()
	r := &SandboxReconciler{Client: c, Scheme: scheme}

	if err := r.reconcileAsks(context.Background(), sandbox, pod); err != nil {
		t.Fatalf("reconcile asks: %v", err)
	}
	live := &corev1.Pod{}
	get := func() {
		t.Helper()
		if err := c.Get(context.Background(), client.ObjectKeyFromObject(pod), live); err != nil {
			t.Fatalf("get pod: %v", err)
		}
	}
	get()
	if got := live.Annotations[corev1alpha1.AskedAnnotation(askKey)]; got != askAfter.UTC().Format(time.RFC3339) {
		t.Fatalf("the ask should reach the pod verbatim, got %q", got)
	}
	if _, ok := live.Annotations[keepaliveAnnotation]; ok {
		t.Fatalf("only the ask is copied; the lease stays on the CR, got %+v", live.Annotations)
	}
	if live.Annotations["kubectl.kubernetes.io/default-container"] == "" {
		t.Fatalf("the pod's own annotations must survive the copy, got %+v", live.Annotations)
	}

	settled := live.ResourceVersion
	if err := r.reconcileAsks(context.Background(), sandbox, live.DeepCopy()); err != nil {
		t.Fatalf("reconcile asks again: %v", err)
	}
	get()
	if live.ResourceVersion != settled {
		t.Fatalf("an unchanged ask must cost no write, resourceVersion moved %s -> %s", settled, live.ResourceVersion)
	}

	sandbox.Annotations[corev1alpha1.AskedAnnotation(askKey)] = askLater.UTC().Format(time.RFC3339)
	if err := r.reconcileAsks(context.Background(), sandbox, live.DeepCopy()); err != nil {
		t.Fatalf("reconcile a newer ask: %v", err)
	}
	get()
	if got := live.Annotations[corev1alpha1.AskedAnnotation(askKey)]; got != askLater.UTC().Format(time.RFC3339) {
		t.Fatalf("a newer ask should replace the older one, got %q", got)
	}
}
