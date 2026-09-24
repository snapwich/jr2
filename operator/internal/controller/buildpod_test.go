/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package controller

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/utils/ptr"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
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
// star): no API token, the default seccomp profile pod-wide, and every jr2-owned
// container non-root with no privilege escalation and all capabilities dropped.
//
// runAsNonRoot is asserted PER CONTAINER and never at the pod level (ADR-0005):
// a pod-level assertion binds every container in the pod, including the one seat
// jr2 does not own.
func TestBuildPodHardensIsolation(t *testing.T) {
	r := &SandboxReconciler{}
	pod := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{
		Image:    "harness:latest",
		Port:     8080,
		Sidecars: []corev1.Container{{Name: testAgentName, Image: "agent:latest"}},
	}), nil)

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
	}), nil)

	byName := map[string]corev1.Container{}
	for _, c := range pod.Spec.Containers {
		byName[c.Name] = c
	}
	if sc := byName["user"].SecurityContext; sc != nil {
		t.Fatalf(`the "user" container must carry NO operator-supplied securityContext, got %+v`, sc)
	}
	if sc := byName["adapter"].SecurityContext; sc == nil || sc.RunAsNonRoot == nil || !*sc.RunAsNonRoot {
		t.Fatalf("a jr2-owned sidecar still gets the hardened default, got %+v", sc)
	}
	// The exemption is about hardening only — the seat is still a plain
	// container fragment the operator schedules verbatim.
	if byName["user"].Image != "sshd:latest" {
		t.Fatalf(`the "user" container's image should pass through, got %q`, byName["user"].Image)
	}
}

// TestBuildPodCarriesFSGroupAndInitContainers pins the two passthroughs ADR-0037
// and ADR-0005 need from the CR: the pod's work group, and the ordered init steps
// that publish jr2's runtime and prove the primary image on it. Both are plain
// pod-spec fields the operator forwards without understanding — the operator
// stays agent-agnostic (ADR-0001), so it never invents an fsGroup of its own and
// never edits an init container, not even to harden it.
func TestBuildPodCarriesFSGroupAndInitContainers(t *testing.T) {
	r := &SandboxReconciler{}
	init := []corev1.Container{
		{Name: "runtime", Image: "jr2-harness:h00", Command: []string{"/opt/jr2/bin/init-copy", "/mnt/jr2"}},
		{Name: "preflight", Image: "user-image:c01"},
	}
	pod := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{
		Image:          testHarnessImage,
		Port:           8080,
		FSGroup:        ptr.To(int64(2000)),
		InitContainers: init,
	}), nil)

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
	bare := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{Image: testHarnessImage, Port: 8080}), nil)
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

	def := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{Image: testHarnessImage, Port: 9000}), nil)
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
	}), nil)
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
	}), nil)
	sc := pod.Spec.Containers[0].SecurityContext
	if sc == nil || sc.RunAsUser == nil || *sc.RunAsUser != 1000 {
		t.Fatalf("the spec's own primary securityContext should win verbatim, got %+v", sc)
	}

	// Silence still hardens: the default is what a spec saying nothing gets.
	bare := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{Image: testHarnessImage, Port: 8080}), nil)
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
	}), nil)
	sc := pod.Spec.Containers[1].SecurityContext
	if sc == nil || sc.RunAsUser == nil || *sc.RunAsUser != 1234 {
		t.Fatalf("explicit sidecar securityContext should be preserved, got %+v", sc)
	}
}

// TestBuildPodMountsRepoCaches pins the Sandbox CRD's whole knowledge of git
// (ADR-0051): for every Repo the spec names, one hostPath volume named
// `repo-<key>` at the node's cache directory for this namespace, mounted
// READ-ONLY at `/repos/<key>` in the primary container and nowhere else — a
// sidecar that wants it mounts the name itself. Read-only is load-bearing
// (ADR-0004): nothing in a Sandbox can `gc` the objects its clones borrow. The
// spec's own volumes and mounts stay, untouched and first.
func TestBuildPodMountsRepoCaches(t *testing.T) {
	r := &SandboxReconciler{}
	sandbox := sandboxFor(corev1alpha1.SandboxSpec{
		Image:        testHarnessImage,
		Port:         8080,
		Volumes:      []corev1.Volume{{Name: "work", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}}},
		VolumeMounts: []corev1.VolumeMount{{Name: "work", MountPath: "/work"}},
		Sidecars:     []corev1.Container{{Name: "adapter", Image: "adapter:latest"}},
		Repos: []corev1alpha1.SandboxRepo{
			{Key: "app-0a1b2c3d", URL: "https://github.com/acme/app.git"},
			{Key: "docs-4e5f6a7b", URL: "git@github.com:acme/docs.git"},
		},
	})
	sandbox.Namespace = "jr2-acme"
	pod := r.buildPod(sandbox, nil)

	volumes := map[string]corev1.Volume{}
	for _, v := range pod.Spec.Volumes {
		volumes[v.Name] = v
	}
	if _, ok := volumes["work"]; !ok {
		t.Fatalf("the spec's own volumes must survive, got %+v", pod.Spec.Volumes)
	}
	for _, key := range []string{"app-0a1b2c3d", "docs-4e5f6a7b"} {
		v, ok := volumes["repo-"+key]
		if !ok {
			t.Fatalf("want a volume repo-%s, got %+v", key, pod.Spec.Volumes)
		}
		if v.HostPath == nil || v.HostPath.Path != "/var/lib/jr2/jr2-acme/repos/"+key {
			t.Fatalf("repo-%s should be the node cache hostPath under the namespace, got %+v", key, v.VolumeSource)
		}
		if v.HostPath.Type == nil || *v.HostPath.Type != corev1.HostPathDirectoryOrCreate {
			t.Fatalf("repo-%s hostPath should be DirectoryOrCreate, got %v", key, v.HostPath.Type)
		}
	}

	primary := pod.Spec.Containers[0]
	if primary.VolumeMounts[0].Name != "work" {
		t.Fatalf("the spec's mounts come first, got %+v", primary.VolumeMounts)
	}
	mounts := map[string]corev1.VolumeMount{}
	for _, m := range primary.VolumeMounts {
		mounts[m.Name] = m
	}
	for _, key := range []string{"app-0a1b2c3d", "docs-4e5f6a7b"} {
		m, ok := mounts["repo-"+key]
		if !ok {
			t.Fatalf("the primary container should mount repo-%s, got %+v", key, primary.VolumeMounts)
		}
		if m.MountPath != "/repos/"+key {
			t.Fatalf("repo-%s should mount at /repos/<key>, got %q", key, m.MountPath)
		}
		if !m.ReadOnly {
			t.Fatalf("repo-%s must be mounted read-only — a writable cache is a gc-able cache", key)
		}
	}
	if got := pod.Spec.Containers[1].VolumeMounts; len(got) != 0 {
		t.Fatalf("a sidecar gets no cache mount unless it asks by name, got %+v", got)
	}
}

// TestBuildPodPrefersNodesHoldingTheCaches pins the placement half of ADR-0051:
// a soft affinity — one preferred term of weight 1 per (Repo, node) — toward
// the nodes whose Repo status reports the cache present, read off the Repo
// resources at pod-build time. Soft, never required: a node without the cache
// clones on first need, so node count never bounds placement. A node that
// reports but does not hold the cache is not preferred. Each term matches the
// node by `metadata.name`, the name the agent reports; never by the hostname
// label, which is not that name on every cluster.
func TestBuildPodPrefersNodesHoldingTheCaches(t *testing.T) {
	r := &SandboxReconciler{}
	sandbox := sandboxFor(corev1alpha1.SandboxSpec{
		Image: testHarnessImage,
		Port:  8080,
		Repos: []corev1alpha1.SandboxRepo{
			{Key: "app-0a1b2c3d", URL: "https://github.com/acme/app.git"},
			{Key: "docs-4e5f6a7b", URL: "https://github.com/acme/docs.git"},
		},
	})
	repos := map[string]*corev1alpha1.Repo{
		"app-0a1b2c3d": {Status: corev1alpha1.RepoStatus{Nodes: []corev1alpha1.RepoNodeStatus{
			{Node: "node-b", Present: true, Synced: true},
			{Node: "node-a", Present: true, Synced: false},
			{Node: "node-c", Present: false, Synced: true},
		}}},
		"docs-4e5f6a7b": {Status: corev1alpha1.RepoStatus{Nodes: []corev1alpha1.RepoNodeStatus{
			{Node: "node-c", Present: true, Synced: true},
		}}},
	}
	pod := r.buildPod(sandbox, repos)

	if pod.Spec.Affinity == nil || pod.Spec.Affinity.NodeAffinity == nil {
		t.Fatalf("want a node affinity toward the caches, got %+v", pod.Spec.Affinity)
	}
	na := pod.Spec.Affinity.NodeAffinity
	if na.RequiredDuringSchedulingIgnoredDuringExecution != nil {
		t.Fatalf("the affinity must be soft — a required term would pin Sandboxes to nodes, got %+v", na.RequiredDuringSchedulingIgnoredDuringExecution)
	}
	terms := na.PreferredDuringSchedulingIgnoredDuringExecution
	// Present only, per Repo in declaration order, nodes sorted within a Repo.
	want := []string{"node-a", "node-b", "node-c"}
	if len(terms) != len(want) {
		t.Fatalf("want one preferred term per (Repo, node) holding the cache, got %+v", terms)
	}
	for i, node := range want {
		term := terms[i]
		if term.Weight != 1 {
			t.Errorf("term %d: weight should be 1, got %d", i, term.Weight)
		}
		if len(term.Preference.MatchExpressions) != 0 {
			t.Fatalf("term %d: a node is matched by its name, never by a label, got %+v", i, term.Preference.MatchExpressions)
		}
		fields := term.Preference.MatchFields
		if len(fields) != 1 || fields[0].Key != metav1.ObjectNameField || fields[0].Operator != corev1.NodeSelectorOpIn {
			t.Fatalf("term %d: want metadata.name In [...], got %+v", i, fields)
		}
		if len(fields[0].Values) != 1 || fields[0].Values[0] != node {
			t.Fatalf("term %d: want node %q (a field requirement takes one value), got %v", i, node, fields[0].Values)
		}
	}
}

// TestBuildPodWithoutCachesAddsNothing pins the two absences: a Sandbox naming
// no Repo gets no cache volume and no affinity — a plain pod, as before
// ADR-0051 — and a Repo resource that does not exist yet, or that no node
// holds, gets its volume (the directory the agent will fill) but no
// scheduling preference, because there is nowhere to prefer.
func TestBuildPodWithoutCachesAddsNothing(t *testing.T) {
	r := &SandboxReconciler{}

	plain := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{Image: testHarnessImage, Port: 8080}), nil)
	if plain.Spec.Affinity != nil {
		t.Fatalf("no Repo means no affinity, got %+v", plain.Spec.Affinity)
	}
	if len(plain.Spec.Volumes) != 0 || len(plain.Spec.Containers[0].VolumeMounts) != 0 {
		t.Fatalf("no Repo means no cache volume or mount, got %+v / %+v", plain.Spec.Volumes, plain.Spec.Containers[0].VolumeMounts)
	}

	cold := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{
		Image: testHarnessImage,
		Port:  8080,
		Repos: []corev1alpha1.SandboxRepo{{Key: "app-0a1b2c3d", URL: "https://github.com/acme/app.git"}},
	}), map[string]*corev1alpha1.Repo{
		"app-0a1b2c3d": {Status: corev1alpha1.RepoStatus{Nodes: []corev1alpha1.RepoNodeStatus{{Node: "node-a", Present: false}}}},
	})
	if cold.Spec.Affinity != nil {
		t.Fatalf("a Repo no node holds gives nowhere to prefer, got %+v", cold.Spec.Affinity)
	}
	if len(cold.Spec.Volumes) != 1 || cold.Spec.Volumes[0].Name != "repo-app-0a1b2c3d" {
		t.Fatalf("the cache volume is defined whether or not any node holds it yet, got %+v", cold.Spec.Volumes)
	}

	missing := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{
		Image: testHarnessImage,
		Port:  8080,
		Repos: []corev1alpha1.SandboxRepo{{Key: "app-0a1b2c3d", URL: "https://github.com/acme/app.git"}},
	}), nil)
	if missing.Spec.Affinity != nil {
		t.Fatalf("a Repo resource that does not exist contributes no term, got %+v", missing.Spec.Affinity)
	}
}

// TestBuildPodCarriesPlacementVerbatim: the CR's nodeSelector and tolerations
// are the Pod's, untouched (ADR-0052) — and the operator's own soft Repo
// affinity sits beside them, a preference next to requirements.
func TestBuildPodCarriesPlacementVerbatim(t *testing.T) {
	r := &SandboxReconciler{}
	tolerations := []corev1.Toleration{{Key: "gpu", Operator: corev1.TolerationOpExists, Effect: corev1.TaintEffectNoSchedule}}
	sandbox := sandboxFor(corev1alpha1.SandboxSpec{
		Image:        testHarnessImage,
		Port:         8080,
		NodeSelector: map[string]string{"pool": "agents"},
		Tolerations:  tolerations,
		Repos:        []corev1alpha1.SandboxRepo{{Key: "app-0a1b2c3d", URL: "https://example.test/app.git"}},
	})
	repos := map[string]*corev1alpha1.Repo{
		"app-0a1b2c3d": {Status: corev1alpha1.RepoStatus{Nodes: []corev1alpha1.RepoNodeStatus{{Node: "node-a", Present: true}}}},
	}
	pod := r.buildPod(sandbox, repos)
	if got := pod.Spec.NodeSelector; len(got) != 1 || got["pool"] != "agents" {
		t.Fatalf("nodeSelector = %v, want the CR's verbatim", got)
	}
	if got := pod.Spec.Tolerations; len(got) != 1 || got[0] != tolerations[0] {
		t.Fatalf("tolerations = %v, want the CR's verbatim (no tolerationSeconds added)", got)
	}
	if pod.Spec.Affinity == nil || pod.Spec.Affinity.NodeAffinity == nil {
		t.Fatalf("the Repo affinity is gone — placement must sit beside it, not replace it")
	}

	bare := r.buildPod(sandboxFor(corev1alpha1.SandboxSpec{Image: testHarnessImage, Port: 8080}), nil)
	if bare.Spec.NodeSelector != nil || bare.Spec.Tolerations != nil {
		t.Fatalf("a CR that says nothing places nothing: selector=%v tolerations=%v", bare.Spec.NodeSelector, bare.Spec.Tolerations)
	}
}
