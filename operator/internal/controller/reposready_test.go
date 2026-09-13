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

package controller

import (
	"context"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

// TestReposReadiness pins ADR-0051's Ready gate over the Repo caches, branch by
// branch: a Sandbox is Ready only once every Repo it names is present on its
// node and fetched since the Sandbox was created; a cold node that cannot
// clone fails the provision pointedly; a warm cache whose refresh failed is
// Ready but stale (freshness degrades, absence does not). Every branch is a
// pure function of the Sandbox, its node, and the Repo resources.
func TestReposReadiness(t *testing.T) {
	const (
		key  = "app-0a1b2c3d"
		url  = "https://github.com/acme/app.git"
		node = "node-a"
	)
	created := metav1.NewTime(time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC))
	before := metav1.NewTime(created.Add(-time.Minute))
	sameSecond := created
	after := metav1.NewTime(created.Add(time.Minute))
	later := metav1.NewTime(created.Add(2 * time.Minute))

	sandbox := &corev1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sb", Namespace: "j2-acme", CreationTimestamp: created},
		Spec:       corev1alpha1.SandboxSpec{Repos: []corev1alpha1.SandboxRepo{{Key: key, URL: url}}},
	}
	repoWith := func(entries ...corev1alpha1.RepoNodeStatus) map[string]*corev1alpha1.Repo {
		return map[string]*corev1alpha1.Repo{key: {Status: corev1alpha1.RepoStatus{Nodes: entries}}}
	}

	cases := []struct {
		name     string
		repos    map[string]*corev1alpha1.Repo
		ready    bool
		reason   string
		message  string
		fresh    metav1.ConditionStatus // "" = no ReposFresh condition
		freshMsg string
	}{
		{
			name:    "no Repo resource holds Ready with RepoMissing",
			repos:   map[string]*corev1alpha1.Repo{},
			reason:  "RepoMissing",
			message: `Repo "app-0a1b2c3d" (https://github.com/acme/app.git) does not exist in namespace j2-acme`,
		},
		{
			name:    "no entry for the node is pending — the agent has not cloned yet",
			repos:   repoWith(corev1alpha1.RepoNodeStatus{Node: "node-b", Present: true, Synced: true, LastFetched: &after}),
			reason:  "RepoPending",
			message: `Repo "app-0a1b2c3d" is not on node node-a yet`,
		},
		{
			name:    "not present with no failed attempt since creation is pending",
			repos:   repoWith(corev1alpha1.RepoNodeStatus{Node: node, Present: false, Synced: false, LastError: "old", LastAttempt: &before}),
			reason:  "RepoPending",
			message: `Repo "app-0a1b2c3d" is not on node node-a yet`,
		},
		{
			name:    "not present after a failed attempt since creation fails the provision with git's words",
			repos:   repoWith(corev1alpha1.RepoNodeStatus{Node: node, Present: false, Synced: false, LastError: "fatal: repository not found", LastAttempt: &after}),
			reason:  "RepoCloneFailed",
			message: `Repo "app-0a1b2c3d" could not be cloned onto node node-a: fatal: repository not found`,
		},
		{
			name:  "present and fetched since creation is Ready and fresh",
			repos: repoWith(corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: &after, LastFetched: &after}),
			ready: true,
			fresh: metav1.ConditionTrue,
		},
		{
			name:  "fetched in the same second as creation counts as since creation",
			repos: repoWith(corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: &sameSecond, LastFetched: &sameSecond}),
			ready: true,
			fresh: metav1.ConditionTrue,
		},
		{
			name:     "present but the refresh since creation failed is Ready and stale",
			repos:    repoWith(corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: false, LastError: "fatal: unable to access: timed out", LastAttempt: &after, LastFetched: &before}),
			ready:    true,
			fresh:    metav1.ConditionFalse,
			freshMsg: `Repo "app-0a1b2c3d" on node node-a is stale: fatal: unable to access: timed out`,
		},
		{
			name:  "a refresh that fails after a fetch since creation does not degrade — the attach already had its fetch",
			repos: repoWith(corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: false, LastError: "timed out", LastAttempt: &later, LastFetched: &after}),
			ready: true,
			fresh: metav1.ConditionTrue,
		},
		{
			name:    "present with no attempt since creation is pending — the on-demand fetch has not run",
			repos:   repoWith(corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: &before, LastFetched: &before}),
			reason:  "RepoPending",
			message: `fetching Repo "app-0a1b2c3d" on node node-a`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ready, reason, message, fresh := reposReadiness(sandbox, node, tc.repos)
			if ready != tc.ready {
				t.Fatalf("ready: want %v, got %v (%s: %s)", tc.ready, ready, reason, message)
			}
			if reason != tc.reason || message != tc.message {
				t.Fatalf("want %q %q, got %q %q", tc.reason, tc.message, reason, message)
			}
			switch {
			case tc.fresh == "" && fresh != nil:
				t.Fatalf("no ReposFresh expected before Ready, got %+v", fresh)
			case tc.fresh != "" && fresh == nil:
				t.Fatalf("want ReposFresh=%s once Ready, got none", tc.fresh)
			case tc.fresh != "":
				if fresh.Type != conditionReposFresh || fresh.Status != tc.fresh {
					t.Fatalf("want ReposFresh=%s, got %+v", tc.fresh, fresh)
				}
				if tc.fresh == metav1.ConditionFalse && (fresh.Reason != "FetchFailed" || fresh.Message != tc.freshMsg) {
					t.Fatalf("stale should carry FetchFailed and git's words, got %+v", fresh)
				}
				if tc.fresh == metav1.ConditionTrue && fresh.Reason != "Fetched" {
					t.Fatalf("fresh should carry reason Fetched, got %+v", fresh)
				}
			}
		})
	}

	t.Run("the first Repo that is not ready wins, in declaration order", func(t *testing.T) {
		two := sandbox.DeepCopy()
		two.Spec.Repos = append(two.Spec.Repos, corev1alpha1.SandboxRepo{Key: "docs-4e5f6a7b", URL: "https://github.com/acme/docs.git"})
		repos := repoWith(corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastFetched: &after})
		ready, reason, message, _ := reposReadiness(two, node, repos)
		if ready || reason != "RepoMissing" || !strings.Contains(message, `"docs-4e5f6a7b"`) {
			t.Fatalf("the second Repo, missing, should hold Ready, got %v %q %q", ready, reason, message)
		}
	})

	t.Run("two stale caches are both named", func(t *testing.T) {
		two := sandbox.DeepCopy()
		two.Spec.Repos = append(two.Spec.Repos, corev1alpha1.SandboxRepo{Key: "docs-4e5f6a7b", URL: "https://github.com/acme/docs.git"})
		stale := corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: false, LastError: "timed out", LastAttempt: &after, LastFetched: &before}
		repos := map[string]*corev1alpha1.Repo{
			key:             {Status: corev1alpha1.RepoStatus{Nodes: []corev1alpha1.RepoNodeStatus{stale}}},
			"docs-4e5f6a7b": {Status: corev1alpha1.RepoStatus{Nodes: []corev1alpha1.RepoNodeStatus{stale}}},
		}
		ready, _, _, fresh := reposReadiness(two, node, repos)
		if !ready || fresh == nil || fresh.Status != metav1.ConditionFalse {
			t.Fatalf("stale caches are still Ready, got %v %+v", ready, fresh)
		}
		if !strings.Contains(fresh.Message, `"app-0a1b2c3d"`) || !strings.Contains(fresh.Message, `"docs-4e5f6a7b"`) {
			t.Fatalf("both stale Repos should be named, got %q", fresh.Message)
		}
	})

	t.Run("a Sandbox naming no Repo is Ready with nothing to be fresh", func(t *testing.T) {
		none := sandbox.DeepCopy()
		none.Spec.Repos = nil
		ready, reason, _, fresh := reposReadiness(none, node, nil)
		if !ready || reason != "" || fresh != nil {
			t.Fatalf("no Repo means nothing holds Ready and no ReposFresh, got %v %q %+v", ready, reason, fresh)
		}
	})
}

// TestSandboxesNamingRepo pins how a Repo change reaches the Sandboxes waiting
// on it: the watch maps a Repo to every Sandbox in ITS namespace whose spec
// names the Repo's key, and to nothing else — not a Sandbox naming another key,
// not one in another namespace with the same key.
func TestSandboxesNamingRepo(t *testing.T) {
	scheme := newScheme(t)
	names := func(spec ...corev1alpha1.SandboxRepo) corev1alpha1.SandboxSpec {
		return corev1alpha1.SandboxSpec{Image: testHarnessImage, Repos: spec}
	}
	app := corev1alpha1.SandboxRepo{Key: "app-0a1b2c3d", URL: "https://github.com/acme/app.git"}
	docs := corev1alpha1.SandboxRepo{Key: "docs-4e5f6a7b", URL: "https://github.com/acme/docs.git"}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(
		&corev1alpha1.Sandbox{ObjectMeta: metav1.ObjectMeta{Name: "waits", Namespace: "j2-acme"}, Spec: names(docs, app)},
		&corev1alpha1.Sandbox{ObjectMeta: metav1.ObjectMeta{Name: "other-key", Namespace: "j2-acme"}, Spec: names(docs)},
		&corev1alpha1.Sandbox{ObjectMeta: metav1.ObjectMeta{Name: "other-ns", Namespace: "j2-beta"}, Spec: names(app)},
		&corev1alpha1.Sandbox{ObjectMeta: metav1.ObjectMeta{Name: "no-repos", Namespace: "j2-acme"}, Spec: names()},
	).Build()
	r := &SandboxReconciler{Client: c, Scheme: scheme}

	repo := &corev1alpha1.Repo{ObjectMeta: metav1.ObjectMeta{Name: "app-0a1b2c3d", Namespace: "j2-acme"}}
	requests := r.sandboxesNamingRepo(context.Background(), repo)
	if len(requests) != 1 || requests[0].Name != "waits" || requests[0].Namespace != "j2-acme" {
		t.Fatalf("want exactly the Sandbox naming the key in the Repo's namespace, got %+v", requests)
	}
}
