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
	"fmt"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

// conditionSynced is the Repo's one aggregate condition: what every node's
// cache agent reports, folded into one answer for `jr2 status` and
// `kubectl get repos`.
const conditionSynced = "Synced"

// RepoReconciler folds a Repo's per-node status into its Synced condition
// (ADR-0051). It clones nothing: the cache agent on each node is the one
// writer of that node's entry, and this reconciler only reads the entries. It
// is also the reason a Repo change re-evaluates the Sandboxes naming it — the
// Sandbox controller watches Repos.
type RepoReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.jr2.dev,resources=repos,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=core.jr2.dev,resources=repos/status,verbs=get;update;patch

// Reconcile derives status.conditions[Synced] from status.nodes: Unknown while
// no node has reported, False with the first failing node's error when any is
// not synced, True when every reporting node is. The write is a merge patch
// under an optimistic lock, retried on conflict, so it never clobbers a node
// entry an agent patched in the meantime. Nothing requeues: the next change to
// the resource is the next reason to look.
func (r *RepoReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
	err := retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		var repo corev1alpha1.Repo
		if err := r.Get(ctx, req.NamespacedName, &repo); err != nil {
			return client.IgnoreNotFound(err)
		}
		want := syncedCondition(&repo)
		if have := meta.FindStatusCondition(repo.Status.Conditions, conditionSynced); have != nil &&
			have.Status == want.Status && have.Reason == want.Reason && have.Message == want.Message &&
			have.ObservedGeneration == want.ObservedGeneration {
			return nil
		}
		base := repo.DeepCopy()
		meta.SetStatusCondition(&repo.Status.Conditions, want)
		return r.Status().Patch(ctx, &repo, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{}))
	})
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("aggregate synced: %w", err)
	}
	log.V(1).Info("reconciled")
	return ctrl.Result{}, nil
}

// syncedCondition is the pure fold of status.nodes into Synced.
func syncedCondition(repo *corev1alpha1.Repo) metav1.Condition {
	cond := metav1.Condition{
		Type:               conditionSynced,
		ObservedGeneration: repo.Generation,
		Status:             metav1.ConditionUnknown,
		Reason:             "NoNode",
		Message:            "no node has reported on this Repo yet",
	}
	if len(repo.Status.Nodes) == 0 {
		return cond
	}
	for _, n := range repo.Status.Nodes {
		if !n.Synced {
			cond.Status = metav1.ConditionFalse
			cond.Reason = "SyncFailed"
			cond.Message = fmt.Sprintf("node %s: %s", n.Node, n.LastError)
			return cond
		}
	}
	cond.Status = metav1.ConditionTrue
	cond.Reason = "Synced"
	cond.Message = fmt.Sprintf("every reporting node is synced (%d)", len(repo.Status.Nodes))
	return cond
}

// SetupWithManager sets up the controller with the Manager.
func (r *RepoReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.Repo{}).
		Named("repo").
		Complete(r)
}
