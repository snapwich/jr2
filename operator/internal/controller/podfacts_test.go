/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package controller

import (
	"errors"
	"reflect"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

// TestHarnessStatus: the Harness container's restarts and last end are the
// kubelet's words, copied (ADR-0063) — the facts the Orchestrator names a
// memory kill by (ADR-0061) without reading a Pod. Other containers say
// nothing about the Harness.
func TestHarnessStatus(t *testing.T) {
	finished := metav1.NewTime(time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC))
	cases := []struct {
		name     string
		statuses []corev1.ContainerStatus
		want     *corev1alpha1.SandboxHarnessStatus
	}{
		{name: "no report yet", want: nil},
		{
			name:     "only another container reported",
			statuses: []corev1.ContainerStatus{{Name: "custodian", RestartCount: 4}},
			want:     nil,
		},
		{
			name:     "running, never restarted",
			statuses: []corev1.ContainerStatus{{Name: "harness"}},
			want:     &corev1alpha1.SandboxHarnessStatus{},
		},
		{
			name: "restarted after a memory kill",
			statuses: []corev1.ContainerStatus{
				{Name: "custodian"},
				{
					Name:         "harness",
					RestartCount: 2,
					LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{
						Reason: "OOMKilled", ExitCode: 137, FinishedAt: finished,
					}},
				},
			},
			want: &corev1alpha1.SandboxHarnessStatus{
				RestartCount:   2,
				LastTerminated: &corev1alpha1.SandboxTermination{Reason: "OOMKilled", ExitCode: 137, FinishedAt: &finished},
			},
		},
		{
			// FallbackToLogsOnError (ADR-0063): the message is the Harness's last
			// log lines, carried verbatim.
			name: "died before Ready, in its own words",
			statuses: []corev1.ContainerStatus{{
				Name:         "harness",
				RestartCount: 3,
				LastTerminationState: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{
					Reason: "Error", ExitCode: 1, Message: "Error: listen EADDRINUSE :8080\n",
				}},
			}},
			want: &corev1alpha1.SandboxHarnessStatus{
				RestartCount:   3,
				LastTerminated: &corev1alpha1.SandboxTermination{Reason: "Error", ExitCode: 1, Message: "Error: listen EADDRINUSE :8080\n"},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pod := &corev1.Pod{Status: corev1.PodStatus{ContainerStatuses: tc.statuses}}
			if got := harnessStatus(pod); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("harnessStatus = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// TestContainerWaiting: every container of the Pod that is waiting, init
// containers first, in the kubelet's words (ADR-0063). A container that never
// starts — a root image under runAsNonRoot, a bad image name, a pull that
// keeps failing — leaves no log and no termination; its waiting reason is the
// only evidence, and the Orchestrator never reads a Pod.
func TestContainerWaiting(t *testing.T) {
	root := "container has runAsNonRoot and image will run as root (pod: \"sb_ns\", container: preflight)"
	cases := []struct {
		name string
		init []corev1.ContainerStatus
		main []corev1.ContainerStatus
		want []corev1alpha1.SandboxContainerWaiting
	}{
		{name: "no report yet", want: nil},
		{
			name: "all running",
			main: []corev1.ContainerStatus{{Name: "harness", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}},
			want: nil,
		},
		{
			name: "a root image refused at the preflight",
			init: []corev1.ContainerStatus{{Name: "preflight", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{
				Reason: "CreateContainerConfigError", Message: root,
			}}}},
			main: []corev1.ContainerStatus{{Name: "harness", State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "PodInitializing"}}}},
			want: []corev1alpha1.SandboxContainerWaiting{
				{Container: "preflight", Reason: "CreateContainerConfigError", Message: root},
				{Container: "harness", Reason: "PodInitializing"},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pod := &corev1.Pod{Status: corev1.PodStatus{InitContainerStatuses: tc.init, ContainerStatuses: tc.main}}
			if got := containerWaiting(pod); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("containerWaiting = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// TestScheduledCondition: the Pod's PodScheduled condition, restated on the
// Sandbox with the scheduler's own reason and message (ADR-0063). A Pod the
// scheduler has not yet looked at is Unknown — never a True carried over from
// the Pod this one replaced.
func TestScheduledCondition(t *testing.T) {
	cases := []struct {
		name       string
		conditions []corev1.PodCondition
		status     metav1.ConditionStatus
		reason     string
		message    string
	}{
		{name: "not yet considered", status: metav1.ConditionUnknown, reason: "SchedulingPending"},
		{
			name:       "placed",
			conditions: []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionTrue}},
			status:     metav1.ConditionTrue, reason: "Scheduled",
		},
		{
			name: "no node admits it",
			conditions: []corev1.PodCondition{{
				Type: corev1.PodScheduled, Status: corev1.ConditionFalse,
				Reason: corev1.PodReasonUnschedulable, Message: "0/3 nodes are available: 3 Insufficient memory.",
			}},
			status: metav1.ConditionFalse, reason: "Unschedulable", message: "0/3 nodes are available: 3 Insufficient memory.",
		},
		{
			name:       "false with no reason",
			conditions: []corev1.PodCondition{{Type: corev1.PodScheduled, Status: corev1.ConditionFalse}},
			status:     metav1.ConditionFalse, reason: "Unschedulable",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := scheduledCondition(&corev1.Pod{Status: corev1.PodStatus{Conditions: tc.conditions}}, 3)
			if got.Type != conditionScheduled || got.Status != tc.status || got.Reason != tc.reason || got.ObservedGeneration != 3 {
				t.Fatalf("got %+v, want type %s status %s reason %s gen 3", got, conditionScheduled, tc.status, tc.reason)
			}
			if tc.message != "" && got.Message != tc.message {
				t.Fatalf("message = %q, want the scheduler's %q", got.Message, tc.message)
			}
		})
	}
}

// TestPodLost: a Sandbox has one Pod for its life (ADR-0021). The Pod the
// operator created is lost when it is gone, replaced, being deleted, or
// terminal — with the Pod's own words when it has any. A Pod never created is
// not lost; it is created.
func TestPodLost(t *testing.T) {
	const uid = "uid-1"
	recorded := &corev1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{Name: "sb"},
		Status:     corev1alpha1.SandboxStatus{PodUID: uid},
	}
	now := metav1.Now()
	pod := func(mutate func(*corev1.Pod)) *corev1.Pod {
		p := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "sb", UID: uid}, Status: corev1.PodStatus{Phase: corev1.PodRunning}}
		if mutate != nil {
			mutate(p)
		}
		return p
	}
	cases := []struct {
		name    string
		sandbox *corev1alpha1.Sandbox
		pod     *corev1.Pod
		reason  string // "" = not lost
		message string // checked when set
	}{
		{name: "never created", sandbox: &corev1alpha1.Sandbox{}, pod: nil},
		{name: "running", sandbox: recorded, pod: pod(nil)},
		{name: "pending", sandbox: recorded, pod: pod(func(p *corev1.Pod) { p.Status.Phase = corev1.PodPending })},
		{name: "running, first seen before status recorded it", sandbox: &corev1alpha1.Sandbox{}, pod: pod(nil)},
		{name: "gone", sandbox: recorded, pod: nil, reason: "PodDeleted"},
		{
			name: "another pod under the name", sandbox: recorded,
			pod: pod(func(p *corev1.Pod) { p.UID = "uid-2" }), reason: "PodDeleted",
		},
		{
			name: "evicted for node pressure", sandbox: recorded,
			pod: pod(func(p *corev1.Pod) {
				p.Status.Phase, p.Status.Reason, p.Status.Message = corev1.PodFailed, "Evicted", "The node was low on resource: memory."
			}),
			reason: "Evicted", message: "The node was low on resource: memory.",
		},
		{
			name: "shut down with its node", sandbox: recorded,
			pod: pod(func(p *corev1.Pod) {
				p.Status.Phase, p.Status.Reason, p.Status.Message = corev1.PodSucceeded, "Terminated", "Pod was terminated in response to imminent node shutdown."
			}),
			reason: "Terminated", message: "Pod was terminated in response to imminent node shutdown.",
		},
		{
			name: "failed, no reason", sandbox: recorded,
			pod:    pod(func(p *corev1.Pod) { p.Status.Phase = corev1.PodFailed }),
			reason: "PodFailed",
		},
		{
			name: "succeeded, no reason", sandbox: recorded,
			pod:    pod(func(p *corev1.Pod) { p.Status.Phase = corev1.PodSucceeded }),
			reason: "PodSucceeded",
		},
		{
			name: "drained", sandbox: recorded,
			pod: pod(func(p *corev1.Pod) {
				p.DeletionTimestamp = &now
				p.Status.Conditions = []corev1.PodCondition{{
					Type: corev1.DisruptionTarget, Status: corev1.ConditionTrue,
					Reason: "EvictionByEvictionAPI", Message: "Eviction API: evicting",
				}}
			}),
			reason: "PodDeleted", message: "Eviction API: evicting",
		},
		{
			name: "its node is gone", sandbox: recorded,
			pod: pod(func(p *corev1.Pod) {
				p.DeletionTimestamp = &now
				p.Status.Conditions = []corev1.PodCondition{{
					Type: corev1.DisruptionTarget, Status: corev1.ConditionTrue,
					Reason: "DeletionByTaintManager", Message: "Taint manager: deleting due to NoExecute taint",
				}}
			}),
			reason: "NodeLost", message: "Taint manager: deleting due to NoExecute taint",
		},
		{
			name: "deleted, no disruption condition", sandbox: recorded,
			pod:    pod(func(p *corev1.Pod) { p.DeletionTimestamp = &now }),
			reason: "PodDeleted",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := podLost(tc.sandbox, tc.pod)
			if tc.reason == "" {
				if got != nil {
					t.Fatalf("podLost = %+v, want not lost", got)
				}
				return
			}
			if got == nil || got.reason != tc.reason || got.message == "" {
				t.Fatalf("podLost = %+v, want reason %q and a message", got, tc.reason)
			}
			if tc.message != "" && got.message != tc.message {
				t.Fatalf("message = %q, want the pod's own %q", got.message, tc.message)
			}
		})
	}
}

// TestQuotaRefusal: only a ResourceQuota's refusal is the wait ADR-0064
// names; any other Forbidden stays an error.
func TestQuotaRefusal(t *testing.T) {
	gr := schema.GroupResource{Resource: "pods"}
	words := `pods "sb" is forbidden: exceeded quota: ceiling, requested: requests.cpu=500m, used: requests.cpu=2, limited: requests.cpu=2`
	if msg, ok := quotaRefusal(apierrors.NewForbidden(gr, "sb", errors.New("exceeded quota: ceiling, requested: requests.cpu=500m, used: requests.cpu=2, limited: requests.cpu=2"))); !ok || msg != words {
		t.Fatalf("quotaRefusal = %q, %v; want the API server's words %q", msg, ok, words)
	}
	if _, ok := quotaRefusal(apierrors.NewForbidden(gr, "sb", errors.New(`violates PodSecurity "restricted:latest"`))); ok {
		t.Fatal("a PodSecurity refusal is not a quota wait")
	}
	if _, ok := quotaRefusal(apierrors.NewInternalError(errors.New("exceeded quota"))); ok {
		t.Fatal("only a Forbidden is a refusal")
	}
}
