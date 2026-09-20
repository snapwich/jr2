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

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
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

// leasedSandbox is a Sandbox created `age` ago with a 30m idleTimeout and the
// given keepalive annotation value ("" = no annotation).
func leasedSandbox(name string, age time.Duration, keepalive string) *corev1alpha1.Sandbox {
	var annotations map[string]string
	if keepalive != "" {
		annotations = map[string]string{keepaliveAnnotation: keepalive}
	}
	return &corev1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:              name,
			Namespace:         nsDefault,
			CreationTimestamp: metav1.NewTime(time.Now().Add(-age)),
			Annotations:       annotations,
		},
		Spec: corev1alpha1.SandboxSpec{
			Image:       "harness:latest",
			IdleTimeout: &metav1.Duration{Duration: 30 * time.Minute},
		},
	}
}

// runIdleGC reconciles once and reports whether the Sandbox survived.
func runIdleGC(t *testing.T, sandbox *corev1alpha1.Sandbox) (survived bool, res reconcile.Result) {
	t.Helper()
	s := newScheme(t)
	c := fake.NewClientBuilder().WithScheme(s).
		WithStatusSubresource(&corev1alpha1.Sandbox{}).
		WithObjects(sandbox).Build()
	r := &SandboxReconciler{Client: c, Scheme: s}
	key := types.NamespacedName{Name: sandbox.Name, Namespace: nsDefault}
	res, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: key})
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	err = c.Get(context.Background(), key, &corev1alpha1.Sandbox{})
	if err == nil {
		// Survivors must have been provisioned.
		if podErr := c.Get(context.Background(), key, &corev1.Pod{}); podErr != nil {
			t.Fatalf("surviving sandbox should have a Pod: %v", podErr)
		}
		return true, res
	}
	if !apierrors.IsNotFound(err) {
		t.Fatalf("get sandbox: %v", err)
	}
	return false, res
}

func TestIdleTimeoutDeletesSandboxWithNoKeepalive(t *testing.T) {
	survived, _ := runIdleGC(t, leasedSandbox("stale", time.Hour, ""))
	if survived {
		t.Fatal("expected sandbox with no keepalive past idleTimeout to be deleted")
	}
}

func TestIdleTimeoutKeepsFreshKeepalive(t *testing.T) {
	// Created an hour ago, but its Orchestrator heartbeated a minute ago.
	fresh := time.Now().Add(-time.Minute).Format(time.RFC3339)
	survived, res := runIdleGC(t, leasedSandbox("parked", time.Hour, fresh))
	if !survived {
		t.Fatal("a heartbeated sandbox must survive idle GC (parking is retention — ADR-0012)")
	}
	if res.RequeueAfter <= 0 {
		t.Fatalf("expected a requeue at the lease deadline, got %v", res.RequeueAfter)
	}
}

func TestIdleTimeoutDeletesLapsedKeepalive(t *testing.T) {
	// Last heartbeat an hour ago: the Orchestrator is gone; reap.
	lapsed := time.Now().Add(-time.Hour).Format(time.RFC3339)
	survived, _ := runIdleGC(t, leasedSandbox("abandoned", 2*time.Hour, lapsed))
	if survived {
		t.Fatal("expected sandbox with a lapsed keepalive to be deleted")
	}
}

func TestIdleTimeoutTreatsGarbageKeepaliveAsAbsent(t *testing.T) {
	survived, _ := runIdleGC(t, leasedSandbox("garbled", time.Hour, "not-a-timestamp"))
	if survived {
		t.Fatal("expected sandbox with an unparseable keepalive and lapsed creation to be deleted")
	}
}

func TestIdleTimeoutKeepsYoungSandbox(t *testing.T) {
	// No keepalive yet, but well within idleTimeout from creation.
	survived, res := runIdleGC(t, leasedSandbox("young", time.Minute, ""))
	if !survived {
		t.Fatal("a young sandbox must get a full idleTimeout from birth")
	}
	if res.RequeueAfter <= 0 {
		t.Fatalf("expected a requeue at the creation-based deadline, got %v", res.RequeueAfter)
	}
}
