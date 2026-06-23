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
// garbage-collects them; an orphaned Sandbox past spec.idleTimeout deletes
// itself.
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

	// Idle GC: an orphaned Sandbox (no owners) past idleTimeout deletes itself.
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

// reconcileIdleTimeout deletes an orphaned Sandbox (one with no owner
// references) once spec.idleTimeout has elapsed since creation. It returns
// deleted=true when it removed the Sandbox (the caller should stop), or a
// non-zero requeueAfter when the Sandbox is orphaned but not yet expired so the
// controller re-checks at the deadline.
func (r *SandboxReconciler) reconcileIdleTimeout(ctx context.Context, sandbox *corev1alpha1.Sandbox) (deleted bool, requeueAfter time.Duration, err error) {
	if sandbox.Spec.IdleTimeout == nil || len(sandbox.OwnerReferences) > 0 {
		return false, 0, nil
	}
	deadline := sandbox.CreationTimestamp.Add(sandbox.Spec.IdleTimeout.Duration)
	if remaining := time.Until(deadline); remaining > 0 {
		return false, remaining, nil
	}
	logf.FromContext(ctx).Info("idle timeout elapsed for orphaned sandbox; deleting", "idleTimeout", sandbox.Spec.IdleTimeout.Duration)
	if err := r.Delete(ctx, sandbox); err != nil {
		return false, 0, client.IgnoreNotFound(err)
	}
	return true, 0, nil
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
		Name:         "harness",
		Image:        sandbox.Spec.Image,
		Command:      sandbox.Spec.Command,
		Args:         sandbox.Spec.Args,
		Resources:    sandbox.Spec.Resources,
		Env:          sandbox.Spec.Env,
		EnvFrom:      sandbox.Spec.EnvFrom,
		VolumeMounts: sandbox.Spec.VolumeMounts,
		Ports: []corev1.ContainerPort{{
			Name:          "http",
			ContainerPort: portFor(sandbox),
			Protocol:      corev1.ProtocolTCP,
		}},
	}
	containers := append([]corev1.Container{primary}, sandbox.Spec.Sidecars...)
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
			Containers:    containers,
			Volumes:       sandbox.Spec.Volumes,
		},
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
