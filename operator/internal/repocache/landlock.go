/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package repocache

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// jr2 requires Landlock on every Sandbox node (ADR-0077). The cache agent has one pod on each
// Sandbox node, by the same placement as the Sandboxes (ADR-0052), so it is the DETECTOR: it probes
// Landlock when it starts and, without it, exits with a termination message that names Landlock,
// the node and the probe's reason. The kubelet keeps that message in the container's status, the
// pod is NotReady, and `jr2 up` reads the DaemonSet's pods and refuses to converge, naming each
// node. The agent itself confines nothing.
//
// The probe is the confiner's own (`effector/internal/confine`): `landlock_create_ruleset` with
// LANDLOCK_CREATE_RULESET_VERSION. It is written again here, as the operator module does not
// import the effector module. The minimum is the confiner's too: ABI 3 (minLandlockABI), because
// under ABI 1 no confined process can move a file into another folder, and under ABI 2 a confined
// process can truncate a file that it may not write.

// minLandlockABI is the lowest Landlock ABI that jr2 confines with (ADR-0077); the confiner's
// MinABI in effector/internal/confine. The two change together.
const minLandlockABI = 3

// LandlockMessagePrefix starts the termination message of a cache agent on a node without
// Landlock. `jr2 up` matches it (packages/cli/src/landlock.ts); the two change together.
const LandlockMessagePrefix = "no Landlock on node "

// probeLandlock answers the Landlock ABI of this kernel, or the errno of the probe. A test
// replaces it.
var probeLandlock = rawLandlockProbe

// landlockReason is why a probe that failed failed, in words: a kernel built without Landlock
// (ENOSYS), one that has it and did not enable it at boot (EOPNOTSUPP), or one whose ABI is below
// minLandlockABI.
func landlockReason(abi int, err error) string {
	switch {
	case errors.Is(err, syscall.ENOSYS):
		return "the kernel has no Landlock (ENOSYS)"
	case errors.Is(err, syscall.EOPNOTSUPP):
		return "the kernel has Landlock and it is not enabled (EOPNOTSUPP: landlock is not in the lsm= list)"
	case err != nil:
		return err.Error()
	case abi < 1:
		return fmt.Sprintf("the kernel answered ABI %d", abi)
	default:
		return fmt.Sprintf("the kernel offers Landlock ABI %d, and jr2 needs ABI %d or later (Linux 6.2)",
			abi, minLandlockABI)
	}
}

// checkLandlock is the start-up check: nil with the ABI when the node can confine a process, or
// the termination message when it cannot. The message is one line; `jr2 up` prints the node
// from the pod and the reason from this line.
func checkLandlock(node string) (int, error) {
	abi, err := probeLandlock()
	if err == nil && abi >= minLandlockABI {
		return abi, nil
	}
	return 0, fmt.Errorf("%s%s: %s — jr2 needs Landlock on every Sandbox node (ADR-0077)",
		LandlockMessagePrefix, node, landlockReason(abi, err))
}

// writeTerminationMessage puts msg where the kubelet reads a container's termination message
// (`terminationMessagePath`). A write that fails is not fatal: the DaemonSet's
// `FallbackToLogsOnError` policy reads the log line instead.
func writeTerminationMessage(path, msg string) {
	if path == "" {
		return
	}
	_ = os.WriteFile(path, []byte(msg), 0o644)
}
