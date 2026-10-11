/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package controller

import (
	"reflect"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/utils/ptr"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

// effectorSandbox is a Sandbox whose Orchestrator composed a Sandbox Effector
// that mounts its secrets' projected volume at /run/jr2/secrets.
func effectorSandbox(creds ...string) *corev1alpha1.Sandbox {
	refs := make([]corev1alpha1.SandboxGitCredential, 0, len(creds))
	for _, c := range creds {
		refs = append(refs, corev1alpha1.SandboxGitCredential{Name: c})
	}
	return sandboxFor(corev1alpha1.SandboxSpec{
		Image: testHarnessImage,
		Sidecars: []corev1.Container{
			{Name: "custodian", Image: "envoy"},
			{Name: "effector", Image: "tools", VolumeMounts: []corev1.VolumeMount{
				{Name: "effector-secrets", MountPath: "/run/jr2/secrets", ReadOnly: true},
			}},
		},
		Volumes: []corev1.Volume{{Name: "effector-secrets", VolumeSource: corev1.VolumeSource{
			Projected: &corev1.ProjectedVolumeSource{DefaultMode: ptr.To[int32](0o400), Sources: []corev1.VolumeProjection{
				{Secret: &corev1.SecretProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "jr2-effector-p"},
					Items: []corev1.KeyToPath{{Key: "secret.aws", Path: "aws"}}}},
			}},
		}}},
		GitCredentials: refs,
	})
}

func volumeNamed(pod *corev1.Pod, name string) *corev1.Volume {
	for i := range pod.Spec.Volumes {
		if pod.Spec.Volumes[i].Name == name {
			return &pod.Spec.Volumes[i]
		}
	}
	return nil
}

// TestBuildPodProjectsEachGitCredentialIntoTheEffectorOnly (ADR-0051,
// ADR-0068, B10): each push Secret the CR names becomes a source of the
// Effector's secrets volume at `@git/<name>/<key>`, one item per key jr2
// writes, optional per key, beside the secrets the Orchestrator composed. No
// other container mounts it; the CR's own spec is not changed.
func TestBuildPodProjectsEachGitCredentialIntoTheEffectorOnly(t *testing.T) {
	sb := effectorSandbox("jr2-git-push-aaaa", "jr2-git-push-bbbb")
	before := sb.DeepCopy()
	pod := (&SandboxReconciler{}).buildPod(sb, nil)
	v := volumeNamed(pod, "effector-secrets")
	if v == nil || v.Projected == nil || len(v.Projected.Sources) != 3 {
		t.Fatalf("got %+v", v)
	}
	if v.Projected.Sources[0].Secret.Name != "jr2-effector-p" {
		t.Fatalf("the composed source moved: %+v", v.Projected.Sources[0])
	}
	for i, name := range []string{"jr2-git-push-aaaa", "jr2-git-push-bbbb"} {
		s := v.Projected.Sources[i+1].Secret
		if s == nil || s.Name != name || s.Optional == nil || !*s.Optional {
			t.Fatalf("source %d: %+v", i+1, s)
		}
		var paths []string
		for _, it := range s.Items {
			if it.Path != "@git/"+name+"/"+it.Key {
				t.Errorf("%s: %s at %s", name, it.Key, it.Path)
			}
			paths = append(paths, it.Key)
		}
		if !reflect.DeepEqual(paths, gitCredentialKeys) {
			t.Fatalf("%s: keys %v", name, paths)
		}
	}
	for _, c := range pod.Spec.Containers {
		for _, m := range c.VolumeMounts {
			if m.Name == "effector-secrets" && c.Name != "effector" {
				t.Errorf("%s mounts the Effector's secrets", c.Name)
			}
		}
	}
	if !reflect.DeepEqual(sb, before) {
		t.Fatal("buildPod changed the CR's own spec")
	}
}

// With no projected volume at /run/jr2/secrets in the Effector, the push
// Secrets get a volume of their own there at @git; with no Effector at all,
// nothing is projected anywhere.
func TestBuildPodGivesTheGitCredentialsTheirOwnVolumeOrNone(t *testing.T) {
	sb := effectorSandbox("jr2-git-push-aaaa")
	sb.Spec.Sidecars[1].VolumeMounts = nil
	pod := (&SandboxReconciler{}).buildPod(sb, nil)
	v := volumeNamed(pod, effectorGitVolume)
	if v == nil || v.Projected == nil || len(v.Projected.Sources) != 1 ||
		!strings.HasPrefix(v.Projected.Sources[0].Secret.Items[0].Path, "jr2-git-push-aaaa/") {
		t.Fatalf("got %+v", v)
	}
	var mounted bool
	for _, c := range pod.Spec.Containers {
		for _, m := range c.VolumeMounts {
			if m.Name == effectorGitVolume {
				if c.Name != "effector" || m.MountPath != "/run/jr2/secrets/@git" || !m.ReadOnly {
					t.Fatalf("%s mounts it at %s", c.Name, m.MountPath)
				}
				mounted = true
			}
		}
	}
	if !mounted {
		t.Fatal("the Effector does not mount its push Secrets")
	}

	none := effectorSandbox("jr2-git-push-aaaa")
	none.Spec.Sidecars = none.Spec.Sidecars[:1]
	pod = (&SandboxReconciler{}).buildPod(none, nil)
	if volumeNamed(pod, effectorGitVolume) != nil || len(volumeNamed(pod, "effector-secrets").Projected.Sources) != 1 {
		t.Fatal("a pod with no Effector got a push Secret")
	}
}

// TestEffectorStatus: the Sandbox Effector's restarts and last end are copied
// as the Harness's are (ADR-0068) — the termination message is how an
// Effector that cannot serve says why, with its node.
func TestEffectorStatus(t *testing.T) {
	msg := "landlock: unavailable on node kind-worker (the kernel has no Landlock (ENOSYS))"
	pod := &corev1.Pod{Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{
		{Name: "harness"},
		{Name: "effector", RestartCount: 1, LastTerminationState: corev1.ContainerState{
			Terminated: &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 1, Message: msg},
		}},
	}}}
	got := containerStatus(pod, effectorContainerName)
	want := &corev1alpha1.SandboxHarnessStatus{RestartCount: 1,
		LastTerminated: &corev1alpha1.SandboxTermination{Reason: "Error", ExitCode: 1, Message: msg}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	if containerStatus(&corev1.Pod{Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "harness"}}}},
		effectorContainerName) != nil {
		t.Fatal("a pod with no Effector reported one")
	}
}
