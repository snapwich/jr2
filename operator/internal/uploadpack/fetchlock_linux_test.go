/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package uploadpack

import (
	"fmt"
	"os"
	"strings"
	"syscall"
	"testing"
)

// The poll is only the fallback. A wait on a pidfd costs nothing and wakes at the
// exit, so the holder must use it where the kernel gives one.
func TestTheHolderWaitsOnAPidfd(t *testing.T) {
	probe, _, errno := syscall.Syscall(sysPidfdOpen, uintptr(os.Getpid()), 0, 0)
	if errno != 0 {
		t.Skipf("this kernel refuses pidfd_open: %v", errno)
	}
	_ = syscall.Close(int(probe))

	p := layout(t)
	_, holder, _ := startedHolder(t, p, buildProgram(t))
	dir := fmt.Sprintf("/proc/%d/fd/", holder.Process.Pid)
	eventually(t, "the holder must open a pidfd", func() bool {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return false
		}
		for _, entry := range entries {
			if target, err := os.Readlink(dir + entry.Name()); err == nil && strings.Contains(target, "pidfd") {
				return true
			}
		}
		return false
	})
}
