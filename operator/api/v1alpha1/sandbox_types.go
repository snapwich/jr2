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

package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
)

// SandboxSpec is the desired state of a Sandbox: pure infrastructure.
//
// Per ADR-0001 the CRD is agent-agnostic — it knows nothing about git,
// worktrees, or Agents. Agents are injected one layer up as plain Container
// fragments in Sidecars; the operator schedules them without understanding them.
type SandboxSpec struct {
	// Image is the primary container image (the Harness).
	// +required
	// +kubebuilder:validation:MinLength=1
	Image string `json:"image"`

	// Command overrides the primary container entrypoint.
	// +optional
	Command []string `json:"command,omitempty"`

	// Args overrides the primary container args.
	// +optional
	Args []string `json:"args,omitempty"`

	// Port is the port the primary container serves on; surfaced in
	// status.endpoint.
	// +optional
	// +kubebuilder:default=8080
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	Port int32 `json:"port,omitempty"`

	// SecurityContext overrides the primary container's security context. Unset
	// takes the operator's hardened default (non-root, no privilege escalation,
	// all capabilities dropped) — the same rule sidecars follow: the operator
	// hardens what says nothing about itself and steps aside for what does.
	//
	// It exists because only the composer of a spec can know things the operator
	// cannot: whether the primary image declares a USER at all, and therefore
	// whether a uid must be supplied for it (ADR-0037). Overriding is verbatim,
	// not a merge — a half-applied security context is worse than either.
	// +optional
	SecurityContext *corev1.SecurityContext `json:"securityContext,omitempty"`

	// ReadinessProbe overrides the primary container's readiness probe. When
	// unset the operator injects a TCPSocket probe on Port so phase Ready means
	// "the Harness accepts connections", not merely "the container started".
	// +optional
	ReadinessProbe *corev1.Probe `json:"readinessProbe,omitempty"`

	// Sidecars are generic Kubernetes container fragments scheduled alongside
	// the primary container. Agents live here, but the operator stays agnostic.
	//
	// One name is special, and only as an EXEMPTION: a sidecar named "user" is
	// scheduled exactly as written — no hardened securityContext default. It is
	// the User Container (ADR-0005), the seat whose identity is "what j2 does
	// not own", so hardening it would be an opinion the operator has no standing
	// to hold. Root is allowed there; the credential boundary never depended on
	// that seat being unprivileged, only on the Agent executing nothing in it.
	// +optional
	Sidecars []corev1.Container `json:"sidecars,omitempty"`

	// InitContainers are generic Kubernetes container fragments run to
	// completion, in order, before the primary container and sidecars start.
	// Scheduled verbatim — the operator adds nothing to them, not even the
	// hardened securityContext default it gives sidecars, because an init step
	// is composed by whoever built the spec and it must be able to say exactly
	// what it needs. This is how j2's runtime reaches a Sandbox (ADR-0037): one
	// step populates an /opt/j2 volume, a second proves the primary image on it.
	// +optional
	InitContainers []corev1.Container `json:"initContainers,omitempty"`

	// FSGroup is the pod-level fsGroup: a supplemental group granted to every
	// container process, and the group that owns pod volumes (setgid, so it
	// propagates to everything created under them). It exists so two containers
	// running different uids can both write one shared volume — the work group
	// of ADR-0005. Unset leaves volume ownership to the images' own uids.
	// +optional
	FSGroup *int64 `json:"fsGroup,omitempty"`

	// Volumes are pod-level volumes available to the primary container and any
	// sidecars (mounted via their own volumeMounts).
	// +optional
	Volumes []corev1.Volume `json:"volumes,omitempty"`

	// VolumeMounts mounts Volumes into the primary container.
	// +optional
	VolumeMounts []corev1.VolumeMount `json:"volumeMounts,omitempty"`

	// Resources are the compute resources for the primary container.
	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// Env sets environment variables on the primary container. Use valueFrom
	// for secret/configmap references.
	// +optional
	Env []corev1.EnvVar `json:"env,omitempty"`

	// EnvFrom injects whole Secrets/ConfigMaps as env into the primary
	// container (e.g. an ANTHROPIC_API_KEY secret).
	// +optional
	EnvFrom []corev1.EnvFromSource `json:"envFrom,omitempty"`

	// IdleTimeout garbage-collects the Sandbox after this duration with no
	// owner. Empty disables idle GC. Format: a Go duration string, e.g. "30m".
	// +optional
	IdleTimeout *metav1.Duration `json:"idleTimeout,omitempty"`

	// Repos are the Repos this Sandbox attaches, named by cache key
	// (ADR-0051). For each entry the operator adds a pod volume named
	// `repo-<key>` — the node's cache for that Repo (hostPath
	// `/var/lib/j2/<namespace>/repos/<key>`, `DirectoryOrCreate`) — mounted
	// read-only at `/repos/<key>` in the primary container; a sidecar that
	// needs it mounts the same volume by name. Scheduling prefers nodes whose
	// `Repo` status reports the key present; `Ready` waits for every key to be
	// present on the pod's node and fetched since this Sandbox was created.
	// This is the whole of what the CRD knows about git: clone and worktree
	// stay the Orchestrator's post-Ready step (ADR-0004).
	// +listType=map
	// +listMapKey=key
	// +optional
	Repos []SandboxRepo `json:"repos,omitempty"`
}

// SandboxRepo names one Repo a Sandbox attaches.
type SandboxRepo struct {
	// Key is the Repo resource's name — the cache key derived from its
	// identity — and the leaf of the volume name, the hostPath, and the mount.
	// +required
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	// +kubebuilder:validation:MaxLength=49
	Key string `json:"key"`

	// URL is the Binding's spelling of the repository, carried for the
	// messages a missing or failed Repo produces; the cache agent reads the
	// Repo resource's own spec.url, never this.
	// +required
	// +kubebuilder:validation:MinLength=1
	URL string `json:"url"`
}

// SandboxPhase is a coarse lifecycle summary of a Sandbox.
// +kubebuilder:validation:Enum=Pending;Ready;Terminating
type SandboxPhase string

const (
	// SandboxPending means the Pod/Service exist but the pod is not yet Ready.
	SandboxPending SandboxPhase = "Pending"
	// SandboxReady means the pod reports the Ready condition and every Repo
	// it names was present on its node and fetched since the Sandbox was
	// created when the pod passed that gate (ADR-0051) — a verdict taken once
	// per pod, which the Repo's later state never revokes.
	SandboxReady SandboxPhase = "Ready"
	// SandboxTerminating means the Sandbox is being deleted.
	SandboxTerminating SandboxPhase = "Terminating"
)

// SandboxStatus is the observed state of a Sandbox.
type SandboxStatus struct {
	// Phase is a coarse lifecycle summary: Pending -> Ready -> Terminating.
	// +optional
	Phase SandboxPhase `json:"phase,omitempty"`

	// Endpoint is the in-cluster Service DNS the Orchestrator uses to reach the
	// Harness, e.g. http://<name>.<ns>.svc:8080.
	// +optional
	Endpoint string `json:"endpoint,omitempty"`

	// PodRef references the Pod backing this Sandbox.
	// +optional
	PodRef *corev1.LocalObjectReference `json:"podRef,omitempty"`

	// PodUID is the identity of the Pod backing this Sandbox. Pod names are
	// deterministic, so a name alone cannot distinguish the Pod a client
	// attached to from a replacement scheduled after an eviction or node loss —
	// and a replacement comes up with an empty `work` volume, so every clone,
	// worktree, and unpushed commit is gone. The UID changes exactly when that
	// happens, which is what lets a client detect it (ADR-0021).
	// +optional
	PodUID types.UID `json:"podUID,omitempty"`

	// ServiceRef references the Service fronting this Sandbox.
	// +optional
	ServiceRef *corev1.LocalObjectReference `json:"serviceRef,omitempty"`

	// Node is the node the Pod was scheduled onto, once it was — the node
	// whose Repo caches this Sandbox mounts, and so the key into each named
	// Repo's `status.nodes[]` for whoever reads the Sandbox — a human at
	// `kubectl get`. Nothing in the control plane reads it back:
	// the operator places and gates on the Pod's own `spec.nodeName`, and the
	// cache agent takes demand off the pods on its node, never off a Sandbox
	// (ADR-0051).
	// +optional
	Node string `json:"node,omitempty"`

	// Conditions represent the current state of the Sandbox resource.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Endpoint",type=string,JSONPath=`.status.endpoint`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// Sandbox is the Schema for the sandboxes API
type Sandbox struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Sandbox
	// +required
	Spec SandboxSpec `json:"spec"`

	// status defines the observed state of Sandbox
	// +optional
	Status SandboxStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// SandboxList contains a list of Sandbox
type SandboxList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Sandbox `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &Sandbox{}, &SandboxList{})
		return nil
	})
}
