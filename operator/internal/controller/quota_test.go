/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package controller

import (
	"context"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/rand"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

var _ = Describe("Sandbox under a ResourceQuota", func() {
	// The cluster owner's spend ceiling (ADR-0064): jr2 neither writes a quota
	// nor replaces one. A refused create is the same wait as an Unschedulable
	// Pod — published on the Sandbox in the API server's words, and retried.
	ctx := context.Background()

	It("publishes the refusal as Scheduled=False/QuotaExceeded and creates the Pod once the quota allows", func() {
		// Its own namespace: the quota would refuse every other spec's Pod too.
		ns := "quota-" + rand.String(6)
		Expect(k8sClient.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})).To(Succeed())

		// No quota controller runs in envtest; the admission plugin reads the
		// quota's status, so the test states it as the controller would.
		quota := &corev1.ResourceQuota{
			ObjectMeta: metav1.ObjectMeta{Name: "ceiling", Namespace: ns},
			Spec:       corev1.ResourceQuotaSpec{Hard: corev1.ResourceList{corev1.ResourcePods: resource.MustParse("0")}},
		}
		Expect(k8sClient.Create(ctx, quota)).To(Succeed())
		quota.Status = corev1.ResourceQuotaStatus{
			Hard: corev1.ResourceList{corev1.ResourcePods: resource.MustParse("0")},
			Used: corev1.ResourceList{corev1.ResourcePods: resource.MustParse("0")},
		}
		Expect(k8sClient.Status().Update(ctx, quota)).To(Succeed())

		key := types.NamespacedName{Name: "refused", Namespace: ns}
		Expect(k8sClient.Create(ctx, &corev1alpha1.Sandbox{
			ObjectMeta: metav1.ObjectMeta{Name: key.Name, Namespace: ns},
			Spec:       corev1alpha1.SandboxSpec{Image: "ghcr.io/example/harness:latest", Port: 8080},
		})).To(Succeed())

		reconciler := &SandboxReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		var res reconcile.Result
		Eventually(func(g Gomega) {
			var err error
			res, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			g.Expect(err).NotTo(HaveOccurred(), "a quota refusal is a wait, not a reconcile error")
			sandbox := &corev1alpha1.Sandbox{}
			g.Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			g.Expect(meta.FindStatusCondition(sandbox.Status.Conditions, conditionScheduled)).NotTo(BeNil())
		}).Should(Succeed())

		Expect(errors.IsNotFound(k8sClient.Get(ctx, key, &corev1.Pod{}))).To(BeTrue(), "the quota refused it")
		Expect(res.RequeueAfter).To(BeNumerically(">", 0), "the create is retried")
		Expect(res.RequeueAfter).To(BeNumerically("<=", quotaRetryMax))

		sandbox := &corev1alpha1.Sandbox{}
		Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
		Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxPending))
		Expect(sandbox.Status.PodUID).To(BeEmpty(), "no Pod was ever created, so none is lost")
		scheduled := meta.FindStatusCondition(sandbox.Status.Conditions, conditionScheduled)
		Expect(scheduled.Status).To(Equal(metav1.ConditionFalse))
		Expect(scheduled.Reason).To(Equal("QuotaExceeded"))
		Expect(scheduled.Message).To(ContainSubstring("exceeded quota: ceiling"), "the API server's own words")
		ready := meta.FindStatusCondition(sandbox.Status.Conditions, conditionReady)
		Expect(ready.Status).To(Equal(metav1.ConditionFalse))
		Expect(ready.Reason).To(Equal("QuotaExceeded"))

		By("creating the Pod on a retry once the quota has room")
		Expect(k8sClient.Delete(ctx, quota)).To(Succeed())
		Eventually(func(g Gomega) {
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(k8sClient.Get(ctx, key, &corev1.Pod{})).To(Succeed())
		}, 10*time.Second).Should(Succeed())

		pod := &corev1.Pod{}
		Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
		Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
		Expect(sandbox.Status.PodUID).To(Equal(pod.UID))
		Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxPending))
		scheduled = meta.FindStatusCondition(sandbox.Status.Conditions, conditionScheduled)
		Expect(scheduled.Reason).To(Equal("SchedulingPending"), "the scheduler's word replaces the quota's")
	})
})
