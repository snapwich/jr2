/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package controller

import (
	"reflect"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

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
