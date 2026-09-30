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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
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
			Expect(probe.HTTPGet).NotTo(BeNil())
			Expect(probe.HTTPGet.Path).To(Equal("/healthz"))
			Expect(probe.HTTPGet.Port.IntValue()).To(Equal(8080))

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

		It("reports the scheduler's own words while no node admits the Pod (ADR-0052)", func() {
			// The Sandbox node set is empty right now — a pool scaled to zero, every node
			// tainted — or the CR's selector admits none. Not a verdict: the set moves,
			// so the Sandbox waits, and what `jr2 status` shows meanwhile is the taint or
			// label the scheduler named.
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())

			pod := &corev1.Pod{}
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			pod.Status.Phase = corev1.PodPending
			pod.Status.Conditions = []corev1.PodCondition{{
				Type:    corev1.PodScheduled,
				Status:  corev1.ConditionFalse,
				Reason:  corev1.PodReasonUnschedulable,
				Message: "0/3 nodes are available: 3 node(s) had untolerated taint {gpu: true}.",
			}}
			Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			sandbox := &corev1alpha1.Sandbox{}
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxPending))
			ready := meta.FindStatusCondition(sandbox.Status.Conditions, conditionReady)
			Expect(ready).NotTo(BeNil())
			Expect(ready.Reason).To(Equal("Unschedulable"))
			Expect(ready.Message).To(ContainSubstring("untolerated taint {gpu: true}"))

			By("returning to the plain not-Ready reason once a node took it")
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionTrue}}
			Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())
			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			ready = meta.FindStatusCondition(sandbox.Status.Conditions, conditionReady)
			Expect(ready.Reason).To(Equal("PodNotReady"))
		})

		It("publishes the pod facts the Orchestrator reads instead of the Pod (ADR-0063)", func() {
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())

			pod := &corev1.Pod{}
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			pod.Status.Phase = corev1.PodPending
			pod.Status.Conditions = []corev1.PodCondition{{
				Type:    corev1.PodScheduled,
				Status:  corev1.ConditionFalse,
				Reason:  corev1.PodReasonUnschedulable,
				Message: "0/2 nodes are available: 2 Insufficient memory.",
			}}
			Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())
			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())

			sandbox := &corev1alpha1.Sandbox{}
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			scheduled := meta.FindStatusCondition(sandbox.Status.Conditions, conditionScheduled)
			Expect(scheduled).NotTo(BeNil())
			Expect(scheduled.Status).To(Equal(metav1.ConditionFalse))
			Expect(scheduled.Reason).To(Equal("Unschedulable"))
			Expect(scheduled.Message).To(ContainSubstring("Insufficient memory"))
			Expect(sandbox.Status.Harness).To(BeNil(), "no container has been reported yet")

			By("placing the pod, then losing the Harness to a memory kill")
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			pod.Status.Phase = corev1.PodRunning
			pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionTrue}}
			pod.Status.ContainerStatuses = []corev1.ContainerStatus{
				{Name: "agent", Image: "agent", ImageID: "agent", Ready: true},
				{
					Name: "harness", Image: "harness", ImageID: "harness", RestartCount: 1,
					State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{
						Reason: "CrashLoopBackOff", Message: "back-off 10s restarting failed container",
					}},
					LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{
						Reason: "OOMKilled", ExitCode: 137,
						StartedAt: metav1.NewTime(time.Now().Add(-time.Minute)), FinishedAt: metav1.Now(),
					}},
				},
			}
			Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())
			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())

			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			scheduled = meta.FindStatusCondition(sandbox.Status.Conditions, conditionScheduled)
			Expect(scheduled.Status).To(Equal(metav1.ConditionTrue))
			Expect(sandbox.Status.Harness).NotTo(BeNil())
			Expect(sandbox.Status.Harness.RestartCount).To(Equal(int32(1)))
			Expect(sandbox.Status.Harness.LastTerminated).NotTo(BeNil())
			Expect(sandbox.Status.Harness.LastTerminated.Reason).To(Equal("OOMKilled"))
			Expect(sandbox.Status.Harness.LastTerminated.ExitCode).To(Equal(int32(137)))
			Expect(sandbox.Status.Waiting).To(Equal([]corev1alpha1.SandboxContainerWaiting{{
				Container: "harness", Reason: "CrashLoopBackOff", Message: "back-off 10s restarting failed container",
			}}), "a waiting container, in the kubelet's words")
		})

		It("writes status only when it changed — every write is a watch event (ADR-0063)", func() {
			// Counted at the client, not by resourceVersion: the API server drops a
			// byte-identical update itself, so only the call count shows the guard.
			writes := 0
			counting := &SandboxReconciler{Scheme: k8sClient.Scheme(), Client: statusWriteCounter{k8sClient, &writes}}
			_, err := counting.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(writes).To(Equal(2), "the first reconcile records the Pod it created, then publishes status")

			By("reconciling again with nothing changed, as a lease renewal does")
			_, err = counting.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(writes).To(Equal(2), "an unchanged status must not be written")

			By("writing once the pod's facts move")
			pod := &corev1.Pod{}
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			pod.Status.Phase = corev1.PodRunning
			pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
			Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())
			_, err = counting.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(writes).To(Equal(3))
			sandbox := &corev1alpha1.Sandbox{}
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxReady))
		})

		It("goes Lost for good when its Pod is deleted, and never makes a second (ADR-0021)", func() {
			// `work` is an emptyDir: a second Pod could continue nothing, would hold a
			// whole Size for nobody, and would hide the loss behind a name that still
			// resolves. So the Sandbox has one Pod for its life.
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())

			original := &corev1.Pod{}
			Expect(k8sClient.Get(ctx, key, original)).To(Succeed())
			sandbox := &corev1alpha1.Sandbox{}
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.PodUID).To(Equal(original.UID))

			By("losing the Pod out from under the Sandbox")
			Expect(k8sClient.Delete(ctx, original, client.GracePeriodSeconds(0))).To(Succeed())
			Eventually(func() bool {
				return errors.IsNotFound(k8sClient.Get(ctx, key, &corev1.Pod{}))
			}).Should(BeTrue())

			// A fresh reconciler: "created once" is read from the CR, so it holds
			// across an operator restart.
			restarted := &SandboxReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
			_, err = restarted.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())

			Expect(errors.IsNotFound(k8sClient.Get(ctx, key, &corev1.Pod{}))).To(BeTrue(), "no second Pod")
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxLost))
			lost := meta.FindStatusCondition(sandbox.Status.Conditions, conditionLost)
			Expect(lost).NotTo(BeNil())
			Expect(lost.Status).To(Equal(metav1.ConditionTrue))
			Expect(lost.Reason).To(Equal("PodDeleted"))
			Expect(lost.Message).To(ContainSubstring("was deleted"))
			ready := meta.FindStatusCondition(sandbox.Status.Conditions, conditionReady)
			Expect(ready.Status).To(Equal(metav1.ConditionFalse))
			Expect(ready.Reason).To(Equal("PodDeleted"))
			Expect(sandbox.Status.PodUID).To(Equal(original.UID), "the identity it had is kept")

			By("staying Lost, with no Pod, on every later reconcile — a lease renewal included")
			sandbox.Annotations = map[string]string{keepaliveAnnotation: metav1.Now().UTC().Format(time.RFC3339)}
			Expect(k8sClient.Update(ctx, sandbox)).To(Succeed())
			_, err = restarted.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(errors.IsNotFound(k8sClient.Get(ctx, key, &corev1.Pod{}))).To(BeTrue())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxLost))
		})

		It("goes Lost with the Pod's own words when the Pod ends in place, and leaves it there (ADR-0021)", func() {
			// A node-pressure eviction leaves the Pod object Failed, with the same UID:
			// no deletion, no replacement. Only the phase says the workspace is gone.
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())

			pod := &corev1.Pod{}
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			pod.Status.Phase = corev1.PodFailed
			pod.Status.Reason = "Evicted"
			pod.Status.Message = "The node was low on resource: memory."
			Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			sandbox := &corev1alpha1.Sandbox{}
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxLost))
			lost := meta.FindStatusCondition(sandbox.Status.Conditions, conditionLost)
			Expect(lost).NotTo(BeNil())
			Expect(lost.Reason).To(Equal("Evicted"))
			Expect(lost.Message).To(Equal("The node was low on resource: memory."))

			By("leaving the terminal Pod in place — teardown deletes the CR, owner refs reap it")
			left := &corev1.Pod{}
			Expect(k8sClient.Get(ctx, key, left)).To(Succeed())
			Expect(left.UID).To(Equal(pod.UID))
			Expect(left.DeletionTimestamp).To(BeNil())

			By("never returning to Ready, whatever the Pod later says")
			left.Status.Phase = corev1.PodRunning
			left.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
			Expect(k8sClient.Status().Update(ctx, left)).To(Succeed())
			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxLost))
		})

		It("goes Lost as soon as its bound Pod is being deleted — a drain, a lost node (ADR-0021)", func() {
			// A Pod on a node that is gone stays Terminating until someone forces it;
			// NotFound may never come.
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			pod := &corev1.Pod{}
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			binding := &corev1.Binding{
				ObjectMeta: metav1.ObjectMeta{Name: pod.Name, Namespace: pod.Namespace},
				Target:     corev1.ObjectReference{Kind: "Node", Name: "node-a"},
			}
			Expect(k8sClient.SubResource("binding").Create(ctx, pod, binding)).To(Succeed())
			// Bound, and envtest has no kubelet: a graceful delete leaves it Terminating.
			Expect(k8sClient.Delete(ctx, pod)).To(Succeed())
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			Expect(pod.DeletionTimestamp).NotTo(BeNil())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			sandbox := &corev1alpha1.Sandbox{}
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxLost))
			Expect(meta.FindStatusCondition(sandbox.Status.Conditions, conditionLost).Reason).To(Equal("PodDeleted"))
		})

		It("carries an ask onto the pod and answers it on status.repos, leaving Ready alone (ADR-0053)", func() {
			// A fetch inside the pod asks the cache: the Orchestrator marks the ask
			// on this CR, the operator copies it onto the pod — where the cache
			// agent reads demand — and the standing per-key entry says whether the
			// node has fetched since. Ready is not part of it: it was taken once,
			// when the pod passed the gate, and a Sandbox outlives its creation.
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
			DeferCleanup(func() {
				Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, &corev1alpha1.Repo{ObjectMeta: metav1.ObjectMeta{Name: repoKey, Namespace: resourceNamespace}}))).To(Succeed())
			})

			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			pod := &corev1.Pod{}
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			binding := &corev1.Binding{
				ObjectMeta: metav1.ObjectMeta{Name: pod.Name, Namespace: pod.Namespace},
				Target:     corev1.ObjectReference{Kind: "Node", Name: "node-a"},
			}
			Expect(k8sClient.SubResource("binding").Create(ctx, pod, binding)).To(Succeed())
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			pod.Status.Phase = corev1.PodRunning
			pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
			Expect(k8sClient.Status().Update(ctx, pod)).To(Succeed())

			By("reaching Ready on a cache fetched since creation — a creation is an ask")
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			landed := metav1.NewTime(sandbox.CreationTimestamp.Add(time.Second))
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: repoKey, Namespace: resourceNamespace}, repo)).To(Succeed())
			repo.Status.Nodes = []corev1alpha1.RepoNodeStatus{{Node: "node-a", Present: true, Synced: true, Attempted: corev1alpha1.RepoAttemptFetch, LastAttempt: &landed, LastFetched: &landed}}
			Expect(k8sClient.Status().Update(ctx, repo)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxReady))
			Expect(sandbox.Status.Repos).To(HaveLen(1))
			Expect(sandbox.Status.Repos[0].Key).To(Equal(repoKey))
			Expect(sandbox.Status.Repos[0].Asked).To(Equal(sandbox.CreationTimestamp))
			Expect(sandbox.Status.Repos[0].Fetched).NotTo(BeNil())
			Expect(sandbox.Status.Repos[0].Error).To(BeEmpty())

			By("marking an ask on the CR: the entry goes unanswered and the ask reaches the pod")
			ask := metav1.NewTime(landed.Add(time.Minute))
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			sandbox.Annotations = map[string]string{corev1alpha1.AskedAnnotation(repoKey): ask.UTC().Format(time.RFC3339)}
			Expect(k8sClient.Update(ctx, sandbox)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, pod)).To(Succeed())
			Expect(pod.Annotations).To(HaveKeyWithValue(corev1alpha1.AskedAnnotation(repoKey), ask.UTC().Format(time.RFC3339)))
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Repos[0].Asked).To(Equal(ask))
			Expect(sandbox.Status.Repos[0].Fetched.Time).To(Equal(landed.Time), "the older landing is still named — it dates the cache, it just does not answer the ask")
			Expect(sandbox.Status.Repos[0].Attempted.Time).To(Equal(landed.Time))
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxReady), "Ready is sticky and this is not its business")

			By("answering the ask once the node fetched after it")
			after := metav1.NewTime(ask.Add(time.Second))
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: repoKey, Namespace: resourceNamespace}, repo)).To(Succeed())
			repo.Status.Nodes = []corev1alpha1.RepoNodeStatus{{Node: "node-a", Present: true, Synced: true, Attempted: corev1alpha1.RepoAttemptFetch, LastAttempt: &after, LastFetched: &after}}
			Expect(k8sClient.Status().Update(ctx, repo)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Repos[0].Fetched).NotTo(BeNil())
			Expect(sandbox.Status.Repos[0].Fetched.Time).To(Equal(after.Time))

			By("reporting git's words when the attempt for a later ask failed — the caller serves the cache and says so")
			second := metav1.NewTime(after.Add(time.Minute))
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			sandbox.Annotations[corev1alpha1.AskedAnnotation(repoKey)] = second.UTC().Format(time.RFC3339)
			Expect(k8sClient.Update(ctx, sandbox)).To(Succeed())
			failed := metav1.NewTime(second.Add(time.Second))
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: repoKey, Namespace: resourceNamespace}, repo)).To(Succeed())
			repo.Status.Nodes = []corev1alpha1.RepoNodeStatus{{Node: "node-a", Present: true, Synced: false, Attempted: corev1alpha1.RepoAttemptFetch, LastAttempt: &failed, LastFetched: &after, LastError: "fatal: unable to access: timed out"}}
			Expect(k8sClient.Status().Update(ctx, repo)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Repos[0].Fetched.Time).To(Equal(after.Time), "git's words, beside the time the cache's objects are as of")
			Expect(sandbox.Status.Repos[0].Error).To(Equal("fatal: unable to access: timed out"))
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxReady))
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
			DeferCleanup(func() {
				Expect(client.IgnoreNotFound(k8sClient.Delete(ctx, &corev1alpha1.Repo{ObjectMeta: metav1.ObjectMeta{Name: repoKey, Namespace: resourceNamespace}}))).To(Succeed())
			})

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
			// status.node is the Pod's node, published as a reader's key into each
			// Repo's status.nodes[] — the operator itself gates on the Pod.
			Expect(sandbox.Status.Node).To(Equal(pod.Spec.NodeName))
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxPending))
			ready := meta.FindStatusCondition(sandbox.Status.Conditions, conditionReady)
			Expect(ready).NotTo(BeNil())
			Expect(ready.Reason).To(Equal("RepoPending"))
			Expect(ready.Message).To(ContainSubstring(`Repo "app-0a1b2c3d" is not on node node-a yet`))
			Expect(meta.FindStatusCondition(sandbox.Status.Conditions, conditionReposFresh)).To(BeNil())

			By("staying Pending when the node's probe failed since creation — no clone was tried")
			// The Orchestrator creates the Repo just before the Sandbox, so the node's
			// probe lands after creation; its failure is `jr2 status`'s signal, and the
			// pod's arrival makes the agent clone. Only that clone's failure is terminal.
			now := metav1.Now()
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: repoKey, Namespace: resourceNamespace}, repo)).To(Succeed())
			repo.Status.Nodes = []corev1alpha1.RepoNodeStatus{{Node: "node-a", Present: false, Synced: false, Attempted: corev1alpha1.RepoAttemptProbe, LastError: "fatal: unable to access: Could not resolve host", LastAttempt: &now}}
			Expect(k8sClient.Status().Update(ctx, repo)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxPending))
			ready = meta.FindStatusCondition(sandbox.Status.Conditions, conditionReady)
			Expect(ready.Reason).To(Equal("RepoPending"))

			By("holding with RepoCloneFailed and git's words once the clone onto its node failed")
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: repoKey, Namespace: resourceNamespace}, repo)).To(Succeed())
			repo.Status.Nodes = []corev1alpha1.RepoNodeStatus{{Node: "node-a", Present: false, Synced: false, Attempted: corev1alpha1.RepoAttemptClone, LastError: "fatal: repository not found", LastAttempt: &now}}
			Expect(k8sClient.Status().Update(ctx, repo)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxPending))
			ready = meta.FindStatusCondition(sandbox.Status.Conditions, conditionReady)
			Expect(ready.Reason).To(Equal("RepoCloneFailed"))
			Expect(ready.Message).To(Equal(`Repo "app-0a1b2c3d" could not be cloned onto node node-a: fatal: repository not found`))

			By("becoming Ready — stale — once the cache is present but its refresh since creation failed")
			// Freshness degrades, absence does not (ADR-0051): a warm cache whose
			// on-demand fetch failed still lets the attach proceed on the objects it
			// holds, and says so with git's own words.
			earlier := metav1.NewTime(sandbox.CreationTimestamp.Add(-time.Hour))
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: repoKey, Namespace: resourceNamespace}, repo)).To(Succeed())
			repo.Status.Nodes = []corev1alpha1.RepoNodeStatus{{Node: "node-a", Present: true, Synced: false, Attempted: corev1alpha1.RepoAttemptFetch, LastError: "fatal: unable to access: timed out", LastAttempt: &now, LastFetched: &earlier}}
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

			Expect(nodeEntry(repo, sandbox.Status.Node)).To(Equal(&repo.Status.Nodes[0]), "status.node keys the Repo's entry a reader joins on")

			By("keeping that verdict once granted: a fetch that lands later does not move it")
			// The gate is asked until it passes for the pod, and its verdict then
			// stands: the attach read its inputs at Ready, and a verdict that moved
			// afterwards would describe an attach that never happened.
			later := metav1.NewTime(now.Add(time.Minute))
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: repoKey, Namespace: resourceNamespace}, repo)).To(Succeed())
			repo.Status.Nodes = []corev1alpha1.RepoNodeStatus{{Node: "node-a", Present: true, Synced: true, Attempted: corev1alpha1.RepoAttemptFetch, LastAttempt: &later, LastFetched: &later}}
			Expect(k8sClient.Status().Update(ctx, repo)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxReady))
			fresh = meta.FindStatusCondition(sandbox.Status.Conditions, conditionReposFresh)
			Expect(fresh).NotTo(BeNil())
			Expect(fresh.Status).To(Equal(metav1.ConditionFalse))

			By("staying Ready on the lease renewal after `jr2 gc` evicted the Repo resource under the live pod")
			// Eviction is reachability plus age (ADR-0051): a Workspace parked past
			// the TTL loses its resource while its pod still mounts the cache — which
			// the agent keeps for exactly that reason. The lease's next renewal is a
			// Sandbox event, and the reconcile it triggers must not re-ask the gate.
			Expect(k8sClient.Delete(ctx, repo)).To(Succeed())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			sandbox.Annotations = map[string]string{keepaliveAnnotation: metav1.Now().UTC().Format(time.RFC3339)}
			Expect(k8sClient.Update(ctx, sandbox)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxReady))
			ready = meta.FindStatusCondition(sandbox.Status.Conditions, conditionReady)
			Expect(ready.Reason).To(Equal("PodReady"))
			fresh = meta.FindStatusCondition(sandbox.Status.Conditions, conditionReposFresh)
			Expect(fresh).NotTo(BeNil(), "the verdict the pod passed the gate with stands")
			Expect(fresh.Status).To(Equal(metav1.ConditionFalse))

			By("staying Ready when a later attach recreates the resource with an empty status")
			repo = &corev1alpha1.Repo{
				ObjectMeta: metav1.ObjectMeta{Name: repoKey, Namespace: resourceNamespace},
				Spec:       corev1alpha1.RepoSpec{URL: "https://github.com/acme/app.git"},
			}
			Expect(k8sClient.Create(ctx, repo)).To(Succeed())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxReady))

			By("going Lost, not back to the gate, when that pod is deleted (ADR-0021)")
			Expect(k8sClient.Delete(ctx, pod, client.GracePeriodSeconds(0))).To(Succeed())
			Eventually(func() bool {
				return errors.IsNotFound(k8sClient.Get(ctx, key, &corev1.Pod{}))
			}).Should(BeTrue())

			_, err = reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: key})
			Expect(err).NotTo(HaveOccurred())
			Expect(errors.IsNotFound(k8sClient.Get(ctx, key, &corev1.Pod{}))).To(BeTrue(), "no second Pod")
			Expect(k8sClient.Get(ctx, key, sandbox)).To(Succeed())
			Expect(sandbox.Status.Phase).To(Equal(corev1alpha1.SandboxLost))
		})
	})
})

// statusWriteCounter counts status writes on their way to the API server.
type statusWriteCounter struct {
	client.Client
	writes *int
}

func (c statusWriteCounter) Status() client.SubResourceWriter {
	return countingStatusWriter{c.Client.Status(), c.writes}
}

type countingStatusWriter struct {
	client.SubResourceWriter
	writes *int
}

func (w countingStatusWriter) Update(ctx context.Context, obj client.Object, opts ...client.SubResourceUpdateOption) error {
	*w.writes++
	return w.SubResourceWriter.Update(ctx, obj, opts...)
}

func (w countingStatusWriter) Patch(ctx context.Context, obj client.Object, patch client.Patch, opts ...client.SubResourcePatchOption) error {
	*w.writes++
	return w.SubResourceWriter.Patch(ctx, obj, patch, opts...)
}
