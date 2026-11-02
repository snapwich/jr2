//go:build !linux

/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package repocache

import "syscall"

// rawLandlockProbe: Landlock is a Linux module, so no other kernel has it.
func rawLandlockProbe() (int, error) { return 0, syscall.ENOSYS }
