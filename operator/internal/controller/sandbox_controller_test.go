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
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

var _ = Describe("Sandbox Controller", func() {
	Context("When reconciling a Sandbox", func() {
		const (
			resourceName      = "test-sandbox"
			resourceNamespace = "default"
		)

		ctx := context.Background()
		key := types.NamespacedName{Name: resourceName, Namespace: resourceNamespace}
		reconciler := &SandboxReconciler{}

		BeforeEach(func() {
			reconciler.Client = k8sClient
			reconciler.Scheme = k8sClient.Scheme()

			resource := &corev1alpha1.Sandbox{
				ObjectMeta: metav1.ObjectMeta{Name: resourceName, Namespace: resourceNamespace},
				Spec: corev1alpha1.SandboxSpec{
					Image: "ghcr.io/example/harness:latest",
					Port:  8080,
					Sidecars: []corev1.Container{{
						Name:  "agent",
						Image: "ghcr.io/example/agent:latest",
					}},
				},
			}
			Expect(k8sClient.Create(ctx, resource)).To(Succeed())
		})

		AfterEach(func() {
			resource := &corev1alpha1.Sandbox{}
			if err := k8sClient.Get(ctx, key, resource); err == nil {
				Expect(k8sClient.Delete(ctx, resource)).To(Succeed())
			} else {
				Expect(errors.IsNotFound(err)).To(BeTrue())
			}
			// envtest runs no garbage collector and no kubelet: the owned Pod would
			// outlive its Sandbox and be handed to the next spec as "the existing
			// pod". Remove it at once, so every spec builds its own.
			pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: resourceName, Namespace: resourceNamespace}}
			Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, pod, client.GracePeriodSeconds(0)))).To(Succeed())
			Eventually(func() bool {
				return errors.IsNotFound(k8sClient.Get(ctx, key, &corev1.Pod{}))
			}).Should(BeTrue())
		})

		It("creates an owned Pod and Service and reports Pending until the pod is Ready", func() {
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())

			By("creating a Service owned by the Sandbox, targeting the primary port")
			svc := &corev1.Service{}
			Expect(k8sClient.Get(ctx, key, svc)).To(Succeed())
			Expect(svc.Spec.Ports).To(HaveLen(1))
			Expect(svc.Spec.Ports[0].Port).To(Equal(int32(8080)))
			Expect(svc.OwnerReferences).To(HaveLen(1))
			Expect(svc.OwnerReferences[0].Kind).To(Equal("Sandbox"))

			By("creating a Pod with the primary container plus the sidecar, owned by the Sandbox")
			pod := &corev1.Pod{}
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			Expect(pod.Spec.Containers).To(HaveLen(2))
			Expect(pod.Spec.Containers[0].Name).To(Equal("harness"))
			Expect(pod.Spec.Containers[0].Image).To(Equal("ghcr.io/example/harness:latest"))
			Expect(pod.Spec.Containers[1].Name).To(Equal("agent"))
			Expect(pod.OwnerReferences).To(HaveLen(1))

			By("hardening the pod for isolation: no API token, default seccomp — and NOT pod-level non-root")
			Expect(pod.Spec.AutomountServiceAccountToken).NotTo(BeNil())
			Expect(*pod.Spec.AutomountServiceAccountToken).To(BeFalse())
			Expect(pod.Spec.SecurityContext).NotTo(BeNil())
			Expect(pod.Spec.SecurityContext.SeccompProfile.Type).To(Equal(corev1.SeccompProfileTypeRuntimeDefault))
			// Non-root moved to the containers (ADR-0005): a pod-level assertion binds every
			// container including the User Container, which must be able to run root.
			Expect(pod.Spec.SecurityContext.RunAsNonRoot).To(BeNil())

			By("hardening every container: non-root, no privilege escalation, drop ALL caps")
			for _, c := range pod.Spec.Containers {
				Expect(c.SecurityContext).NotTo(BeNil(), c.Name)
				Expect(c.SecurityContext.RunAsNonRoot).To(HaveValue(BeTrue()), c.Name)
				Expect(c.SecurityContext.AllowPrivilegeEscalation).To(HaveValue(BeFalse()), c.Name)
				Expect(c.SecurityContext.Capabilities.Drop).To(ContainElement(corev1.Capability("ALL")), c.Name)
			}

			By("injecting a readiness probe on the primary port so Ready means serving")
			probe := pod.Spec.Containers[0].ReadinessProbe
			Expect(probe).NotTo(BeNil())
			Expect(probe.TCPSocket).NotTo(BeNil())
			Expect(probe.TCPSocket.Port.IntValue()).To(Equal(8080))

			By("reporting phase Pending with an endpoint and refs")
			sandbox := &corev1alpha1.Sandbox{}
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxPending))
			Expect(sandbox.Status.Endpoint).To(Equal("http://test-sandbox.default.svc:8080"))
			Expect(sandbox.Status.PodRef.Name).To(Equal(resourceName))
			Expect(sandbox.Status.PodUID).To(Equal(pod.UID))
			Expect(sandbox.Status.ServiceRef.Name).To(Equal(resourceName))

			By("transitioning to Ready once the pod reports the Ready condition")
			pod.Status.Phase = corev1.PodRunning
			pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
			Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())

			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxReady))
		})

		It("republishes a new podUID when the Pod is replaced under the same Sandbox", func() {
			// The divergence this field exists for: an eviction or node loss takes the Pod
			// but not the CR, and the replacement comes up with an empty `work` volume — so
			// the Orchestrator's clones and unpushed commits are gone while every name it
			// holds still resolves. Only the identity changes (ADR-0021).
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())

			original := &corev1.Pod{}
			Expect(k8sClient.Get(ctx, key, original)).To(Succeed())

			sandbox := &corev1alpha1.Sandbox{}
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.PodUID).To(Equal(original.UID))

			By("losing the Pod out from under the Sandbox")
			Expect(k8sClient.Delete(ctx, original)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())

			By("recreating it under the same name, with a new identity")
			replacement := &corev1.Pod{}
			Expect(k8sClient.Get(ctx, key, replacement)).To(Succeed())
			Expect(replacement.Name).To(Equal(original.Name))
			Expect(replacement.UID).NotTo(Equal(original.UID))

			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.PodUID).To(Equal(replacement.UID))
			Expect(sandbox.Status.PodRef.Name).To(Equal(original.Name), "the name cannot reveal the swap — only the UID can")
		})

		It("holds Ready until every Repo it names is on its node, and reports whether it is fresh", func() {
			// ADR-0051's gate: the pod being Ready is necessary, not sufficient. The
			// cache the attach will clone from must be present on THIS node; whether
			// it was fetched since this Sandbox asked is reported beside Ready, never
			// in place of it.
			const repoKey = "app-0a1b2c3d"
			sandbox := &corev1alpha1.Sandbox{}
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			sandbox.Spec.Repos = []corev1alpha1.SandboxRepo{{Key: repoKey, URL: "https://github.com/acme/app.git"}}
			Expect(k8sClient.Update(ctx, sandbox)).To(Succeed())

			repo := &corev1alpha1.Repo{
				ObjectMeta: metav1.ObjectMeta{Name: repoKey, Namespace: resourceNamespace},
				Spec:       corev1alpha1.RepoSpec{URL: "https://github.com/acme/app.git"},
			}
			Expect(k8sClient.Create(ctx, repo)).To(Succeed())
			DeferCleanup(func() { Expect(k8sClient.Delete(ctx, repo)).To(Succeed()) })

			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())

			By("mounting the node cache read-only into the primary container")
			pod := &corev1.Pod{}
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			Expect(pod.Spec.Volumes).To(ContainElement(HaveField("Name", "repo-"+repoKey)))
			Expect(pod.Spec.Containers[0].VolumeMounts).To(ContainElement(And(
				HaveField("MountPath", "/repos/"+repoKey),
				HaveField("ReadOnly", BeTrue()),
			)))

			By("scheduling the pod and bringing it up Ready — which is not yet enough")
			binding := &corev1.Binding{
				ObjectMeta: metav1.ObjectMeta{Name: pod.Name, Namespace: pod.Namespace},
				Target:     corev1.ObjectReference{Kind: "Node", Name: "node-a"},
			}
			Expect(k8sClient.SubResource("binding").Create(ctx, pod, binding)).To(Succeed())
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			Expect(pod.Spec.NodeName).To(Equal("node-a"))
			pod.Status.Phase = corev1.PodRunning
			pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
			Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Node).To(Equal("node-a"))
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxPending))
			ready := meta.FindStatusCondition(sandbox.Status.Conditions, conditionReady)
			Expect(ready).NotTo(BeNil())
			Expect(ready.Reason).To(Equal("RepoPending"))
			Expect(ready.Message).To(ContainSubstring(`Repo "app-0a1b2c3d" is not on node node-a yet`))
			Expect(meta.FindStatusCondition(sandbox.Status.Conditions, conditionReposFresh)).To(BeNil())

			By("becoming Ready — stale — once the cache is present but its refresh since creation failed")
			// Freshness degrades, absence does not (ADR-0051): a warm cache whose
			// on-demand fetch failed still lets the attach proceed on the objects it
			// holds, and says so with git's own words.
			earlier := metav1.NewTime(sandbox.CreationTimestamp.Add(-time.Hour))
			now := metav1.Now()
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: repoKey, Namespace: resourceNamespace}, repo)).To(Succeed())
			repo.Status.Nodes = []corev1alpha1.RepoNodeStatus{{Node: "node-a", Present: true, Synced: false, LastError: "fatal: unable to access: timed out", LastAttempt: &now, LastFetched: &earlier}}
			Expect(k8sClient.Status().Update(ctx, repo)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxReady))
			fresh := meta.FindStatusCondition(sandbox.Status.Conditions, conditionReposFresh)
			Expect(fresh).NotTo(BeNil())
			Expect(fresh.Status).To(Equal(metav1.ConditionFalse))
			Expect(fresh.Reason).To(Equal("FetchFailed"))
			Expect(fresh.Message).To(ContainSubstring("timed out"))

			By("reporting fresh once a fetch since creation lands")
			later := metav1.NewTime(now.Add(time.Minute))
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: repoKey, Namespace: resourceNamespace}, repo)).To(Succeed())
			repo.Status.Nodes = []corev1alpha1.RepoNodeStatus{{Node: "node-a", Present: true, Synced: true, LastAttempt: &later, LastFetched: &later}}
			Expect(k8sClient.Status().Update(ctx, repo)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxReady))
			fresh = meta.FindStatusCondition(sandbox.Status.Conditions, conditionReposFresh)
			Expect(fresh).NotTo(BeNil())
			Expect(fresh.Status).To(Equal(metav1.ConditionTrue))
			Expect(fresh.Reason).To(Equal("Fetched"))
		})
	})
})
