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
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

// sandboxLabels are the pod labels the Sandbox's Service selects on.
func sandboxLabels(sandbox *corev1alpha1.Sandbox) map[string]string {
	return map[string]string{
		"app.kubernetes.io/managed-by": "j2-operator",
		"sandbox.j2.dev/name":          sandbox.Name,
	}
}

// portFor returns the configured primary-container port, falling back to the
// default when unset (e.g. when CRD admission defaulting did not run).
func portFor(sandbox *corev1alpha1.Sandbox) int32 {
	if sandbox.Spec.Port != 0 {
		return sandbox.Spec.Port
	}
	return defaultPort
}

func intstrFromInt32(v int32) intstr.IntOrString {
	return intstr.FromInt32(v)
}

// podReady reports whether the Pod has the Ready condition set to True.
func podReady(pod *corev1.Pod) bool {
	if pod == nil {
		return false
	}
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}
