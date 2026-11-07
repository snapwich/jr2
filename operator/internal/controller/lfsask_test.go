/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package controller

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

const lfsOID = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393"

// lfsAskValue is a `jr2.dev/lfs-<key>` value with one object, asked at `at`.
func lfsAskValue(t *testing.T, at string) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{"at": at, "base": "main", "objects": []string{lfsOID + " 3"}})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestLFSAsksReachThePod pins the LFS copy (ADR-0053): the cache agent reads
// the LFS ask off the pod, so the operator copies every `jr2.dev/lfs-`
// annotation across in the same patch as the asked- ones. An unchanged value
// costs no write.
func TestLFSAsksReachThePod(t *testing.T) {
	scheme := newScheme(t)
	first := lfsAskValue(t, "2026-11-07T12:00:00.100Z")
	sandbox := askedSandbox(askAfter.UTC().Format(time.RFC3339))
	sandbox.Annotations[corev1alpha1.LFSAnnotation(askKey)] = first
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Name: sandbox.Name, Namespace: nsDefault,
		Annotations: map[string]string{"kubectl.kubernetes.io/default-container": "harness"},
	}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(sandbox, pod).Build()
	r := &SandboxReconciler{Client: c, Scheme: scheme}

	live := &corev1.Pod{}
	get := func() {
		t.Helper()
		if err := c.Get(context.Background(), client.ObjectKeyFromObject(pod), live); err != nil {
			t.Fatalf("get pod: %v", err)
		}
	}

	if err := r.reconcileAsks(context.Background(), sandbox, pod); err != nil {
		t.Fatalf("reconcile asks: %v", err)
	}
	get()
	if got := live.Annotations[corev1alpha1.LFSAnnotation(askKey)]; got != first {
		t.Fatalf("the LFS ask should reach the pod verbatim, got %q", got)
	}
	if got := live.Annotations[corev1alpha1.AskedAnnotation(askKey)]; got != askAfter.UTC().Format(time.RFC3339) {
		t.Fatalf("the fetch ask should reach the pod in the same patch, got %q", got)
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
		t.Fatalf("an unchanged LFS ask must cost no write, resourceVersion moved %s -> %s", settled, live.ResourceVersion)
	}

	second := lfsAskValue(t, "2026-11-07T12:00:00.200Z")
	sandbox.Annotations[corev1alpha1.LFSAnnotation(askKey)] = second
	if err := r.reconcileAsks(context.Background(), sandbox, live.DeepCopy()); err != nil {
		t.Fatalf("reconcile a newer LFS ask: %v", err)
	}
	get()
	if got := live.Annotations[corev1alpha1.LFSAnnotation(askKey)]; got != second {
		t.Fatalf("a newer LFS ask should replace the older one, got %q", got)
	}
	if got := live.Annotations[corev1alpha1.AskedAnnotation(askKey)]; got != askAfter.UTC().Format(time.RFC3339) {
		t.Fatalf("the fetch ask must stay, got %q", got)
	}
}

// TestRepoStatusesLFS pins the `lfs` field of the per-key entry (ADR-0053).
// `asked` is the Sandbox's own `at`; `answered` and `error` come from the item
// for this Sandbox's Pod in its node's entry, and `error` only when the answer
// is at or after the ask.
func TestRepoStatusesLFS(t *testing.T) {
	const at = "2026-11-07T12:00:00.500Z"
	synced := func(items ...corev1alpha1.RepoLFSAnswer) corev1alpha1.RepoNodeStatus {
		return corev1alpha1.RepoNodeStatus{
			Node: askNode, Present: true, Synced: true, Attempted: corev1alpha1.RepoAttemptFetch,
			LastAttempt: &askAfter, LastFetched: &askAfter, LFS: items,
		}
	}
	cases := []struct {
		name  string
		lfs   string // the annotation value; "" = none
		repos map[string]*corev1alpha1.Repo
		want  *corev1alpha1.SandboxLFSStatus
	}{
		{name: "no LFS ask", repos: askRepo(synced()), want: nil},
		{name: "a garbage LFS ask is absent", lfs: "{", repos: askRepo(synced()), want: nil},
		{name: "no Repo", lfs: lfsAskValue(t, at), repos: nil, want: &corev1alpha1.SandboxLFSStatus{Asked: at}},
		{name: "no node entry", lfs: lfsAskValue(t, at), repos: askRepo(), want: &corev1alpha1.SandboxLFSStatus{Asked: at}},
		{name: "no item", lfs: lfsAskValue(t, at), repos: askRepo(synced()), want: &corev1alpha1.SandboxLFSStatus{Asked: at}},
		{
			name: "an item for another pod",
			lfs:  lfsAskValue(t, at),
			repos: askRepo(synced(corev1alpha1.RepoLFSAnswer{
				Pod: "other", Asked: "2026-11-07T12:00:01.000Z", Error: "not found",
			})),
			want: &corev1alpha1.SandboxLFSStatus{Asked: at},
		},
		{
			name: "an older answer carries no error",
			lfs:  lfsAskValue(t, at),
			repos: askRepo(synced(corev1alpha1.RepoLFSAnswer{
				Pod: "sb", Asked: "2026-11-07T12:00:00.499Z", Error: "object not found",
			})),
			want: &corev1alpha1.SandboxLFSStatus{Asked: at, Answered: "2026-11-07T12:00:00.499Z"},
		},
		{
			name:  "an answer at the ask",
			lfs:   lfsAskValue(t, at),
			repos: askRepo(synced(corev1alpha1.RepoLFSAnswer{Pod: "sb", Asked: at, Attempted: &askLater})),
			want:  &corev1alpha1.SandboxLFSStatus{Asked: at, Answered: at},
		},
		{
			name: "an answer at the same instant in another form",
			lfs:  lfsAskValue(t, at),
			repos: askRepo(synced(corev1alpha1.RepoLFSAnswer{
				Pod: "sb", Asked: "2026-11-07T13:00:00.5+01:00", Error: "object not found",
			})),
			want: &corev1alpha1.SandboxLFSStatus{Asked: at, Answered: "2026-11-07T13:00:00.5+01:00", Error: "object not found"},
		},
		{
			name: "an answer after the ask, with an error",
			lfs:  lfsAskValue(t, at),
			repos: askRepo(synced(
				corev1alpha1.RepoLFSAnswer{Pod: "other", Asked: at},
				corev1alpha1.RepoLFSAnswer{Pod: "sb", Asked: "2026-11-07T12:00:02Z", Error: "batch response: 404"},
			)),
			want: &corev1alpha1.SandboxLFSStatus{Asked: at, Answered: "2026-11-07T12:00:02Z", Error: "batch response: 404"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sandbox := askedSandbox("")
			if tc.lfs != "" {
				sandbox.Annotations = map[string]string{corev1alpha1.LFSAnnotation(askKey): tc.lfs}
			}
			got := repoStatuses(context.Background(), sandbox, askNode, tc.repos)
			if len(got) != 1 {
				t.Fatalf("want one entry, got %d", len(got))
			}
			if !lfsEqual(got[0].LFS, tc.want) {
				t.Fatalf("lfs: got %+v, want %+v", got[0].LFS, tc.want)
			}
		})
	}

	// The fetch half of the entry does not change with an LFS ask.
	sandbox := askedSandbox(askAfter.UTC().Format(time.RFC3339))
	sandbox.Annotations[corev1alpha1.LFSAnnotation(askKey)] = lfsAskValue(t, at)
	got := repoStatuses(context.Background(), sandbox, askNode, askRepo(synced()))
	if !got[0].Asked.Equal(&askAfter) || got[0].Fetched == nil || got[0].Error != "" {
		t.Fatalf("the fetch half should be as before, got %s", showRepoStatus(got[0]))
	}
}

func lfsEqual(a, b *corev1alpha1.SandboxLFSStatus) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
