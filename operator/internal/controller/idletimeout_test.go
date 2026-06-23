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
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

const nsDefault = "default"

// newScheme builds a scheme with the core k8s and Sandbox types registered.
func newScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatalf("add clientgo scheme: %v", err)
	}
	if err := corev1alpha1.AddToScheme(s); err != nil {
		t.Fatalf("add sandbox scheme: %v", err)
	}
	return s
}

func orphanSandbox(name string, owners []metav1.OwnerReference) *corev1alpha1.Sandbox {
	return &corev1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:              name,
			Namespace:         nsDefault,
			CreationTimestamp: metav1.NewTime(time.Now().Add(-time.Hour)),
			OwnerReferences:   owners,
		},
		Spec: corev1alpha1.SandboxSpec{
			Image:       "harness:latest",
			IdleTimeout: &metav1.Duration{Duration: 30 * time.Minute},
		},
	}
}

func TestIdleTimeoutDeletesOrphanedSandbox(t *testing.T) {
	s := newScheme(t)
	c := fake.NewClientBuilder().WithScheme(s).
		WithStatusSubresource(&corev1alpha1.Sandbox{}).
		WithObjects(orphanSandbox("orphan", nil)).Build()
	r := &SandboxReconciler{Client: c, Scheme: s}

	key := types.NamespacedName{Name: "orphan", Namespace: nsDefault}
	if _, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: key}); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	if err := c.Get(context.Background(), key, &corev1alpha1.Sandbox{}); !apierrors.IsNotFound(err) {
		t.Fatalf("expected orphaned sandbox to be deleted, got err=%v", err)
	}
}

func TestIdleTimeoutKeepsOwnedSandboxAndProvisions(t *testing.T) {
	s := newScheme(t)
	owners := []metav1.OwnerReference{{APIVersion: "example/v1", Kind: "Workspace", Name: "parent", UID: "abc"}}
	c := fake.NewClientBuilder().WithScheme(s).
		WithStatusSubresource(&corev1alpha1.Sandbox{}).
		WithObjects(orphanSandbox("owned", owners)).Build()
	r := &SandboxReconciler{Client: c, Scheme: s}

	key := types.NamespacedName{Name: "owned", Namespace: nsDefault}
	if _, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: key}); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	if err := c.Get(context.Background(), key, &corev1alpha1.Sandbox{}); err != nil {
		t.Fatalf("owned sandbox should survive idle GC, got err=%v", err)
	}
	if err := c.Get(context.Background(), key, &corev1.Pod{}); err != nil {
		t.Fatalf("expected Pod to be provisioned: %v", err)
	}
	if err := c.Get(context.Background(), key, &corev1.Service{}); err != nil {
		t.Fatalf("expected Service to be provisioned: %v", err)
	}
}
