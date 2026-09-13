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

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

var _ = Describe("Repo Controller", func() {
	Context("When reconciling a Repo", func() {
		const (
			resourceName      = "app-0a1b2c3d"
			resourceNamespace = "default"
		)

		ctx := context.Background()
		key := types.NamespacedName{Name: resourceName, Namespace: resourceNamespace}
		reconciler := &RepoReconciler{}

		BeforeEach(func() {
			reconciler.Client = k8sClient
			reconciler.Scheme = k8sClient.Scheme()
			Expect(k8sClient.Create(ctx, &corev1alpha1.Repo{
				ObjectMeta: metav1.ObjectMeta{Name: resourceName, Namespace: resourceNamespace},
				Spec:       corev1alpha1.RepoSpec{URL: "https://github.com/acme/app.git"},
			})).To(Succeed())
		})

		AfterEach(func() {
			repo := &corev1alpha1.Repo{}
			if err := k8sClient.Get(ctx, key, repo); err == nil {
				Expect(k8sClient.Delete(ctx, repo)).To(Succeed())
			} else {
				Expect(errors.IsNotFound(err)).To(BeTrue())
			}
		})

		synced := func() *metav1.Condition {
			repo := &corev1alpha1.Repo{}
			Expect(k8sClient.Get(ctx, key, repo)).To(Succeed())
			return meta.FindStatusCondition(repo.Status.Conditions, conditionSynced)
		}
		report := func(nodes ...corev1alpha1.RepoNodeStatus) {
			repo := &corev1alpha1.Repo{}
			Expect(k8sClient.Get(ctx, key, repo)).To(Succeed())
			repo.Status.Nodes = nodes
			Expect(k8sClient.Status().Update(ctx, repo)).To(Succeed())
		}

		It("folds the per-node reports into one Synced condition", func() {
			// ADR-0051: each node's cache agent writes its own entry; the operator
			// derives the one answer `j2 status` and `kubectl get repos` read. It
			// never touches the node entries themselves.
			By("reporting Unknown while no node has reported")
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			cond := synced()
			Expect(cond).NotTo(BeNil())
			Expect(cond.Status).To(Equal(metav1.ConditionUnknown))
			Expect(cond.Reason).To(Equal("NoNode"))

			By("reporting False with the failing node's own error when any node is not synced")
			now := metav1.Now()
			report(
				corev1alpha1.RepoNodeStatus{Node: "node-a", Present: true, Synced: true, LastAttempt: &now, LastFetched: &now},
				corev1alpha1.RepoNodeStatus{Node: "node-b", Present: false, Synced: false, LastAttempt: &now, LastError: "fatal: repository not found"},
			)
			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			cond = synced()
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal("SyncFailed"))
			Expect(cond.Message).To(Equal("node node-b: fatal: repository not found"))

			By("reporting True once every reporting node is synced, and leaving the node entries as written")
			report(
				corev1alpha1.RepoNodeStatus{Node: "node-a", Present: true, Synced: true, LastAttempt: &now, LastFetched: &now},
				corev1alpha1.RepoNodeStatus{Node: "node-b", Present: false, Synced: true, LastAttempt: &now},
			)
			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			cond = synced()
			Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			Expect(cond.Reason).To(Equal("Synced"))
			repo := &corev1alpha1.Repo{}
			Expect(k8sClient.Get(ctx, key, repo)).To(Succeed())
			Expect(repo.Status.Nodes).To(HaveLen(2))
			Expect(repo.Status.Nodes[1].Node).To(Equal("node-b"))
			Expect(repo.Status.Nodes[1].Present).To(BeFalse())

			By("writing nothing when the condition already says so")
			before := repo.ResourceVersion
			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, repo)).To(Succeed())
			Expect(repo.ResourceVersion).To(Equal(before))
		})

		It("ignores a Repo that no longer exists", func() {
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: "gone", Namespace: resourceNamespace}})
			Expect(err).NotTo(HaveOccurred())
		})
	})
})
