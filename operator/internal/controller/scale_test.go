/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package controller

import (
	"context"
	"slices"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/util/workqueue"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

// TestRepoEventsWakeOnlyChangedNodes pins ADR-0001's rule for the Repo watch:
// a status write wakes the Sandboxes naming the Repo whose status.node it
// changed (an entry added, removed or changed), plus any not yet placed; a
// spec change, a create and a delete wake every Sandbox naming it; a write
// that changes no entry wakes nobody.
func TestRepoEventsWakeOnlyChangedNodes(t *testing.T) {
	const (
		ns  = "jr2-acme"
		key = "app-0a1b2c3d"
	)
	app := corev1alpha1.SandboxRepo{Key: key, URL: "https://github.com/acme/app.git"}
	docs := corev1alpha1.SandboxRepo{Key: "docs-4e5f6a7b", URL: "https://github.com/acme/docs.git"}
	sandbox := func(name, node string, repos ...corev1alpha1.SandboxRepo) *corev1alpha1.Sandbox {
		return &corev1alpha1.Sandbox{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
			Spec:       corev1alpha1.SandboxSpec{Image: testHarnessImage, Repos: repos},
			Status:     corev1alpha1.SandboxStatus{Node: node},
		}
	}
	scheme := newScheme(t)
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		sandbox("on-a", "node-a", app),
		sandbox("on-b", "node-b", app),
		sandbox("on-c", "node-c", docs, app),
		sandbox("unplaced", "", app),
		sandbox("other-key-on-a", "node-a", docs),
	).Build()
	r := &SandboxReconciler{Client: c, Scheme: scheme}

	fetched := metav1.Now()
	entry := func(node string, synced bool) corev1alpha1.RepoNodeStatus {
		return corev1alpha1.RepoNodeStatus{
			Node: node, Present: true, Synced: synced,
			Attempted: corev1alpha1.RepoAttemptFetch, LastFetched: &fetched,
		}
	}
	repo := func(generation int64, nodes ...corev1alpha1.RepoNodeStatus) *corev1alpha1.Repo {
		return &corev1alpha1.Repo{
			ObjectMeta: metav1.ObjectMeta{Name: key, Namespace: ns, Generation: generation},
			Status:     corev1alpha1.RepoStatus{Nodes: nodes},
		}
	}
	base := repo(1, entry("node-a", true), entry("node-b", true))

	woken := func(fire func(q workqueue.TypedRateLimitingInterface[reconcile.Request])) []string {
		q := workqueue.NewTypedRateLimitingQueue(workqueue.DefaultTypedControllerRateLimiter[reconcile.Request]())
		defer q.ShutDown()
		fire(q)
		var names []string
		for q.Len() > 0 {
			req, _ := q.Get()
			names = append(names, req.Name)
			q.Done(req)
		}
		slices.Sort(names)
		return names
	}
	update := func(old, updated *corev1alpha1.Repo) []string {
		return woken(func(q workqueue.TypedRateLimitingInterface[reconcile.Request]) {
			r.repoEvents().Update(context.Background(), event.UpdateEvent{ObjectOld: old, ObjectNew: updated}, q)
		})
	}
	all := []string{"on-a", "on-b", "on-c", "unplaced"}

	cases := []struct {
		name    string
		updated *corev1alpha1.Repo
		want    []string
	}{
		{"a changed entry wakes its node and the unplaced", repo(1, entry("node-a", false), entry("node-b", true)), []string{"on-a", "unplaced"}},
		{"an added entry wakes its node and the unplaced", repo(1, entry("node-a", true), entry("node-b", true), entry("node-c", true)), []string{"on-c", "unplaced"}},
		{"a removed entry wakes its node and the unplaced", repo(1, entry("node-a", true)), []string{"on-b", "unplaced"}},
		{"reordered entries wake nobody", repo(1, entry("node-b", true), entry("node-a", true)), nil},
		{"a write that changes no entry wakes nobody", func() *corev1alpha1.Repo {
			r := base.DeepCopy()
			r.Status.Conditions = []metav1.Condition{{Type: conditionSynced, Status: metav1.ConditionTrue, Reason: "Synced"}}
			return r
		}(), nil},
		{"a spec change wakes every Sandbox naming the Repo", repo(2, entry("node-a", true), entry("node-b", true)), all},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := update(base, tc.updated); !slices.Equal(got, tc.want) {
				t.Fatalf("woke %v, want %v", got, tc.want)
			}
		})
	}

	t.Run("a create wakes every Sandbox naming the Repo", func(t *testing.T) {
		got := woken(func(q workqueue.TypedRateLimitingInterface[reconcile.Request]) {
			r.repoEvents().Create(context.Background(), event.CreateEvent{Object: base}, q)
		})
		if !slices.Equal(got, all) {
			t.Fatalf("woke %v, want %v", got, all)
		}
	})
	t.Run("a delete wakes every Sandbox naming the Repo", func(t *testing.T) {
		got := woken(func(q workqueue.TypedRateLimitingInterface[reconcile.Request]) {
			r.repoEvents().Delete(context.Background(), event.DeleteEvent{Object: base}, q)
		})
		if !slices.Equal(got, all) {
			t.Fatalf("woke %v, want %v", got, all)
		}
	})
}

// TestCacheOptionsSeeWhatTheOperatorCreates pins that the label-scoped cache
// (ADR-0001) still holds every Pod and Service the operator creates: an object
// the selector missed would be invisible to its own Sandbox's reconcile.
func TestCacheOptionsSeeWhatTheOperatorCreates(t *testing.T) {
	var pods, services labels.Selector
	for obj, by := range CacheOptions().ByObject {
		switch obj.(type) {
		case *corev1.Pod:
			pods = by.Label
		case *corev1.Service:
			services = by.Label
		default:
			t.Fatalf("want Pods and Services scoped and nothing else, got %T", obj)
		}
	}
	if pods == nil || services == nil {
		t.Fatal("want both Pods and Services scoped")
	}

	sandbox := &corev1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sb", Namespace: "jr2-acme"},
		Spec:       corev1alpha1.SandboxSpec{Image: testHarnessImage},
	}
	pod := (&SandboxReconciler{}).buildPod(sandbox, nil)
	if !pods.Matches(labels.Set(pod.Labels)) {
		t.Fatalf("the Pod the operator builds is outside its cache: %v", pod.Labels)
	}
	if !services.Matches(labels.Set(sandboxLabels(sandbox))) {
		t.Fatalf("the Service the operator builds is outside its cache: %v", sandboxLabels(sandbox))
	}
	if pods.Matches(labels.Set{"app": "someone-else"}) {
		t.Fatal("the cache admits a Pod the operator did not create")
	}
}
