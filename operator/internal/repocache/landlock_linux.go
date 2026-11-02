/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package repocache

import "syscall"

const (
	// sysLandlockCreateRuleset is 444 on amd64 and arm64 alike.
	sysLandlockCreateRuleset     = 444
	landlockCreateRulesetVersion = 1 << 0
)

// rawLandlockProbe asks the kernel for its Landlock ABI: a NULL ruleset, size 0, and the VERSION
// flag. It creates nothing.
func rawLandlockProbe() (int, error) {
	abi, _, errno := syscall.RawSyscall(sysLandlockCreateRuleset, 0, 0, landlockCreateRulesetVersion)
	if errno != 0 {
		return 0, errno
	}
	return int(abi), nil
}
