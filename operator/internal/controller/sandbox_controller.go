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
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

const (
	// defaultPort is used when spec.port is unset (CRD defaulting normally
	// fills this, but unit/envtest paths may skip admission defaulting).
	defaultPort = 8080
	// conditionReady mirrors status.phase==Ready as a standard condition.
	conditionReady = "Ready"
	// keepaliveAnnotation carries the owning Orchestrator's heartbeat lease
	// (ADR-0001): an RFC3339 timestamp it PATCHes periodically. Idle GC fires
	// only once spec.idleTimeout has elapsed since max(creation, last keepalive).
	keepaliveAnnotation = "j2.dev/keepalive"
)

// SandboxReconciler reconciles a Sandbox object
type SandboxReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.j2.dev,resources=sandboxes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.j2.dev,resources=sandboxes/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.j2.dev,resources=sandboxes/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete

// Reconcile drives a Sandbox toward its desired state: a Pod (primary container
// plus any sidecars) and a Service, with status.phase / status.endpoint
// reported back. The Pod and Service are owned by the Sandbox so deleting the CR
// garbage-collects them; a Sandbox whose keepalive lease has lapsed past
// spec.idleTimeout deletes itself (ADR-0001).
func (r *SandboxReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var sandbox corev1alpha1.Sandbox
	if err := r.Get(ctx, req.NamespacedName, &sandbox); err != nil {
		// Not found: owner-reference GC already handled the Pod/Service.
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Being deleted: surface Terminating; owner refs GC the Pod + Service.
	if !sandbox.DeletionTimestamp.IsZero() {
		if sandbox.Status.Phase != corev1alpha1.SandboxTerminating {
			sandbox.Status.Phase = corev1alpha1.SandboxTerminating
			if err := r.Status().Update(ctx, &sandbox); err != nil {
				return ctrl.Result{}, client.IgnoreNotFound(err)
			}
		}
		return ctrl.Result{}, nil
	}

	// Idle GC: an abandoned Sandbox (lease lapsed — ADR-0001) deletes itself.
	deleted, requeueAfter, err := r.reconcileIdleTimeout(ctx, &sandbox)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile idle timeout: %w", err)
	}
	if deleted {
		return ctrl.Result{}, nil
	}

	if err := r.reconcileService(ctx, &sandbox); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile service: %w", err)
	}

	pod, err := r.reconcilePod(ctx, &sandbox)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile pod: %w", err)
	}

	if err := r.reconcileStatus(ctx, &sandbox, pod); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile status: %w", err)
	}

	log.V(1).Info("reconciled", "phase", sandbox.Status.Phase, "endpoint", sandbox.Status.Endpoint)
	// requeueAfter re-checks the idle deadline without relying on an external
	// event; zero means no idle re-check is pending.
	return ctrl.Result{RequeueAfter: requeueAfter}, nil
}

// reconcileIdleTimeout deletes an abandoned Sandbox — one whose heartbeat
// lease (ADR-0001) has lapsed: spec.idleTimeout elapsed since
// max(CreationTimestamp, last keepalive annotation). Nothing in the cluster
// represents a run, so liveness is asserted by the owning Orchestrator's
// periodic keepalive PATCH, not referenced via ownerReferences. It returns
// deleted=true when it removed the Sandbox (the caller should stop), or a
// non-zero requeueAfter so the controller re-checks at the deadline.
func (r *SandboxReconciler) reconcileIdleTimeout(ctx context.Context, sandbox *corev1alpha1.Sandbox) (deleted bool, requeueAfter time.Duration, err error) {
	if sandbox.Spec.IdleTimeout == nil {
		return false, 0, nil
	}
	deadline := lastKeepalive(ctx, sandbox).Add(sandbox.Spec.IdleTimeout.Duration)
	if remaining := time.Until(deadline); remaining > 0 {
		return false, remaining, nil
	}
	logf.FromContext(ctx).Info("keepalive lease lapsed; deleting abandoned sandbox", "idleTimeout", sandbox.Spec.IdleTimeout.Duration)
	if err := r.Delete(ctx, sandbox); err != nil {
		return false, 0, client.IgnoreNotFound(err)
	}
	return true, 0, nil
}

// lastKeepalive resolves the lease's reference instant: the keepalive
// annotation when present and parseable (RFC3339), otherwise creation — a
// Sandbox that has never been heartbeated still gets a full idleTimeout from
// birth. A garbage value is treated as absent, loudly.
func lastKeepalive(ctx context.Context, sandbox *corev1alpha1.Sandbox) time.Time {
	created := sandbox.CreationTimestamp.Time
	raw, ok := sandbox.Annotations[keepaliveAnnotation]
	if !ok {
		return created
	}
	ts, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		logf.FromContext(ctx).Info("unparseable keepalive annotation; treating as absent", "value", raw, "error", err.Error())
		return created
	}
	if ts.After(created) {
		return ts
	}
	return created
}

// reconcileService ensures the headed Service fronting the Sandbox exists and
// targets the primary container's port.
func (r *SandboxReconciler) reconcileService(ctx context.Context, sandbox *corev1alpha1.Sandbox) error {
	port := portFor(sandbox)
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: sandbox.Name, Namespace: sandbox.Namespace},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, svc, func() error {
		svc.Labels = sandboxLabels(sandbox)
		svc.Spec.Selector = sandboxLabels(sandbox)
		svc.Spec.Ports = []corev1.ServicePort{{
			Name:       "http",
			Port:       port,
			TargetPort: intstrFromInt32(port),
			Protocol:   corev1.ProtocolTCP,
		}}
		return controllerutil.SetControllerReference(sandbox, svc, r.Scheme)
	})
	return err
}

// reconcilePod ensures the Sandbox's Pod exists. Pods are largely immutable, so
// this creates the Pod when absent and otherwise returns the existing one;
// changing the spec of a running Sandbox is out of scope for this operator.
func (r *SandboxReconciler) reconcilePod(ctx context.Context, sandbox *corev1alpha1.Sandbox) (*corev1.Pod, error) {
	pod := &corev1.Pod{}
	err := r.Get(ctx, client.ObjectKey{Name: sandbox.Name, Namespace: sandbox.Namespace}, pod)
	if err == nil {
		return pod, nil
	}
	if !apierrors.IsNotFound(err) {
		return nil, err
	}

	pod = r.buildPod(sandbox)
	if err := controllerutil.SetControllerReference(sandbox, pod, r.Scheme); err != nil {
		return nil, err
	}
	if err := r.Create(ctx, pod); err != nil {
		if apierrors.IsAlreadyExists(err) {
			// Lost a race; re-read.
			return pod, r.Get(ctx, client.ObjectKey{Name: sandbox.Name, Namespace: sandbox.Namespace}, pod)
		}
		return nil, err
	}
	return pod, nil
}

// buildPod assembles the Pod: the primary container from the Sandbox's image and
// infra fields, plus the generic sidecar containers verbatim.
func (r *SandboxReconciler) buildPod(sandbox *corev1alpha1.Sandbox) *corev1.Pod {
	primary := corev1.Container{
		Name:            "harness",
		Image:           sandbox.Spec.Image,
		Command:         sandbox.Spec.Command,
		Args:            sandbox.Spec.Args,
		Resources:       sandbox.Spec.Resources,
		Env:             sandbox.Spec.Env,
		EnvFrom:         sandbox.Spec.EnvFrom,
		VolumeMounts:    sandbox.Spec.VolumeMounts,
		ReadinessProbe:  readinessProbeFor(sandbox),
		SecurityContext: containerSecurityContextFor(sandbox),
		Ports: []corev1.ContainerPort{{
			Name:          "http",
			ContainerPort: portFor(sandbox),
			Protocol:      corev1.ProtocolTCP,
		}},
	}

	// Sidecars (Agents) are untrusted; default each to the same hardened
	// container baseline unless it declares its own securityContext — EXCEPT
	// the User Container (ADR-0005), which is exempt entirely. See
	// userContainerName.
	sidecars := make([]corev1.Container, len(sandbox.Spec.Sidecars))
	for i, c := range sandbox.Spec.Sidecars {
		if c.SecurityContext == nil && c.Name != userContainerName {
			c.SecurityContext = hardenedContainerSecurityContext()
		}
		sidecars[i] = c
	}

	containers := append([]corev1.Container{primary}, sidecars...)
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      sandbox.Name,
			Namespace: sandbox.Namespace,
			Labels:    sandboxLabels(sandbox),
		},
		Spec: corev1.PodSpec{
			// Bare pod, long-lived and interactive: no Deployment-style
			// resurrection (ADR-0001); restart crashed containers in place.
			RestartPolicy: corev1.RestartPolicyAlways,
			// Verbatim, in order, before any container starts. The operator adds
			// nothing here — not even the hardened default — because an init
			// step is composed by whoever built the spec (ADR-0037's runtime
			// injection is two of them), and it must be able to state its own
			// context.
			InitContainers: sandbox.Spec.InitContainers,
			Containers:     containers,
			Volumes:        sandbox.Spec.Volumes,
			// Isolation north star: an untrusted Agent must not reach the
			// Kubernetes API. Don't mount the SA token, and run every j2-owned
			// container non-root under the default seccomp profile. (Egress
			// NetworkPolicy is the next isolation layer — see ADR-0001.)
			AutomountServiceAccountToken: ptr.To(false),
			SecurityContext:              podSecurityContextFor(sandbox),
		},
	}
}

// readinessProbeFor returns the primary container's readiness probe: the
// Sandbox's override when set, otherwise a TCPSocket probe on the serving port
// so phase Ready means the Harness accepts connections (not just "started").
func readinessProbeFor(sandbox *corev1alpha1.Sandbox) *corev1.Probe {
	if sandbox.Spec.ReadinessProbe != nil {
		return sandbox.Spec.ReadinessProbe
	}
	return &corev1.Probe{
		ProbeHandler: corev1.ProbeHandler{
			TCPSocket: &corev1.TCPSocketAction{Port: intstrFromInt32(portFor(sandbox))},
		},
	}
}

// podSecurityContextFor is the pod-level context: the default seccomp profile
// for everything in the pod, plus the fsGroup when the spec names one.
//
// runAsNonRoot is deliberately NOT here. A pod-level runAsNonRoot binds every
// container including the ones j2 does not own, and the User Container
// (ADR-0005) must be able to run root — a root sshd that binds :22 and setuids
// sessions down to its login user is the standard managed-access shape. Non-root
// is asserted per container instead, on the seats j2 owns, which says the same
// thing about them without saying anything about the seat it does not.
func podSecurityContextFor(sandbox *corev1alpha1.Sandbox) *corev1.PodSecurityContext {
	return &corev1.PodSecurityContext{
		SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
		// Shared-volume ownership across uids (ADR-0005's work group). Passed
		// through, never defaulted: what number to use is the spec author's
		// call, and an operator-invented gid would silently disagree with the
		// one an image's session user actually holds.
		FSGroup: sandbox.Spec.FSGroup,
	}
}

// userContainerName is the one sidecar name the operator treats specially, and
// only by leaving it alone: the User Container (ADR-0005). It gets no hardened
// default — root and the default capability set are allowed — because the seat
// exists precisely as the place j2 injects, probes, and overrides nothing. A
// platform that wants it hardened hardens its own image or the namespace's Pod
// Security profile.
const userContainerName = "user"

// containerSecurityContextFor is the primary container's context: the spec's
// own when it states one, otherwise the hardened default. The same rule the
// sidecar loop follows — harden what says nothing about itself, and step aside
// for what does, because only the composer of a spec knows facts the operator
// cannot (whether the primary image declares a USER, ADR-0037).
func containerSecurityContextFor(sandbox *corev1alpha1.Sandbox) *corev1.SecurityContext {
	if sandbox.Spec.SecurityContext != nil {
		return sandbox.Spec.SecurityContext
	}
	return hardenedContainerSecurityContext()
}

// hardenedContainerSecurityContext drops all Linux capabilities and blocks
// privilege escalation — the per-container half of the isolation baseline.
func hardenedContainerSecurityContext() *corev1.SecurityContext {
	return &corev1.SecurityContext{
		RunAsNonRoot:             ptr.To(true),
		AllowPrivilegeEscalation: ptr.To(false),
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		SeccompProfile:           &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
	}
}

// reconcileStatus computes phase/endpoint/refs from the live Pod and writes
// status. Phase reaches Ready only when the Pod reports the Ready condition.
func (r *SandboxReconciler) reconcileStatus(ctx context.Context, sandbox *corev1alpha1.Sandbox, pod *corev1.Pod) error {
	ready := podReady(pod)
	phase := corev1alpha1.SandboxPending
	if ready {
		phase = corev1alpha1.SandboxReady
	}

	sandbox.Status.Phase = phase
	sandbox.Status.Endpoint = fmt.Sprintf("http://%s.%s.svc:%d", sandbox.Name, sandbox.Namespace, portFor(sandbox))
	sandbox.Status.PodRef = &corev1.LocalObjectReference{Name: pod.Name}
	// Identity, not just address: a replacement Pod reuses the name but never the
	// UID, and it comes up with an empty `work` volume. Publishing the UID is what
	// lets the owning Orchestrator notice its workspace was replaced (ADR-0021).
	sandbox.Status.PodUID = pod.UID
	sandbox.Status.ServiceRef = &corev1.LocalObjectReference{Name: sandbox.Name}

	cond := metav1.Condition{
		Type:               conditionReady,
		ObservedGeneration: sandbox.Generation,
		Reason:             "PodNotReady",
		Status:             metav1.ConditionFalse,
		Message:            "pod is not yet Ready",
	}
	if ready {
		cond.Reason = "PodReady"
		cond.Status = metav1.ConditionTrue
		cond.Message = "pod reports Ready"
	}
	meta.SetStatusCondition(&sandbox.Status.Conditions, cond)

	return r.Status().Update(ctx, sandbox)
}

// SetupWithManager sets up the controller with the Manager.
func (r *SandboxReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.Sandbox{}).
		Owns(&corev1.Pod{}).
		Owns(&corev1.Service{}).
		Named("sandbox").
		Complete(r)
}
