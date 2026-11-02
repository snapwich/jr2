/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package uploadpack

import (
	"errors"
	"syscall"
)

// sysPidfdOpen is the same on each architecture, and the syscall package does
// not name it.
const sysPidfdOpen = 434

// awaitExit returns when the process has exited. A pidfd wakes this process at
// the exit, with no delay and no cost in the wait. It works on a process that
// is not a child of this one, and a zombie counts as exited. The poll is for a
// kernel or a seccomp profile that refuses pidfd_open.
func awaitExit(p process) {
	pidfd, _, errno := syscall.Syscall(sysPidfdOpen, uintptr(p.pid), 0, 0)
	if errno != 0 {
		pollExit(p)
		return
	}
	defer func() { _ = syscall.Close(int(pidfd)) }()
	// The pid could have come back as a later process before the pidfd opened.
	if !p.alive() {
		return
	}
	if err := awaitReadable(int(pidfd)); err != nil {
		pollExit(p)
	}
}

func awaitReadable(fd int) error {
	epoll, err := syscall.EpollCreate1(syscall.EPOLL_CLOEXEC)
	if err != nil {
		return err
	}
	defer func() { _ = syscall.Close(epoll) }()
	event := syscall.EpollEvent{Events: syscall.EPOLLIN, Fd: int32(fd)}
	if err := syscall.EpollCtl(epoll, syscall.EPOLL_CTL_ADD, fd, &event); err != nil {
		return err
	}
	events := make([]syscall.EpollEvent, 1)
	for {
		n, err := syscall.EpollWait(epoll, events, -1)
		if n > 0 {
			return nil
		}
		if err != nil && !errors.Is(err, syscall.EINTR) {
			return err
		}
	}
}
