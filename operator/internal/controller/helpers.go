/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package controller

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
	"github.com/snapwich/jr2/operator/internal/repocache"
)

const (
	// reposMount is the in-pod root under which each Repo's cache is mounted
	// read-only, one leaf per key.
	reposMount = "/repos"
)

// sandboxLabels are the pod labels the Sandbox's Service selects on.
func sandboxLabels(sandbox *corev1alpha1.Sandbox) map[string]string {
	return map[string]string{
		"app.kubernetes.io/managed-by": "jr2-operator",
		"sandbox.jr2.dev/name":         sandbox.Name,
	}
}

// portFor returns the configured primary-container port, falling back to the
// default when unset (e.g. when CRD admission defaulting did not run).
func portFor(sandbox *corev1alpha1.Sandbox) int32 {
	if sandbox.Spec.Port != 0 {
		return sandbox.Spec.Port
	}
	return defaultPort
}

func intstrFromInt32(v int32) intstr.IntOrString {
	return intstr.FromInt32(v)
}

// podReady reports whether the Pod has the Ready condition set to True.
func podReady(pod *corev1.Pod) bool {
	if pod == nil {
		return false
	}
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

// podUnscheduled returns the Pod's PodScheduled condition when it is False —
// the scheduler found no node for it (ADR-0052) — and nil otherwise.
func podUnscheduled(pod *corev1.Pod) *corev1.PodCondition {
	if pod == nil {
		return nil
	}
	for i := range pod.Status.Conditions {
		c := &pod.Status.Conditions[i]
		if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse {
			return c
		}
	}
	return nil
}

// repoVolumeName is the pod volume that carries one Repo's node cache
// (ADR-0051). A sidecar that needs the cache mounts this name; the primary
// container gets it mounted by the operator.
func repoVolumeName(key string) string {
	return "repo-" + key
}

// repoHostPath is where the Instance's cache agent keeps the Repo's bare clone
// on every node: the agent's own convention, so the volume path the operator
// writes is the path by which the agent recognizes a pod that mounts the
// cache. The Sandbox mounts one leaf, read-only.
func repoHostPath(namespace, key string) string {
	return repocache.HostPath(namespace, key)
}

// repoMountPath is where a Sandbox's primary container sees one Repo's cache,
// and what the Orchestrator's attach clones `--shared` from (ADR-0004).
func repoMountPath(key string) string {
	return reposMount + "/" + key
}
