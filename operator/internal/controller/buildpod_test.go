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
// star): no API token, the default seccomp profile pod-wide, and every j2-owned
// container non-root with no privilege escalation and all capabilities dropped.
//
// runAsNonRoot is asserted PER CONTAINER and never at the pod level (ADR-0005):
// a pod-level assertion binds every container in the pod, including the one seat
// j2 does not own.
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
	sc := pod.Spec.SecurityContext
	if sc == nil || sc.SeccompProfile == nil || sc.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault {
		t.Fatalf("pod seccomp should be RuntimeDefault, got %+v", sc)
	}
	if sc.RunAsNonRoot != nil {
		t.Fatalf("pod-level runAsNonRoot must be unset — it would bind the User Container too, got %v", *sc.RunAsNonRoot)
	}
	// The credential-visibility boundary, pinned OFF rather than left to omission.
	// The Adapter holds the pod's only token and `local()` tools give the Agent code
	// execution in the harness container (ADR-0013); a shared process namespace would
	// put /proc/<adapter-pid>/environ in the Agent's reach and turn the container
	// split into decoration. Nothing in the CR can ask for it, and nothing here may
	// start setting it as a convenience (exec-into-a-sidecar, a debug shim).
	if pod.Spec.ShareProcessNamespace != nil {
		t.Fatalf("shareProcessNamespace must stay off — it exposes the Adapter's token to the Agent, got %v", *pod.Spec.ShareProcessNamespace)
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

// TestBuildPodExemptsTheUserContainer pins ADR-0005's one carve-out: the sidecar
// named "user" is scheduled exactly as written. No hardened default, so root and
// the default capability set are available to it — a root sshd that binds :22
// and setuids sessions down is the standard managed-access shape, and it must run
// unmodified. Every OTHER sidecar in the same pod still gets the default, so this
// is a name-scoped exemption and not a hole.
func TestBuildPodExemptsTheUserContainer(t *testing.T) {
	r := &SandboxReconciler{}
	pod := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{
		Image: testHarnessImage,
		Port:  8080,
		Sidecars: []corev1.Container{
			{Name: "adapter", Image: "adapter:latest"},
			{Name: "user", Image: "sshd:latest"},
		},
	}))

	byName := map[string]corev1.Container{}
	for _, c := range pod.Spec.Containers {
		byName[c.Name] = c
	}
	if sc := byName["user"].SecurityContext; sc != nil {
		t.Fatalf(`the "user" container must carry NO operator-supplied securityContext, got %+v`, sc)
	}
	if sc := byName["adapter"].SecurityContext; sc == nil || sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Fatalf("a j2-owned sidecar still gets the hardened default, got %+v", sc)
	}
	// The exemption is about hardening only — the seat is still a plain
	// container fragment the operator schedules verbatim.
	if byName["user"].Image != "sshd:latest" {
		t.Fatalf(`the "user" container's image should pass through, got %q`, byName["user"].Image)
	}
}

// TestBuildPodCarriesFSGroupAndInitContainers pins the two passthroughs ADR-0037
// and ADR-0005 need from the CR: the pod's work group, and the ordered init steps
// that publish j2's runtime and prove the primary image on it. Both are plain
// pod-spec fields the operator forwards without understanding — the operator
// stays agent-agnostic (ADR-0001), so it never invents an fsGroup of its own and
// never edits an init container, not even to harden it.
func TestBuildPodCarriesFSGroupAndInitContainers(t *testing.T) {
	r := &SandboxReconciler{}
	init := []corev1.Container{
		{Name: "runtime", Image: "j2-harness:h00", Command: []string{"/opt/j2/bin/init-copy", "/mnt/j2"}},
		{Name: "preflight", Image: "user-image:c01"},
	}
	pod := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{
		Image:          testHarnessImage,
		Port:           8080,
		FSGroup:        ptr.To(int64(2000)),
		InitContainers: init,
	}))

	if fg := pod.Spec.SecurityContext.FSGroup; fg == nil || *fg != 2000 {
		t.Fatalf("pod fsGroup should carry the spec's work group, got %v", fg)
	}
	if len(pod.Spec.InitContainers) != 2 {
		t.Fatalf("want 2 init containers, got %d", len(pod.Spec.InitContainers))
	}
	// Order is the contract: preflight mounts what runtime wrote.
	if pod.Spec.InitContainers[0].Name != "runtime" || pod.Spec.InitContainers[1].Name != "preflight" {
		t.Fatalf("init containers must keep spec order, got %+v", pod.Spec.InitContainers)
	}
	if sc := pod.Spec.InitContainers[1].SecurityContext; sc != nil {
		t.Fatalf("init containers are scheduled verbatim; the operator adds no context, got %+v", sc)
	}

	// Absent fsGroup stays absent: volume ownership is then the images' own.
	bare := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{Image: testHarnessImage, Port: 8080}))
	if bare.Spec.SecurityContext.FSGroup != nil {
		t.Fatalf("fsGroup must not be invented by the operator, got %v", *bare.Spec.SecurityContext.FSGroup)
	}
	if bare.Spec.InitContainers != nil {
		t.Fatalf("no init containers in the spec means none in the pod, got %+v", bare.Spec.InitContainers)
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

// TestBuildPodHonorsPrimarySecurityContext pins the primary container's half of
// the same rule the sidecars follow: a spec that states its own context wins
// verbatim. Only the composer knows whether the primary image declares a USER,
// so only it can supply the uid ADR-0037's fallback needs.
func TestBuildPodHonorsPrimarySecurityContext(t *testing.T) {
	r := &SandboxReconciler{}
	stated := &corev1.SecurityContext{
		RunAsNonRoot:             ptr.To(true),
		RunAsUser:                ptr.To(int64(1000)),
		AllowPrivilegeEscalation: ptr.To(false),
		Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
	}
	pod := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{
		Image:           testHarnessImage,
		Port:            8080,
		SecurityContext: stated,
	}))
	sc := pod.Spec.Containers[0].SecurityContext
	if sc == nil || sc.RunAsUser == nil || *sc.RunAsUser != 1000 {
		t.Fatalf("the spec's own primary securityContext should win verbatim, got %+v", sc)
	}

	// Silence still hardens: the default is what a spec saying nothing gets.
	bare := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{Image: testHarnessImage, Port: 8080}))
	if sc := bare.Spec.Containers[0].SecurityContext; sc == nil || sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Fatalf("an unstated primary context should take the hardened default, got %+v", sc)
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
