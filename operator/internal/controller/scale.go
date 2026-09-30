/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package controller

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// The operator scales with Sandboxes, not with the cluster (ADR-0001). These
// are kit values, not config: nobody has a reading to tune them by, and the
// API server's own priority and fairness still governs.
const (
	// ManagedByLabel and ManagedByValue mark every object the operator
	// creates, and are the selector its Pod and Service informers take.
	ManagedByLabel = "app.kubernetes.io/managed-by"
	ManagedByValue = "jr2-operator"

	// SandboxWorkers is the Sandbox controller's parallel reconciles.
	SandboxWorkers = 16
	// RepoWorkers is the Repo controller's parallel reconciles.
	RepoWorkers = 4
)

// CacheOptions caches only what the operator labels: the Pod and Service
// informers take the managed-by selector, so memory and watch traffic are
// O(Sandboxes) whatever cluster the operator lands in. Sandboxes and Repos are
// jr2's own kinds and are cached whole. The one read that must not trust the
// cache, the confirmation before a Pod is declared lost (ADR-0021), goes past
// it through the API reader.
func CacheOptions() cache.Options {
	managed := labels.SelectorFromSet(labels.Set{ManagedByLabel: ManagedByValue})
	return cache.Options{
		ByObject: map[client.Object]cache.ByObject{
			&corev1.Pod{}:     {Label: managed},
			&corev1.Service{}: {Label: managed},
		},
	}
}
