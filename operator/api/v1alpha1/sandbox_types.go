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

	// ReadinessProbe overrides the primary container's readiness probe. When
	// unset the operator injects a TCPSocket probe on Port so phase Ready means
	// "the Harness accepts connections", not merely "the container started".
	// +optional
	ReadinessProbe *corev1.Probe `json:"readinessProbe,omitempty"`

	// Sidecars are generic Kubernetes container fragments scheduled alongside
	// the primary container. Agents live here, but the operator stays agnostic.
	// +optional
	Sidecars []corev1.Container `json:"sidecars,omitempty"`

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
}

// SandboxPhase is a coarse lifecycle summary of a Sandbox.
// +kubebuilder:validation:Enum=Pending;Ready;Terminating
type SandboxPhase string

const (
	// SandboxPending means the Pod/Service exist but the pod is not yet Ready.
	SandboxPending SandboxPhase = "Pending"
	// SandboxReady means the pod reports the Ready condition.
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
