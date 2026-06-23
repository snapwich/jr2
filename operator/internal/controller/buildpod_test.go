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
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/ptr"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

const (
	testAgentName    = "agent"
	testHarnessImage = "h:latest"
)

func sandboxFor(spec corev1alpha1.SandboxSpec) *corev1alpha1.Sandbox {
	return &corev1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sb", Namespace: nsDefault},
		Spec:       spec,
	}
}

// TestBuildPodHardensIsolation verifies the isolation baseline (ADR-0001's north
// star): no API token, pod + every container run non-root with the default
// seccomp profile, no privilege escalation, and all capabilities dropped.
func TestBuildPodHardensIsolation(t *testing.T) {
	r := &SandboxReconciler{}
	pod := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{
		Image:    "harness:latest",
		Port:     8080,
		Sidecars: []corev1.Container{{Name: testAgentName, Image: "agent:latest"}},
	}))

	if got := pod.Spec.AutomountServiceAccountToken; got == nil || *got {
		t.Fatalf("automountServiceAccountToken: want false, got %v", got)
	}
	if sc := pod.Spec.SecurityContext; sc == nil || sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Fatalf("pod securityContext should set runAsNonRoot=true, got %+v", sc)
	} else if sc.SeccompProfile == nil || sc.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Fatalf("pod seccomp should be RuntimeDefault, got %+v", sc.SeccompProfile)
	}

	if len(pod.Spec.Containers) != 2 {
		t.Fatalf("want 2 containers (harness + agent), got %d", len(pod.Spec.Containers))
	}
	for _, c := range pod.Spec.Containers {
		sc := c.SecurityContext
		if sc == nil {
			t.Fatalf("%s: missing securityContext", c.Name)
		}
		if sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
			t.Errorf("%s: runAsNonRoot should be true", c.Name)
		}
		if sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
			t.Errorf("%s: allowPrivilegeEscalation should be false", c.Name)
		}
		if sc.Capabilities == nil || len(sc.Capabilities.Drop) == 0 || sc.Capabilities.Drop[0] != "ALL" {
			t.Errorf("%s: should drop ALL capabilities, got %+v", c.Name, sc.Capabilities)
		}
	}
}

// TestBuildPodReadinessProbe checks the default TCPSocket probe on the serving
// port, and that an explicit spec.readinessProbe is honored verbatim.
func TestBuildPodReadinessProbe(t *testing.T) {
	r := &SandboxReconciler{}

	def := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{Image: testHarnessImage, Port: 9000}))
	probe := def.Spec.Containers[0].ReadinessProbe
	if probe == nil || probe.TCPSocket == nil {
		t.Fatalf("expected a default TCPSocket readiness probe, got %+v", probe)
	}
	if probe.TCPSocket.Port.IntValue() != 9000 {
		t.Fatalf("default probe should target the serving port 9000, got %v", probe.TCPSocket.Port)
	}

	custom := &corev1.Probe{
		ProbeHandler: corev1.ProbeHandler{
			HTTPGet: &corev1.HTTPGetAction{Path: "/healthz", Port: intstr.FromInt32(8080)},
		},
		InitialDelaySeconds: 3,
	}
	honored := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{
		Image:          testHarnessImage,
		Port:           8080,
		ReadinessProbe: custom,
	}))
	got := honored.Spec.Containers[0].ReadinessProbe
	if got == nil || got.HTTPGet == nil || got.HTTPGet.Path != "/healthz" {
		t.Fatalf("expected spec.readinessProbe to be honored, got %+v", got)
	}
}

// TestBuildPodKeepsExplicitSidecarSecurityContext ensures a sidecar that sets
// its own securityContext is not clobbered by the hardening default.
func TestBuildPodKeepsExplicitSidecarSecurityContext(t *testing.T) {
	r := &SandboxReconciler{}
	pod := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{
		Image: testHarnessImage,
		Port:  8080,
		Sidecars: []corev1.Container{{
			Name:            testAgentName,
			Image:           "agent:latest",
			SecurityContext: &corev1.SecurityContext{RunAsUser: ptr.To(int64(1234))},
		}},
	}))
	sc := pod.Spec.Containers[1].SecurityContext
	if sc == nil || sc.RunAsUser == nil || *sc.RunAsUser != 1234 {
		t.Fatalf("explicit sidecar securityContext should be preserved, got %+v", sc)
	}
}
