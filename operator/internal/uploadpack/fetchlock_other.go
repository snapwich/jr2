//go:build !linux

/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package uploadpack

// awaitExit polls: the program runs only in Linux pods, and this file keeps the
// package compiling on a developer's host.
func awaitExit(p process) {
	pollExit(p)
}
