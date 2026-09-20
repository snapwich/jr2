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
	"fmt"

	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

// report replaces this node's entry in the Repo's status.nodes — and only
// that entry (ADR-0051). Other nodes' entries and the Synced condition belong
// to their own writers. The list is a map keyed by node in the schema but an
// array on the wire, so the write is read-replace-patch under an optimistic
// lock, retried on conflict; a Repo that vanished in the meantime has nothing
// to report on.
func (a *Agent) report(ctx context.Context, repo *corev1alpha1.Repo, entry corev1alpha1.RepoNodeStatus) error {
	entry.Node = a.Node
	key := client.ObjectKeyFromObject(repo)
	err := retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		var current corev1alpha1.Repo
		if err := a.Get(ctx, key, &current); err != nil {
			return client.IgnoreNotFound(err)
		}
		base := current.DeepCopy()
		replaced := false
		for i := range current.Status.Nodes {
			if current.Status.Nodes[i].Node == a.Node {
				current.Status.Nodes[i] = entry
				replaced = true
			}
		}
		if !replaced {
			current.Status.Nodes = append(current.Status.Nodes, entry)
		}
		return a.Status().Patch(ctx, &current, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{}))
	})
	if err != nil {
		return fmt.Errorf("report node %s on Repo %s: %w", a.Node, repo.Name, err)
	}
	return nil
}

// own is this node's entry in the Repo's status, or nil before the first
// report.
func (a *Agent) own(repo *corev1alpha1.Repo) *corev1alpha1.RepoNodeStatus {
	for i := range repo.Status.Nodes {
		if repo.Status.Nodes[i].Node == a.Node {
			return &repo.Status.Nodes[i]
		}
	}
	return nil
}
