/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package controller

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/util/workqueue"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

const (
	// defaultPort is used when spec.port is unset (CRD defaulting normally
	// fills this, but unit/envtest paths may skip admission defaulting).
	defaultPort = 8080
	// conditionReady mirrors status.phase==Ready as a standard condition.
	conditionReady = "Ready"
	// conditionReposFresh is set when the Repo gate passes and says whether
	// every Repo cache the Sandbox mounts had been fetched since the Sandbox
	// was created (ADR-0051): True with reason Fetched, or False with reason
	// FetchFailed and git's words — a warm cache whose refresh failed lets the
	// attach proceed on what it holds, announced as stale. Freshness degrades;
	// absence does not. It is the gate's verdict for the Pod status.podUID
	// names, taken once and standing for that Pod's life (reposAdmitted).
	conditionReposFresh = "ReposFresh"
	// conditionScheduled restates the Pod's PodScheduled condition with the
	// scheduler's own reason and message (ADR-0063): the Orchestrator never
	// reads a Pod, and a Pending Sandbox has to say why it waits.
	conditionScheduled = "Scheduled"
	// reasonScheduled and reasonSchedulingPending are the Scheduled reasons the
	// operator supplies itself: the scheduler writes no reason on True, and
	// before it has looked at the Pod there is no condition at all.
	reasonScheduled         = "Scheduled"
	reasonSchedulingPending = "SchedulingPending"
	// reasonQuotaExceeded is the Scheduled (and Ready) reason while a
	// ResourceQuota refuses the Pod's create (ADR-0064): the same wait as
	// Unschedulable, in the API server's words, and the create is retried.
	reasonQuotaExceeded = "QuotaExceeded"
	// quotaRetryMax caps the wait between create retries under a quota
	// refusal. Nothing in this controller watches quota, so the retry is the
	// only way a freed quota is noticed; the cap bounds how late.
	quotaRetryMax = 30 * time.Second

	// conditionLost is True once the phase is Lost (ADR-0021), with the reason
	// and the Pod's own words. Absent before: a Sandbox that is not Lost says
	// nothing about loss.
	conditionLost = "Lost"
	// The Lost reasons the operator supplies itself. A terminal Pod's own
	// status.reason (`Evicted`, `Terminated`, `NodeShutdown`, ...) is used
	// when it gives one; these are for when it gives none, and for a Pod that
	// is gone.
	reasonPodDeleted   = "PodDeleted"
	reasonNodeLost     = "NodeLost"
	reasonPodFailed    = "PodFailed"
	reasonPodSucceeded = "PodSucceeded"

	// Ready reasons a Repo cache can hold a Sandbox at, and the two ReposFresh
	// reasons. The Orchestrator's port keys on RepoCloneFailed to fail a
	// provision at once instead of burning its Ready budget (ADR-0051).
	reasonRepoMissing = "RepoMissing"
	reasonRepoPending = "RepoPending"
	// reasonUnschedulable is the scheduler's own reason for a Pod no node
	// admits (ADR-0052), restated when its condition carries none.
	reasonUnschedulable   = "Unschedulable"
	reasonRepoCloneFailed = "RepoCloneFailed"
	reasonFetched         = "Fetched"
	reasonFetchFailed     = "FetchFailed"
	// keepaliveAnnotation carries the owning Orchestrator's heartbeat lease
	// (ADR-0001): an RFC3339 timestamp it PATCHes periodically. Idle GC fires
	// only once spec.idleTimeout has elapsed since max(creation, last keepalive).
	keepaliveAnnotation = "jr2.dev/keepalive"

	// harnessContainerName is the primary container's name: the Harness.
	harnessContainerName = "harness"
	// shmVolumeName is the memory-backed emptyDir mounted at /dev/shm in the
	// Harness container alone, when the CR sizes one (ADR-0060).
	shmVolumeName = "shm"
	shmMountPath  = "/dev/shm"
)

// noDisruption is on every Sandbox pod (ADR-0060): moving the pod loses
// `/work`, so neither the cluster autoscaler nor Karpenter may consolidate it
// away. A drain still ends in `workspace.lost`, and the body's policy decides
// (ADR-0021). No PodDisruptionBudget: `maxUnavailable: 0` would block node
// upgrades without end.
var noDisruption = map[string]string{
	"cluster-autoscaler.kubernetes.io/safe-to-evict": "false",
	"karpenter.sh/do-not-disrupt":                    "true",
}

// SandboxReconciler reconciles a Sandbox object
type SandboxReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	// APIReader reads the API server past the informer cache. A Pod absent
	// from the cache is not yet a lost Pod — the cache can lag the create it
	// follows — and loss is terminal (ADR-0021), so it is confirmed here
	// before it is declared. Nil reads through Client (the tests' client has
	// no cache).
	APIReader client.Reader
}

// +kubebuilder:rbac:groups=core.jr2.dev,resources=sandboxes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.jr2.dev,resources=sandboxes/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.jr2.dev,resources=sandboxes/finalizers,verbs=update
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.jr2.dev,resources=repos,verbs=get;list;watch

// Reconcile drives a Sandbox toward its desired state: a Pod (primary container
// plus any sidecars) and a Service, with status.phase / status.endpoint
// reported back. The Pod and Service are owned by the Sandbox so deleting the CR
// garbage-collects them; a Sandbox whose keepalive lease has lapsed past
// spec.idleTimeout deletes itself (ADR-0001). The Repos the spec names are read
// (never written) to place the Pod near their caches, to hold Ready until every
// one is present on its node and fetched (ADR-0051), and to report per key what
// the node has done about what this Sandbox asked it for (ADR-0053) — the ask
// itself an annotation the Orchestrator marks on the CR and this controller
// copies onto the Pod, where the cache agent reads it.
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

	// Lost is terminal (ADR-0021): no second Pod, no status but what the loss
	// wrote. The idle GC above still reaps the CR once the lease lapses.
	if sandbox.Status.Phase == corev1alpha1.SandboxLost {
		return ctrl.Result{RequeueAfter: requeueAfter}, nil
	}

	if err := r.reconcileService(ctx, &sandbox); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile service: %w", err)
	}

	repos, err := r.reposFor(ctx, &sandbox)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("read repos: %w", err)
	}

	pod, loss, refusal, err := r.reconcilePod(ctx, &sandbox, repos)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile pod: %w", err)
	}
	if loss != nil {
		log.Info("sandbox lost its pod", "reason", loss.reason, "message", loss.message)
		if err := r.markLost(ctx, &sandbox, loss); err != nil {
			return ctrl.Result{}, fmt.Errorf("mark lost: %w", err)
		}
		return ctrl.Result{RequeueAfter: requeueAfter}, nil
	}
	if refusal != "" {
		retry, err := r.reconcileRefused(ctx, &sandbox, refusal)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("reconcile status: %w", err)
		}
		if requeueAfter == 0 || retry < requeueAfter {
			requeueAfter = retry
		}
		return ctrl.Result{RequeueAfter: requeueAfter}, nil
	}

	if err := r.reconcileAsks(ctx, &sandbox, pod); err != nil {
		return ctrl.Result{}, fmt.Errorf("reconcile asks: %w", err)
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

// reconcileAsks copies every ask the Sandbox carries onto its Pod (ADR-0053).
// The mark rides the CR because the Orchestrator writes CRs, and it has to
// reach the Pod because the cache agent reads demand off pods alone: a Sandbox
// holds no finalizer, so its resource is gone while its pod is still
// terminating, and a cache is held by a live bind mount, not by a resource
// (ADR-0051). This is the one thing the operator writes onto a Pod it already
// created — annotations are the part of a Pod the API server lets change, and
// the copy is exactly what "the operator copies it onto the pod as it copies
// everything else the pod needs from the CR" asks for.
//
// Only a value that differs is written: the annotation is a timestamp the
// Orchestrator advances, so an unchanged ask must not cost a PATCH on every
// lease renewal.
func (r *SandboxReconciler) reconcileAsks(ctx context.Context, sandbox *corev1alpha1.Sandbox, pod *corev1.Pod) error {
	changed := map[string]string{}
	for name, value := range sandbox.Annotations {
		if strings.HasPrefix(name, corev1alpha1.AskedAnnotationPrefix) && pod.Annotations[name] != value {
			changed[name] = value
		}
	}
	if len(changed) == 0 {
		return nil
	}
	base := client.MergeFrom(pod.DeepCopy())
	if pod.Annotations == nil {
		pod.Annotations = make(map[string]string, len(changed))
	}
	maps.Copy(pod.Annotations, changed)
	return r.Patch(ctx, pod, base)
}

// repoStatuses is the standing report on the caches this Sandbox mounts
// (ADR-0053): per key, what the Sandbox asked its node for and what that
// node's cache agent has done about it since. It is pure — the Sandbox, the
// node its Pod runs on, and the Repo resources by key — and it is recomputed
// on every reconcile, unlike the Ready gate, which is taken once per Pod life.
//
// Nothing is reported before the Pod has a node: there is no cache to report
// on yet.
func repoStatuses(ctx context.Context, sandbox *corev1alpha1.Sandbox, node string, repos map[string]*corev1alpha1.Repo) []corev1alpha1.SandboxRepoStatus {
	if node == "" || len(sandbox.Spec.Repos) == 0 {
		return nil
	}
	out := make([]corev1alpha1.SandboxRepoStatus, 0, len(sandbox.Spec.Repos))
	for _, ref := range sandbox.Spec.Repos {
		asked := askedFor(ctx, sandbox, ref.Key)
		status := corev1alpha1.SandboxRepoStatus{Key: ref.Key, Asked: asked}
		// A Repo that does not exist, or a node whose agent has not reported,
		// leaves the ask unanswered — never an error. The caller waits, and its
		// own budget decides when waiting is over; a missing Repo is the Ready
		// gate's verdict to give, not this entry's.
		if repo := repos[ref.Key]; repo != nil {
			if entry := nodeEntry(repo, node); entry != nil {
				// `fetched` and `attempted` are the node's own stamps, reported
				// whatever they say: a reader compares them against `asked` in
				// the same entry, and a landing OLDER than the ask is exactly
				// what a degraded answer has to name — "serving the cache as of
				// <fetched>" (ADR-0053). Hiding it would leave the caller with
				// nothing to date its objects by. `error` is the one field
				// scoped to the ask, because git's words about an attempt made
				// before it are not an answer to this one.
				status.Attempted = entry.LastAttempt
				status.Fetched = entry.LastFetched
				if !entry.Synced && entry.LastAttempt != nil && !entry.LastAttempt.Before(&asked) {
					status.Error = entry.LastError
				}
			}
		}
		out = append(out, status)
	}
	return out
}

// askedFor resolves what this Sandbox asked its node for on one key: the later
// of its own creation and the key's ask annotation, because a creation is an
// ask (ADR-0051) and every ask the Orchestrator marks after it is one too. A
// garbage annotation is treated as absent, loudly — the rule the keepalive
// lease follows.
//
// The ask is raised to the next whole second (AskedAt), the granularity every
// stamp that can answer it is kept at, and the cache agent raises its own copy
// the same way — so the two agree on the bar, and the bar is one a fetch that
// began BEFORE the ask can never clear (ADR-0053).
func askedFor(ctx context.Context, sandbox *corev1alpha1.Sandbox, key string) metav1.Time {
	created := sandbox.CreationTimestamp
	raw, ok := sandbox.Annotations[corev1alpha1.AskedAnnotation(key)]
	if !ok {
		return created
	}
	ts, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		logf.FromContext(ctx).Info("unparseable ask annotation; treating as absent", "key", key, "value", raw, "error", err.Error())
		return created
	}
	if asked := metav1.NewTime(corev1alpha1.AskedAt(ts)); asked.After(created.Time) {
		return asked
	}
	return created
}

// reconcilePod ensures the Sandbox's one Pod (ADR-0021). The operator creates
// it once, when the Sandbox has never had one, and otherwise returns it; Pods
// are largely immutable, and changing the spec of a running Sandbox is out of
// scope for this operator. It answers in exactly one of three ways besides an
// error: the Pod; a loss, when the Pod it created is gone or terminal; or a
// refusal, the API server's words when a ResourceQuota refused the create
// (ADR-0064) — a wait, retried, never a failure.
func (r *SandboxReconciler) reconcilePod(ctx context.Context, sandbox *corev1alpha1.Sandbox, repos map[string]*corev1alpha1.Repo) (pod *corev1.Pod, loss *podLoss, refusal string, err error) {
	key := client.ObjectKey{Name: sandbox.Name, Namespace: sandbox.Namespace}
	pod = &corev1.Pod{}
	err = r.Get(ctx, key, pod)
	if err != nil && !apierrors.IsNotFound(err) {
		return nil, nil, "", err
	}
	if err == nil {
		return pod, podLost(sandbox, pod), "", nil
	}

	// Not in the cache. Whether the Sandbox ever had a Pod is decided from the
	// API server, not the cache: the cache can lag both the Pod's create and
	// the status write that recorded it, and a wrong answer either way is
	// terminal — a Sandbox declared Lost for nothing, or a second Pod.
	fresh := &corev1alpha1.Sandbox{}
	if err := r.apiReader().Get(ctx, key, fresh); err != nil {
		return nil, nil, "", err
	}
	if fresh.Status.Phase == corev1alpha1.SandboxLost {
		// Already Lost; the cached copy had not caught up. Restate, not rejudge.
		*sandbox = *fresh
		c := meta.FindStatusCondition(fresh.Status.Conditions, conditionLost)
		if c == nil {
			return nil, &podLoss{reasonPodDeleted, fmt.Sprintf("pod %s is gone", sandbox.Name)}, "", nil
		}
		return nil, &podLoss{c.Reason, c.Message}, "", nil
	}
	if fresh.Status.PodUID != "" {
		live := &corev1.Pod{}
		err := r.apiReader().Get(ctx, key, live)
		if err == nil {
			return live, podLost(fresh, live), "", nil
		}
		if !apierrors.IsNotFound(err) {
			return nil, nil, "", err
		}
		*sandbox = *fresh
		return nil, podLost(fresh, nil), "", nil
	}

	pod = r.buildPod(sandbox, repos)
	if err := controllerutil.SetControllerReference(sandbox, pod, r.Scheme); err != nil {
		return nil, nil, "", err
	}
	if err := r.Create(ctx, pod); err != nil {
		if apierrors.IsAlreadyExists(err) {
			// Lost a race; re-read.
			if err := r.apiReader().Get(ctx, key, pod); err != nil {
				return nil, nil, "", err
			}
			return pod, podLost(sandbox, pod), "", nil
		}
		if message, ok := quotaRefusal(err); ok {
			return nil, nil, message, nil
		}
		return nil, nil, "", err
	}
	// Record the creation at once, on its own: status.podUID is what says,
	// across an operator restart, that this Sandbox already had its Pod. The
	// full status write at the end of the reconcile can conflict and be
	// retried; this one cannot be lost to that retry.
	base := client.MergeFrom(sandbox.DeepCopy())
	sandbox.Status.PodUID = pod.UID
	sandbox.Status.PodRef = &corev1.LocalObjectReference{Name: pod.Name}
	if err := r.Status().Patch(ctx, sandbox, base); err != nil {
		return nil, nil, "", err
	}
	return pod, nil, "", nil
}

// apiReader is the uncached reader loss is confirmed through.
func (r *SandboxReconciler) apiReader() client.Reader {
	if r.APIReader != nil {
		return r.APIReader
	}
	return r.Client
}

// quotaRefusal reports whether a create was refused by a ResourceQuota
// (ADR-0064), and the API server's words when it was: they name the quota,
// what was requested, what is used and what is limited.
func quotaRefusal(err error) (string, bool) {
	if !apierrors.IsForbidden(err) {
		return "", false
	}
	message := err.Error()
	if status, ok := err.(apierrors.APIStatus); ok && status.Status().Message != "" {
		message = status.Status().Message
	}
	if !strings.Contains(message, "exceeded quota") {
		return "", false
	}
	return message, true
}

// podLoss is why a Sandbox's one Pod is gone for good (ADR-0021): the reason
// the Lost condition carries, and its message — the Pod's own words when it
// has any, else a plain sentence.
type podLoss struct {
	reason, message string
}

// podLost decides whether the Sandbox has lost the one Pod the operator
// created for it (ADR-0021). pod is the Pod under the Sandbox's name, or nil
// when there is none. It is pure. A Pod is lost when:
//
//   - it is gone after status.podUID recorded it → PodDeleted;
//   - the Pod under the name is not the one recorded → PodDeleted: the one
//     created is gone, and whatever stands in its place is not this Sandbox's;
//   - it is being deleted → NodeLost when the control plane is deleting it
//     for its node (the taint manager, or pod GC for a node that is gone),
//     otherwise PodDeleted, with the DisruptionTarget condition's words. A Pod
//     on a node that is gone stays Terminating until someone forces it, so
//     waiting for NotFound would wait without end;
//   - it is terminal — Failed after a node-pressure eviction, Succeeded or
//     Failed after a node shutdown → the Pod's own reason and message.
//
// A Pod the Sandbox has never had is not lost: nil means create it.
func podLost(sandbox *corev1alpha1.Sandbox, pod *corev1.Pod) *podLoss {
	recorded := sandbox.Status.PodUID
	if pod == nil {
		if recorded == "" {
			return nil
		}
		return &podLoss{reasonPodDeleted, fmt.Sprintf("pod %s was deleted; its work volume went with it", sandbox.Name)}
	}
	if recorded != "" && pod.UID != recorded {
		return &podLoss{reasonPodDeleted, fmt.Sprintf("pod %s (uid %s) was deleted; its work volume went with it", pod.Name, recorded)}
	}
	if pod.DeletionTimestamp != nil {
		loss := &podLoss{reasonPodDeleted, fmt.Sprintf("pod %s is being deleted; its work volume goes with it", pod.Name)}
		for _, c := range pod.Status.Conditions {
			if c.Type != corev1.DisruptionTarget || c.Status != corev1.ConditionTrue {
				continue
			}
			switch c.Reason {
			case "DeletionByTaintManager", "DeletionByPodGC":
				loss.reason = reasonNodeLost
			}
			if c.Message != "" {
				loss.message = c.Message
			}
		}
		return loss
	}
	switch pod.Status.Phase {
	case corev1.PodFailed, corev1.PodSucceeded:
		loss := &podLoss{reason: pod.Status.Reason, message: pod.Status.Message}
		if loss.reason == "" {
			loss.reason = reasonPodFailed
			if pod.Status.Phase == corev1.PodSucceeded {
				loss.reason = reasonPodSucceeded
			}
		}
		if loss.message == "" {
			loss.message = fmt.Sprintf("pod %s ended (%s); its work volume went with it", pod.Name, pod.Status.Phase)
		}
		return loss
	}
	return nil
}

// markLost moves the Sandbox to its terminal phase (ADR-0021): Lost, with a
// Lost condition True carrying the reason and message, and Ready False with
// the same. Every other status field stays as last published — for a Pod that
// is gone, the last the operator saw. The Pod object, when one is left, is
// left in place: teardown deletes the CR, and owner references reap the rest.
func (r *SandboxReconciler) markLost(ctx context.Context, sandbox *corev1alpha1.Sandbox, loss *podLoss) error {
	observed := sandbox.Status.DeepCopy()
	sandbox.Status.Phase = corev1alpha1.SandboxLost
	meta.SetStatusCondition(&sandbox.Status.Conditions, metav1.Condition{
		Type:               conditionLost,
		Status:             metav1.ConditionTrue,
		ObservedGeneration: sandbox.Generation,
		Reason:             loss.reason,
		Message:            loss.message,
	})
	meta.SetStatusCondition(&sandbox.Status.Conditions, metav1.Condition{
		Type:               conditionReady,
		Status:             metav1.ConditionFalse,
		ObservedGeneration: sandbox.Generation,
		Reason:             loss.reason,
		Message:            loss.message,
	})
	if equality.Semantic.DeepEqual(observed, &sandbox.Status) {
		return nil
	}
	return r.Status().Update(ctx, sandbox)
}

// reconcileRefused publishes a quota refusal (ADR-0064) — Scheduled False and
// Ready False, both QuotaExceeded with the API server's words — and returns
// when to retry the create. There is no Pod, so there are no pod facts. The
// retry doubles with the time already spent refused (the Scheduled
// condition's transition time, which survives an operator restart), from one
// second up to quotaRetryMax.
func (r *SandboxReconciler) reconcileRefused(ctx context.Context, sandbox *corev1alpha1.Sandbox, message string) (time.Duration, error) {
	observed := sandbox.Status.DeepCopy()
	sandbox.Status.Phase = corev1alpha1.SandboxPending
	sandbox.Status.Endpoint = endpointFor(sandbox)
	sandbox.Status.ServiceRef = &corev1.LocalObjectReference{Name: sandbox.Name}
	for _, t := range []string{conditionScheduled, conditionReady} {
		meta.SetStatusCondition(&sandbox.Status.Conditions, metav1.Condition{
			Type:               t,
			Status:             metav1.ConditionFalse,
			ObservedGeneration: sandbox.Generation,
			Reason:             reasonQuotaExceeded,
			Message:            message,
		})
	}
	retry := time.Second
	if c := meta.FindStatusCondition(sandbox.Status.Conditions, conditionScheduled); c != nil {
		retry = min(max(time.Since(c.LastTransitionTime.Time), time.Second), quotaRetryMax)
	}
	if equality.Semantic.DeepEqual(observed, &sandbox.Status) {
		return retry, nil
	}
	return retry, r.Status().Update(ctx, sandbox)
}

// buildPod assembles the Pod: the primary container from the Sandbox's image and
// infra fields, plus the generic sidecar containers verbatim, plus one
// read-only volume per Repo the spec names — the node's cache (ADR-0051),
// which the Pod is steered toward nodes already holding.
func (r *SandboxReconciler) buildPod(sandbox *corev1alpha1.Sandbox, repos map[string]*corev1alpha1.Repo) *corev1.Pod {
	repoVolumes, repoMounts := repoVolumesFor(sandbox)
	shmVolumes, shmMounts := shmVolumeFor(sandbox)
	primary := corev1.Container{
		Name:            harnessContainerName,
		Image:           sandbox.Spec.Image,
		Command:         sandbox.Spec.Command,
		Args:            sandbox.Spec.Args,
		Resources:       sandbox.Spec.Resources,
		Env:             sandbox.Spec.Env,
		EnvFrom:         sandbox.Spec.EnvFrom,
		VolumeMounts:    append(append(append([]corev1.VolumeMount{}, sandbox.Spec.VolumeMounts...), repoMounts...), shmMounts...),
		ReadinessProbe:  readinessProbeFor(sandbox),
		SecurityContext: containerSecurityContextFor(sandbox),
		// A Harness that dies says why in its log, not in a termination-log
		// file it never writes (ADR-0063): the kubelet takes the last log
		// lines as the termination message, and harnessStatus publishes it.
		TerminationMessagePolicy: corev1.TerminationMessageFallbackToLogsOnError,
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
			// Copied, so reconcileAsks' merge into the Pod's own map never
			// writes through to the shared default.
			Annotations: maps.Clone(noDisruption),
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
			Volumes:        append(append(append([]corev1.Volume{}, sandbox.Spec.Volumes...), repoVolumes...), shmVolumes...),
			// The whole Size at pod level (KEP-2837) and the priority class,
			// both verbatim (ADR-0060): every number and name is the
			// Orchestrator's, so this operator reads no config.
			Resources:         sandbox.Spec.PodResources,
			PriorityClassName: sandbox.Spec.PriorityClassName,
			// Soft: a node already holding the caches saves a clone; a node
			// without them clones on first need, the image-pull economics
			// ADR-0051 chose. Never a hard requirement, so node count never
			// bounds placement.
			Affinity: repoAffinityFor(sandbox, repos),
			// Verbatim (ADR-0052): the Instance's word on which nodes are
			// Sandbox nodes, carried by the CR so this operator reads no
			// config. Nothing is merged in — the affinity above is a
			// preference and these are requirements, so they never meet.
			NodeSelector: sandbox.Spec.NodeSelector,
			Tolerations:  sandbox.Spec.Tolerations,
			// Isolation north star: an untrusted Agent must not reach the
			// Kubernetes API. Don't mount the SA token, and run every jr2-owned
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
// preferred term of weight 1 per (key, node) the status holds. The scheduler
// sums the weights of the terms a node matches, so a node holding more of the
// Sandbox's Repos scores higher. A term matches the node by `metadata.name` —
// the name the agent reports (its NODE_NAME, the downward `spec.nodeName`) —
// through a field requirement, which takes exactly one value; the
// `kubernetes.io/hostname` label is not that name on every cluster (a cloud
// provider's or a `--hostname-override` differs), so it is never keyed on. A
// Repo that does not exist, or that no node holds yet, contributes no term; no
// terms means nil affinity.
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
		slices.Sort(nodes)
		for _, node := range nodes {
			terms = append(terms, corev1.PreferredSchedulingTerm{
				Weight: 1,
				Preference: corev1.NodeSelectorTerm{
					MatchFields: []corev1.NodeSelectorRequirement{{
						Key:      metav1.ObjectNameField,
						Operator: corev1.NodeSelectorOpIn,
						Values:   []string{node},
					}},
				},
			})
		}
	}
	if len(terms) == 0 {
		return nil
	}
	return &corev1.Affinity{
		NodeAffinity: &corev1.NodeAffinity{PreferredDuringSchedulingIgnoredDuringExecution: terms},
	}
}

// shmVolumeFor returns the memory-backed emptyDir at /dev/shm and its mount
// in the Harness container, when the CR sizes one (ADR-0060). The Harness
// container alone: shm is charged to the container that writes it, so it sits
// inside the Harness's own limit, and the Custodian never shares it. The
// sizeLimit is what makes a full shm ENOSPC or SIGBUS — a tool error — instead
// of a memory kill; without one the CR gets the runtime's own /dev/shm.
func shmVolumeFor(sandbox *corev1alpha1.Sandbox) ([]corev1.Volume, []corev1.VolumeMount) {
	if sandbox.Spec.ShmSize == nil {
		return nil, nil
	}
	size := sandbox.Spec.ShmSize.DeepCopy()
	return []corev1.Volume{{
			Name: shmVolumeName,
			VolumeSource: corev1.VolumeSource{
				EmptyDir: &corev1.EmptyDirVolumeSource{Medium: corev1.StorageMediumMemory, SizeLimit: &size},
			},
		}}, []corev1.VolumeMount{{
			Name:      shmVolumeName,
			MountPath: shmMountPath,
		}}
}

// readinessProbeFor returns the primary container's readiness probe: the
// Sandbox's override when set, otherwise a GET of the Harness's own `/healthz` on the serving port
// so phase Ready means the Harness accepts connections (not just "started").
func readinessProbeFor(sandbox *corev1alpha1.Sandbox) *corev1.Probe {
	if sandbox.Spec.ReadinessProbe != nil {
		return sandbox.Spec.ReadinessProbe
	}
	return &corev1.Probe{
		// The Harness's own route, not the port (ADR-0063): the pod has one
		// network namespace, so a sidecar that takes the port would answer
		// a socket probe and the pod would go Ready with no Harness in it.
		ProbeHandler: corev1.ProbeHandler{
			HTTPGet: &corev1.HTTPGetAction{Path: "/healthz", Port: intstrFromInt32(portFor(sandbox))},
		},
		// Every second, not the kubelet's 10: the default period adds up to
		// 10s to every provision (the scaling review's R12).
		PeriodSeconds: 1,
	}
}

// podSecurityContextFor is the pod-level context: the default seccomp profile
// for everything in the pod, plus the fsGroup when the spec names one.
//
// runAsNonRoot is deliberately NOT here. A pod-level runAsNonRoot binds every
// container including the ones jr2 does not own, and the User Container
// (ADR-0005) must be able to run root — a root sshd that binds :22 and setuids
// sessions down to its login user is the standard managed-access shape. Non-root
// is asserted per container instead, on the seats jr2 owns, which says the same
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
// exists precisely as the place jr2 injects, probes, and overrides nothing. A
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

// reconcileStatus computes phase/endpoint/refs and the pod facts from the live
// Pod and the Repo resources it depends on, and writes status when it changed —
// only then, because every write is a watch event at the Orchestrator
// (ADR-0063), and a lease renewal that changes nothing must not cost one. Phase reaches Ready only when the
// Pod reports the Ready condition AND every Repo the spec names is present on
// the Pod's node and fetched since this Sandbox was created (ADR-0051). The
// Repo half is a gate on the way to Ready, not a standing check: it is asked
// until it passes for the Pod, and its verdict then stands for that Pod's
// life (reposAdmitted) — which is the Sandbox's life, since it has one Pod
// (ADR-0021).
func (r *SandboxReconciler) reconcileStatus(ctx context.Context, sandbox *corev1alpha1.Sandbox, pod *corev1.Pod, repos map[string]*corev1alpha1.Repo) error {
	// Read before status.podUID is overwritten below: the latch is keyed on the
	// Pod the last status named.
	admitted := reposAdmitted(sandbox, pod)
	observed := sandbox.Status.DeepCopy()
	sandbox.Status.Endpoint = endpointFor(sandbox)
	sandbox.Status.PodRef = &corev1.LocalObjectReference{Name: pod.Name}
	// The Pod this Sandbox has for its life (ADR-0021), recorded when it was
	// created; restated here for a Pod created before the operator recorded it.
	sandbox.Status.PodUID = pod.UID
	sandbox.Status.ServiceRef = &corev1.LocalObjectReference{Name: sandbox.Name}
	// The node whose caches this Sandbox mounts — published for whoever reads
	// the Sandbox, as the key into each Repo's status.nodes[]. The operator
	// itself gates on the Pod's nodeName below, and the cache agent reads
	// demand off the pods on its node, never off this field.
	sandbox.Status.Node = pod.Spec.NodeName
	// Standing, per key, and recomputed every time: what a fetch inside the pod
	// waits on (ADR-0053). Ready below is the gate it always was.
	sandbox.Status.Repos = repoStatuses(ctx, sandbox, pod.Spec.NodeName, repos)
	// The pod facts the Orchestrator reads instead of the Pod (ADR-0063): the
	// Harness container's restarts and last end (a memory kill is named from
	// it, ADR-0061), and the scheduler's words on placement.
	sandbox.Status.Harness = harnessStatus(pod)
	sandbox.Status.Waiting = containerWaiting(pod)
	meta.SetStatusCondition(&sandbox.Status.Conditions, scheduledCondition(pod, sandbox.Generation))

	cond := metav1.Condition{
		Type:               conditionReady,
		ObservedGeneration: sandbox.Generation,
		Reason:             "PodNotReady",
		Status:             metav1.ConditionFalse,
		Message:            "pod is not yet Ready",
	}
	var fresh *metav1.Condition
	ready := podReady(pod)
	// A Pod the scheduler could not place (ADR-0052): the Sandbox node set is
	// empty right now, or the CR's selector and tolerations admit no node. The
	// scheduler's own words name the taint or label, and they are what
	// `jr2 status` and the provisioning run show while the run waits — the set
	// moves, so this is a state the Sandbox waits in, never a verdict.
	if !ready {
		if unscheduled := podUnscheduled(pod); unscheduled != nil {
			cond.Reason = reasonUnschedulable
			if unscheduled.Reason != "" {
				cond.Reason = unscheduled.Reason
			}
			cond.Message = unscheduled.Message
		}
	}
	if ready && !admitted {
		var reason, message string
		ready, reason, message, fresh = reposReadiness(sandbox, pod.Spec.NodeName, repos)
		if !ready {
			cond.Reason = reason
			cond.Message = message
		}
	}
	if ready {
		cond.Reason = "PodReady"
		cond.Status = metav1.ConditionTrue
		cond.Message = "pod reports Ready"
		if len(sandbox.Spec.Repos) > 0 {
			cond.Message = "pod reports Ready and every Repo is present on its node"
		}
	}

	sandbox.Status.Phase = corev1alpha1.SandboxPending
	if ready {
		sandbox.Status.Phase = corev1alpha1.SandboxReady
	}
	meta.SetStatusCondition(&sandbox.Status.Conditions, cond)
	switch {
	case fresh != nil:
		// The gate passed for this Pod: its verdict is recorded, and reposAdmitted
		// reads it back on every later reconcile.
		fresh.ObservedGeneration = sandbox.Generation
		meta.SetStatusCondition(&sandbox.Status.Conditions, *fresh)
	case !admitted:
		// Freshness is a verdict about the caches a Pod passed the gate with;
		// before that there is nothing to be fresh.
		meta.RemoveStatusCondition(&sandbox.Status.Conditions, conditionReposFresh)
	}

	if equality.Semantic.DeepEqual(observed, &sandbox.Status) {
		return nil
	}
	return r.Status().Update(ctx, sandbox)
}

// endpointFor is the in-cluster Service address the Orchestrator reaches the
// Harness at.
func endpointFor(sandbox *corev1alpha1.Sandbox) string {
	return fmt.Sprintf("http://%s.%s.svc:%d", sandbox.Name, sandbox.Namespace, portFor(sandbox))
}

// harnessStatus copies the Harness container's restarts and last end off the
// Pod (ADR-0063), or nil while the kubelet has not reported the container.
func harnessStatus(pod *corev1.Pod) *corev1alpha1.SandboxHarnessStatus {
	for _, c := range pod.Status.ContainerStatuses {
		if c.Name != harnessContainerName {
			continue
		}
		out := &corev1alpha1.SandboxHarnessStatus{RestartCount: c.RestartCount}
		if t := c.LastTerminationState.Terminated; t != nil {
			out.LastTerminated = &corev1alpha1.SandboxTermination{Reason: t.Reason, ExitCode: t.ExitCode, Message: t.Message}
			if !t.FinishedAt.IsZero() {
				out.LastTerminated.FinishedAt = t.FinishedAt.DeepCopy()
			}
		}
		return out
	}
	return nil
}

// containerWaiting copies every waiting container of the Pod, init containers
// first (they run first), in the kubelet's words (ADR-0063). Nil when none
// waits. The operator reads no meaning into the reasons.
func containerWaiting(pod *corev1.Pod) []corev1alpha1.SandboxContainerWaiting {
	var out []corev1alpha1.SandboxContainerWaiting
	for _, group := range [][]corev1.ContainerStatus{pod.Status.InitContainerStatuses, pod.Status.ContainerStatuses} {
		for _, c := range group {
			if w := c.State.Waiting; w != nil {
				out = append(out, corev1alpha1.SandboxContainerWaiting{Container: c.Name, Reason: w.Reason, Message: w.Message})
			}
		}
	}
	return out
}

// scheduledCondition restates the Pod's PodScheduled condition (ADR-0063):
// its status, the scheduler's reason and message. Unknown until the scheduler
// has written one.
func scheduledCondition(pod *corev1.Pod, generation int64) metav1.Condition {
	cond := metav1.Condition{
		Type:               conditionScheduled,
		ObservedGeneration: generation,
		Status:             metav1.ConditionUnknown,
		Reason:             reasonSchedulingPending,
		Message:            "the scheduler has not placed the pod yet",
	}
	for _, c := range pod.Status.Conditions {
		if c.Type != corev1.PodScheduled {
			continue
		}
		cond.Status = metav1.ConditionStatus(c.Status)
		cond.Message = c.Message
		cond.Reason = c.Reason
		if cond.Reason == "" {
			cond.Reason = reasonUnschedulable
			if c.Status == corev1.ConditionTrue {
				cond.Reason = reasonScheduled
			}
		}
	}
	return cond
}

// reposAdmitted reports whether the Repo gate already passed for the Pod
// backing this Sandbox: status names this Pod's identity and carries the
// ReposFresh verdict the gate wrote when it passed. Once it has, the gate is
// not asked again for that Pod. Its mounts were fixed when the Pod was
// created, and the cache agent keeps a cache while a pod on its node mounts
// it (ADR-0051) — so the Repo resource's later state, or its absence once
// `jr2 gc` evicted it, says nothing about this Pod, and re-deriving the verdict
// from it would flip a serving Sandbox to Pending on the next lease renewal.
// A Sandbox naming no Repo writes no verdict and has no gate to pass.
func reposAdmitted(sandbox *corev1alpha1.Sandbox, pod *corev1.Pod) bool {
	return sandbox.Status.PodUID == pod.UID && meta.FindStatusCondition(sandbox.Status.Conditions, conditionReposFresh) != nil
}

// reposReadiness decides whether the Repos a Sandbox names hold it back from
// Ready, and once they do not, whether their caches are fresh (ADR-0051). It
// is pure: the Sandbox, the node its Pod runs on, and the Repo resources by
// key. Per key, in declaration order, the first that is not ready wins:
//
//   - no Repo resource → RepoMissing;
//   - no entry for the node, or not present and no failed clone since the
//     Sandbox was created → RepoPending (the agent has not cloned it yet);
//   - not present and a clone since creation failed → RepoCloneFailed with
//     git's words — a cold node that cannot clone fails this provision. Only
//     a Clone counts: the agent probes a Repo before any pod on the node
//     mounts it, and a probe's failure is `jr2 status`'s signal, not this
//     Sandbox's verdict — the pod's arrival makes the agent clone, and that
//     clone may succeed;
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
			if entry != nil && entry.Attempted == corev1alpha1.RepoAttemptClone && entry.LastError != "" && since(entry.LastAttempt) {
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

// sandboxesNamingRepo maps a Repo to the Sandboxes in its namespace that name
// its key, so a cache landing on a node (or failing to) re-evaluates their
// Ready without polling. A non-nil nodes narrows that to the Sandboxes whose
// status.node it holds, and to those not yet placed: a Sandbox with no node
// builds its Pod's affinity from every node's entry (ADR-0001).
func (r *SandboxReconciler) sandboxesNamingRepo(ctx context.Context, repo client.Object, nodes map[string]bool) []reconcile.Request {
	var list corev1alpha1.SandboxList
	if err := r.List(ctx, &list, client.InNamespace(repo.GetNamespace())); err != nil {
		logf.FromContext(ctx).Error(err, "Could not list Sandboxes for Repo", "repo", repo.GetName())
		return nil
	}
	var requests []reconcile.Request
	for _, sandbox := range list.Items {
		if nodes != nil && sandbox.Status.Node != "" && !nodes[sandbox.Status.Node] {
			continue
		}
		for _, ref := range sandbox.Spec.Repos {
			if ref.Key == repo.GetName() {
				requests = append(requests, reconcile.Request{NamespacedName: client.ObjectKeyFromObject(&sandbox)})
				break
			}
		}
	}
	return requests
}

// changedRepoNodes is the set of nodes whose status.nodes entry a Repo update
// added, removed or changed. A Sandbox reads only its own node's entry of each
// Repo it names (ADR-0051, ADR-0053), so these are the only nodes a status
// write can matter to.
func changedRepoNodes(old, updated *corev1alpha1.Repo) map[string]bool {
	before := make(map[string]*corev1alpha1.RepoNodeStatus, len(old.Status.Nodes))
	for i := range old.Status.Nodes {
		before[old.Status.Nodes[i].Node] = &old.Status.Nodes[i]
	}
	changed := map[string]bool{}
	for i := range updated.Status.Nodes {
		entry := &updated.Status.Nodes[i]
		if prev, ok := before[entry.Node]; !ok || !equality.Semantic.DeepEqual(prev, entry) {
			changed[entry.Node] = true
		}
		delete(before, entry.Node)
	}
	for node := range before {
		changed[node] = true
	}
	return changed
}

// repoEvents is the Repo watch's handler (ADR-0001). A create, a delete and a
// spec change wake every Sandbox naming the Repo; a status write wakes only
// the Sandboxes on the nodes it changed. Mapping every write to every naming
// Sandbox woke each of them on every node's per-fetch write: S×N per
// interval, S² on a burst of asks.
func (r *SandboxReconciler) repoEvents() handler.EventHandler {
	type queue = workqueue.TypedRateLimitingInterface[reconcile.Request]
	enqueue := func(ctx context.Context, q queue, repo client.Object, nodes map[string]bool) {
		for _, req := range r.sandboxesNamingRepo(ctx, repo, nodes) {
			q.Add(req)
		}
	}
	return handler.Funcs{
		CreateFunc: func(ctx context.Context, e event.CreateEvent, q queue) {
			enqueue(ctx, q, e.Object, nil)
		},
		UpdateFunc: func(ctx context.Context, e event.UpdateEvent, q queue) {
			old, okOld := e.ObjectOld.(*corev1alpha1.Repo)
			updated, okNew := e.ObjectNew.(*corev1alpha1.Repo)
			if !okOld || !okNew || old.Generation != updated.Generation {
				enqueue(ctx, q, e.ObjectNew, nil)
				return
			}
			if nodes := changedRepoNodes(old, updated); len(nodes) > 0 {
				enqueue(ctx, q, updated, nodes)
			}
		},
		DeleteFunc: func(ctx context.Context, e event.DeleteEvent, q queue) {
			enqueue(ctx, q, e.Object, nil)
		},
		GenericFunc: func(ctx context.Context, e event.GenericEvent, q queue) {
			enqueue(ctx, q, e.Object, nil)
		},
	}
}

// SetupWithManager sets up the controller with the Manager.
//
// The Sandbox is watched without a predicate, deliberately: an ask is an
// annotation, so a GenerationChangedPredicate here would drop the very event
// this controller exists to carry onto the Pod (ADR-0053). The Repo watch
// takes no predicate for the same reason from the other side — a cache
// landing is a status write, and the standing per-key entry is computed from
// it — and narrows by node in its handler instead (repoEvents).
//
// SandboxWorkers reconcile in parallel (ADR-0001): controller-runtime never
// reconciles one Sandbox twice at once, and a reconcile holds no shared state.
func (r *SandboxReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.Sandbox{}).
		Owns(&corev1.Pod{}).
		Owns(&corev1.Service{}).
		Watches(&corev1alpha1.Repo{}, r.repoEvents()).
		WithOptions(controller.Options{MaxConcurrentReconciles: SandboxWorkers}).
		Named("sandbox").
		Complete(r)
}
