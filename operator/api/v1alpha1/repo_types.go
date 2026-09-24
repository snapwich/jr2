/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// RepoSpec is the desired state of a Repo: one git repository the Instance's
// cache agent keeps a bare clone of on every node that needs it (ADR-0051).
//
// The resource's name is the Repo's cache key, derived from its identity (host
// plus path) by the Orchestrator that creates it — never chosen by a human. Two
// spellings of one repository land on one resource and therefore one cache per
// node (ADR-0004).
type RepoSpec struct {
	// URL is the Binding's own spelling of the repository — the url the cache
	// agent clones and fetches from. Any scheme git accepts from inside the
	// cluster: https, ssh (scp-style or ssh://), git, or an absolute path.
	// +required
	// +kubebuilder:validation:MinLength=1
	URL string `json:"url"`

	// SecretRef names the Secret carrying the credential the cache agent uses,
	// resolved from the Instance's git.credentials by the Orchestrator that
	// created this resource (ADR-0051). The keys are Flux's, so a Flux or Argo
	// user reuses the Secret they have: `username`/`password` for https;
	// `identity`, `identity.pub`, and optionally `known_hosts` for ssh. Absent
	// means an anonymous clone.
	// +optional
	SecretRef *corev1.LocalObjectReference `json:"secretRef,omitempty"`

	// RefreshInterval is how often the cache agent fetches a cache it holds,
	// beyond the on-demand fetch before every attach. A Go duration string.
	// +optional
	// +kubebuilder:default="5m"
	RefreshInterval *metav1.Duration `json:"refreshInterval,omitempty"`
}

// RepoAttempt is what a node's cache agent last tried against the remote.
// +kubebuilder:validation:Enum=Probe;Clone;Fetch
type RepoAttempt string

const (
	// RepoAttemptProbe is `git ls-remote` for a Repo no pod on the node mounts
	// yet: the sync signal `jr2 status` shows before any run asks, and never a
	// verdict on a Sandbox.
	RepoAttemptProbe RepoAttempt = "Probe"
	// RepoAttemptClone is the bare clone a pod on the node is waiting on.
	RepoAttemptClone RepoAttempt = "Clone"
	// RepoAttemptFetch is a fetch of a cache the node already holds.
	RepoAttemptFetch RepoAttempt = "Fetch"
)

// RepoNodeStatus is one node's report on its cache of the Repo, written only
// by that node's cache agent. The operator reads it to place Sandboxes and to
// gate their Ready; nothing else writes it.
type RepoNodeStatus struct {
	// Node is the node this entry describes.
	// +required
	Node string `json:"node"`

	// Present reports that a clone exists on this node. A half-finished clone
	// is never present: the agent removes it and reports the error instead.
	// +required
	Present bool `json:"present"`

	// Synced reports that the last attempt — a probe, a clone, or a fetch —
	// succeeded.
	// +required
	Synced bool `json:"synced"`

	// Attempted is which of the three the last attempt was. A failed Probe and
	// a failed Clone leave the same absent, unsynced entry otherwise, and only
	// the Clone is a verdict on a Sandbox waiting on the node: a probe fails
	// before any pod asked, and the pod's arrival makes the agent clone
	// (ADR-0051).
	// +required
	Attempted RepoAttempt `json:"attempted"`

	// ObservedGeneration is the spec generation the last attempt used, so a
	// url or credential change is retried without waiting for the interval.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// LastAttempt is when the node last tried anything against the remote.
	// +optional
	LastAttempt *metav1.Time `json:"lastAttempt,omitempty"`

	// LastFetched is when the node last cloned or fetched successfully — the
	// instant a Sandbox's Ready compares against its own creation (ADR-0051).
	// +optional
	LastFetched *metav1.Time `json:"lastFetched,omitempty"`

	// LastError is git's own words for the last failure; empty when Synced.
	// +optional
	LastError string `json:"lastError,omitempty"`
}

// RepoStatus is the observed state of a Repo: per node, what the cache agent
// there reports, and one aggregate condition the operator derives from it.
type RepoStatus struct {
	// Nodes holds one entry per node whose cache agent has reported, keyed by
	// node name. Each agent replaces only its own entry.
	// +listType=map
	// +listMapKey=node
	// +optional
	Nodes []RepoNodeStatus `json:"nodes,omitempty"`

	// Conditions carries `Synced`: True when every reporting node is synced,
	// False with the first node's error when any is not, Unknown while no node
	// has reported. It is what `jr2 status` and `kubectl get repos` read.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:path=repos
// +kubebuilder:printcolumn:name="URL",type=string,JSONPath=`.spec.url`
// +kubebuilder:printcolumn:name="Synced",type=string,JSONPath=`.status.conditions[?(@.type=="Synced")].status`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// Repo is the Schema for the repos API: a git repository the Instance keeps a
// per-node cache of (ADR-0051). The Orchestrator creates one per repository
// its Machines bind (at boot) or a run attaches (at first attach), labels the
// bound ones `jr2.dev/bound: "true"`, and annotates `jr2.dev/identity` and
// `jr2.dev/last-attached`; `jr2 gc` evicts by that label and age.
type Repo struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Repo
	// +required
	Spec RepoSpec `json:"spec"`

	// status defines the observed state of Repo
	// +optional
	Status RepoStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// RepoList contains a list of Repo
type RepoList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Repo `json:"items"`
}

func init() {
	SchemeBuilder.Register(func(s *runtime.Scheme) error {
		s.AddKnownTypes(SchemeGroupVersion, &Repo{}, &RepoList{})
		return nil
	})
}
