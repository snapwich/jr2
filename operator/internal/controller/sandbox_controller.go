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
	"slices"
	"strings"
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
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

const (
	// defaultPort is used when spec.port is unset (CRD defaulting normally
	// fills this, but unit/envtest paths may skip admission defaulting).
	defaultPort = 8080
	// conditionReady mirrors status.phase==Ready as a standard condition.
	conditionReady = "Ready"
	// conditionReposFresh is set once Ready and says whether every Repo cache
	// the Sandbox mounts was fetched since the Sandbox was created (ADR-0051):
	// True with reason Fetched, or False with reason FetchFailed and git's
	// words — a warm cache whose refresh failed lets the attach proceed on
	// what it holds, announced as stale. Freshness degrades; absence does not.
	conditionReposFresh = "ReposFresh"

	// Ready reasons a Repo cache can hold a Sandbox at, and the two ReposFresh
	// reasons. The Orchestrator's port keys on RepoCloneFailed to fail a
	// provision at once instead of burning its Ready budget (ADR-0051).
	reasonRepoMissing     = "RepoMissing"
	reasonRepoPending     = "RepoPending"
	reasonRepoCloneFailed = "RepoCloneFailed"
	reasonFetched         = "Fetched"
	reasonFetchFailed     = "FetchFailed"
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
// +kubebuilder:rbac:groups=core.j2.dev,resources=repos,verbs=get;list;watch

// Reconcile drives a Sandbox toward its desired state: a Pod (primary container
// plus any sidecars) and a Service, with status.phase / status.endpoint
// reported back. The Pod and Service are owned by the Sandbox so deleting the CR
// garbage-collects them; a Sandbox whose keepalive lease has lapsed past
// spec.idleTimeout deletes itself (ADR-0001). The Repos the spec names are read
// (never written) to place the Pod near their caches and to hold Ready until
// every one is present on its node and fetched (ADR-0051).
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

	repos, err := r.reposFor(ctx, &sandbox)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("read repos: %w", err)
	}

	pod, err := r.reconcilePod(ctx, &sandbox, repos)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile pod: %w", err)
	}

	if err := r.reconcileStatus(ctx, &sandbox, pod, repos); err != nil {
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

// reposFor reads the Repo resource behind every key the Sandbox names. A key
// whose Repo does not exist is absent from the map: it contributes no
// scheduling preference and holds Ready with reason RepoMissing.
func (r *SandboxReconciler) reposFor(ctx context.Context, sandbox *corev1alpha1.Sandbox) (map[string]*corev1alpha1.Repo, error) {
	repos := make(map[string]*corev1alpha1.Repo, len(sandbox.Spec.Repos))
	for _, ref := range sandbox.Spec.Repos {
		repo := &corev1alpha1.Repo{}
		err := r.Get(ctx, client.ObjectKey{Name: ref.Key, Namespace: sandbox.Namespace}, repo)
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		repos[ref.Key] = repo
	}
	return repos, nil
}

// reconcilePod ensures the Sandbox's Pod exists. Pods are largely immutable, so
// this creates the Pod when absent and otherwise returns the existing one;
// changing the spec of a running Sandbox is out of scope for this operator.
func (r *SandboxReconciler) reconcilePod(ctx context.Context, sandbox *corev1alpha1.Sandbox, repos map[string]*corev1alpha1.Repo) (*corev1.Pod, error) {
	pod := &corev1.Pod{}
	err := r.Get(ctx, client.ObjectKey{Name: sandbox.Name, Namespace: sandbox.Namespace}, pod)
	if err == nil {
		return pod, nil
	}
	if !apierrors.IsNotFound(err) {
		return nil, err
	}

	pod = r.buildPod(sandbox, repos)
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
// infra fields, plus the generic sidecar containers verbatim, plus one
// read-only volume per Repo the spec names — the node's cache (ADR-0051),
// which the Pod is steered toward nodes already holding.
func (r *SandboxReconciler) buildPod(sandbox *corev1alpha1.Sandbox, repos map[string]*corev1alpha1.Repo) *corev1.Pod {
	repoVolumes, repoMounts := repoVolumesFor(sandbox)
	primary := corev1.Container{
		Name:            "harness",
		Image:           sandbox.Spec.Image,
		Command:         sandbox.Spec.Command,
		Args:            sandbox.Spec.Args,
		Resources:       sandbox.Spec.Resources,
		Env:             sandbox.Spec.Env,
		EnvFrom:         sandbox.Spec.EnvFrom,
		VolumeMounts:    append(append([]corev1.VolumeMount{}, sandbox.Spec.VolumeMounts...), repoMounts...),
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
			Volumes:        append(append([]corev1.Volume{}, sandbox.Spec.Volumes...), repoVolumes...),
			// Soft: a node already holding the caches saves a clone; a node
			// without them clones on first need, the image-pull economics
			// ADR-0051 chose. Never a hard requirement, so node count never
			// bounds placement.
			Affinity: repoAffinityFor(sandbox, repos),
			// Isolation north star: an untrusted Agent must not reach the
			// Kubernetes API. Don't mount the SA token, and run every j2-owned
			// container non-root under the default seccomp profile. (Egress
			// NetworkPolicy is the next isolation layer — see ADR-0001.)
			AutomountServiceAccountToken: ptr.To(false),
			SecurityContext:              podSecurityContextFor(sandbox),
		},
	}
}

// repoVolumesFor returns one hostPath volume per Repo the Sandbox names — the
// node's cache directory for that key, created by the kubelet if the cache
// agent has not yet — and its read-only mount in the primary container.
// Read-only is load-bearing twice (ADR-0004): no write contention on the shared
// thing, and nothing in a Sandbox can `gc` the objects its clones borrow.
func repoVolumesFor(sandbox *corev1alpha1.Sandbox) ([]corev1.Volume, []corev1.VolumeMount) {
	if len(sandbox.Spec.Repos) == 0 {
		return nil, nil
	}
	volumes := make([]corev1.Volume, 0, len(sandbox.Spec.Repos))
	mounts := make([]corev1.VolumeMount, 0, len(sandbox.Spec.Repos))
	for _, repo := range sandbox.Spec.Repos {
		volumes = append(volumes, corev1.Volume{
			Name: repoVolumeName(repo.Key),
			VolumeSource: corev1.VolumeSource{
				HostPath: &corev1.HostPathVolumeSource{
					Path: repoHostPath(sandbox.Namespace, repo.Key),
					Type: ptr.To(corev1.HostPathDirectoryOrCreate),
				},
			},
		})
		mounts = append(mounts, corev1.VolumeMount{
			Name:      repoVolumeName(repo.Key),
			MountPath: repoMountPath(repo.Key),
			ReadOnly:  true,
		})
	}
	return volumes, mounts
}

// repoAffinityFor prefers nodes whose Repo status reports a cache present: one
// preferred term of weight 1 per key at least one node holds, so a node holding
// more of the Sandbox's Repos scores higher. A Repo that does not exist, or
// that no node holds yet, contributes no term; no terms means nil affinity.
func repoAffinityFor(sandbox *corev1alpha1.Sandbox, repos map[string]*corev1alpha1.Repo) *corev1.Affinity {
	var terms []corev1.PreferredSchedulingTerm
	for _, ref := range sandbox.Spec.Repos {
		repo := repos[ref.Key]
		if repo == nil {
			continue
		}
		var nodes []string
		for _, n := range repo.Status.Nodes {
			if n.Present {
				nodes = append(nodes, n.Node)
			}
		}
		if len(nodes) == 0 {
			continue
		}
		slices.Sort(nodes)
		terms = append(terms, corev1.PreferredSchedulingTerm{
			Weight: 1,
			Preference: corev1.NodeSelectorTerm{
				MatchExpressions: []corev1.NodeSelectorRequirement{{
					Key:      corev1.LabelHostname,
					Operator: corev1.NodeSelectorOpIn,
					Values:   nodes,
				}},
			},
		})
	}
	if len(terms) == 0 {
		return nil
	}
	return &corev1.Affinity{
		NodeAffinity: &corev1.NodeAffinity{PreferredDuringSchedulingIgnoredDuringExecution: terms},
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

// reconcileStatus computes phase/endpoint/refs from the live Pod and the Repo
// resources it depends on, and writes status. Phase reaches Ready only when the
// Pod reports the Ready condition AND every Repo the spec names is present on
// the Pod's node and fetched since this Sandbox was created (ADR-0051).
func (r *SandboxReconciler) reconcileStatus(ctx context.Context, sandbox *corev1alpha1.Sandbox, pod *corev1.Pod, repos map[string]*corev1alpha1.Repo) error {
	sandbox.Status.Endpoint = fmt.Sprintf("http://%s.%s.svc:%d", sandbox.Name, sandbox.Namespace, portFor(sandbox))
	sandbox.Status.PodRef = &corev1.LocalObjectReference{Name: pod.Name}
	// Identity, not just address: a replacement Pod reuses the name but never the
	// UID, and it comes up with an empty `work` volume. Publishing the UID is what
	// lets the owning Orchestrator notice its workspace was replaced (ADR-0021).
	sandbox.Status.PodUID = pod.UID
	sandbox.Status.ServiceRef = &corev1.LocalObjectReference{Name: sandbox.Name}
	// The node whose caches this Sandbox mounts; the cache agent there reads it.
	sandbox.Status.Node = pod.Spec.NodeName

	cond := metav1.Condition{
		Type:               conditionReady,
		ObservedGeneration: sandbox.Generation,
		Reason:             "PodNotReady",
		Status:             metav1.ConditionFalse,
		Message:            "pod is not yet Ready",
	}
	var fresh *metav1.Condition
	ready := podReady(pod)
	if ready {
		var reason, message string
		ready, reason, message, fresh = reposReadiness(sandbox, pod.Spec.NodeName, repos)
		if ready {
			cond.Reason = "PodReady"
			cond.Status = metav1.ConditionTrue
			cond.Message = "pod reports Ready"
			if len(sandbox.Spec.Repos) > 0 {
				cond.Message = "pod reports Ready and every Repo is present on its node"
			}
		} else {
			cond.Reason = reason
			cond.Message = message
		}
	}

	sandbox.Status.Phase = corev1alpha1.SandboxPending
	if ready {
		sandbox.Status.Phase = corev1alpha1.SandboxReady
	}
	meta.SetStatusCondition(&sandbox.Status.Conditions, cond)
	if fresh != nil {
		fresh.ObservedGeneration = sandbox.Generation
		meta.SetStatusCondition(&sandbox.Status.Conditions, *fresh)
	} else {
		// Freshness is a statement about a Ready Sandbox's caches; before Ready
		// there is nothing to be fresh, and a stale one from an earlier Ready
		// would be a lie.
		meta.RemoveStatusCondition(&sandbox.Status.Conditions, conditionReposFresh)
	}

	return r.Status().Update(ctx, sandbox)
}

// reposReadiness decides whether the Repos a Sandbox names hold it back from
// Ready, and once they do not, whether their caches are fresh (ADR-0051). It
// is pure: the Sandbox, the node its Pod runs on, and the Repo resources by
// key. Per key, in declaration order, the first that is not ready wins:
//
//   - no Repo resource → RepoMissing;
//   - no entry for the node, or not present and no failed attempt since the
//     Sandbox was created → RepoPending (the agent has not cloned it yet);
//   - not present and an attempt since creation failed → RepoCloneFailed with
//     git's words — a cold node that cannot clone fails this provision;
//   - present and fetched since creation → ready and fresh;
//   - present and an attempt since creation failed → ready but stale: the
//     attach proceeds on the objects the cache holds (freshness degrades,
//     absence does not);
//   - present with no attempt since creation → RepoPending (the on-demand
//     fetch has not run).
//
// "Since creation" is `!t.Before(creation)` on second-granular timestamps: a
// fetch that finished in the same second the Sandbox was created counts, which
// is fresh within a second and therefore harmless. The freshness condition is
// returned only when ready and at least one Repo is named.
func reposReadiness(sandbox *corev1alpha1.Sandbox, node string, repos map[string]*corev1alpha1.Repo) (ready bool, reason, message string, fresh *metav1.Condition) {
	creation := sandbox.CreationTimestamp
	since := func(t *metav1.Time) bool { return t != nil && !t.Before(&creation) }
	var stale []string
	for _, ref := range sandbox.Spec.Repos {
		repo := repos[ref.Key]
		if repo == nil {
			return false, reasonRepoMissing, fmt.Sprintf("Repo %q (%s) does not exist in namespace %s", ref.Key, ref.URL, sandbox.Namespace), nil
		}
		entry := nodeEntry(repo, node)
		if entry == nil || !entry.Present {
			if entry != nil && entry.LastError != "" && since(entry.LastAttempt) {
				return false, reasonRepoCloneFailed, fmt.Sprintf("Repo %q could not be cloned onto node %s: %s", ref.Key, node, entry.LastError), nil
			}
			return false, reasonRepoPending, fmt.Sprintf("Repo %q is not on node %s yet", ref.Key, node), nil
		}
		switch {
		case since(entry.LastFetched):
			// Fresh: fetched since this Sandbox asked.
		case since(entry.LastAttempt) && !entry.Synced:
			stale = append(stale, fmt.Sprintf("Repo %q on node %s is stale: %s", ref.Key, node, entry.LastError))
		default:
			return false, reasonRepoPending, fmt.Sprintf("fetching Repo %q on node %s", ref.Key, node), nil
		}
	}
	if len(sandbox.Spec.Repos) == 0 {
		return true, "", "", nil
	}
	fresh = &metav1.Condition{
		Type:    conditionReposFresh,
		Status:  metav1.ConditionTrue,
		Reason:  reasonFetched,
		Message: "every Repo was fetched since this Sandbox was created",
	}
	if len(stale) > 0 {
		fresh.Status = metav1.ConditionFalse
		fresh.Reason = reasonFetchFailed
		fresh.Message = strings.Join(stale, "; ")
	}
	return true, "", "", fresh
}

// nodeEntry is the Repo's status entry for one node, or nil when that node's
// cache agent has not reported.
func nodeEntry(repo *corev1alpha1.Repo, node string) *corev1alpha1.RepoNodeStatus {
	if node == "" {
		return nil
	}
	for i := range repo.Status.Nodes {
		if repo.Status.Nodes[i].Node == node {
			return &repo.Status.Nodes[i]
		}
	}
	return nil
}

// sandboxesNamingRepo maps a Repo event to the Sandboxes in its namespace that
// name its key, so a cache landing on a node (or failing to) re-evaluates
// their Ready without polling.
func (r *SandboxReconciler) sandboxesNamingRepo(ctx context.Context, obj client.Object) []reconcile.Request {
	var list corev1alpha1.SandboxList
	if err := r.List(ctx, &list, client.InNamespace(obj.GetNamespace())); err != nil {
		logf.FromContext(ctx).Error(err, "Could not list Sandboxes for Repo", "repo", obj.GetName())
		return nil
	}
	var requests []reconcile.Request
	for _, sandbox := range list.Items {
		for _, ref := range sandbox.Spec.Repos {
			if ref.Key == obj.GetName() {
				requests = append(requests, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(&sandbox)})
				break
			}
		}
	}
	return requests
}

// SetupWithManager sets up the controller with the Manager.
func (r *SandboxReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.Sandbox{}).
		Owns(&corev1.Pod{}).
		Owns(&corev1.Service{}).
		Watches(&corev1alpha1.Repo{}, handler.EnqueueRequestsFromMapFunc(r.sandboxesNamingRepo)).
		Named("sandbox").
		Complete(r)
}
