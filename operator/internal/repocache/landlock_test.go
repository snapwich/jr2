/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package repocache

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func withProbe(t *testing.T, p func() (int, error)) {
	t.Helper()
	old := probeLandlock
	probeLandlock = p
	t.Cleanup(func() { probeLandlock = old })
}

// A node without Landlock: the agent exits non-zero before it serves, and its termination message
// names Landlock, the node and the probe's reason — what `jr2 up` reads (ADR-0077).
func TestMainExitsWithTheLandlockMessageWhenTheProbeFails(t *testing.T) {
	for _, tc := range []struct {
		name   string
		probe  func() (int, error)
		reason string
	}{
		{"no Landlock", func() (int, error) { return 0, syscall.ENOSYS }, "the kernel has no Landlock (ENOSYS)"},
		{"not enabled", func() (int, error) { return 0, syscall.EOPNOTSUPP }, "not enabled (EOPNOTSUPP"},
		{"ABI 0", func() (int, error) { return 0, nil }, "the kernel answered ABI 0"},
		{"ABI 1", func() (int, error) { return 1, nil }, "the kernel offers Landlock ABI 1, and jr2 needs ABI 3"},
		{"ABI 2", func() (int, error) { return 2, nil }, "the kernel offers Landlock ABI 2, and jr2 needs ABI 3 or later (Linux 6.2)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withProbe(t, tc.probe)
			term := filepath.Join(t.TempDir(), "termination-log")
			code := Main([]string{"--namespace", "jr2-x", "--node", "node-7", "--termination-log", term})
			if code == 0 {
				t.Fatalf("Main answered 0 on a node without Landlock")
			}
			msg, err := os.ReadFile(term)
			if err != nil {
				t.Fatalf("no termination message: %v", err)
			}
			got := string(msg)
			if !strings.HasPrefix(got, LandlockMessagePrefix+"node-7: ") {
				t.Fatalf("message %q does not start with %q", got, LandlockMessagePrefix+"node-7: ")
			}
			if !strings.Contains(got, tc.reason) || !strings.Contains(got, "ADR-0077") {
				t.Fatalf("message %q lacks the reason %q or the ADR", got, tc.reason)
			}
		})
	}
}

// A node with Landlock ABI 3 or later passes the check with its ABI.
func TestCheckLandlockPassesWithAnABI(t *testing.T) {
	for _, want := range []int{3, 4, 6} {
		withProbe(t, func() (int, error) { return want, nil })
		abi, err := checkLandlock("node-1")
		if err != nil || abi != want {
			t.Fatalf("checkLandlock = %d, %v; want %d, nil", abi, err, want)
		}
	}
}

// The real probe, on this host: the dev host and CI offer Landlock (ADR-0077), and a kernel that
// does not answers one of the two errnos the message words.
func TestRawProbeAnswersAnABIOrAKnownErrno(t *testing.T) {
	abi, err := rawLandlockProbe()
	if err == nil {
		if abi < 1 {
			t.Fatalf("probe answered ABI %d with no error", abi)
		}
		return
	}
	if err != syscall.ENOSYS && err != syscall.EOPNOTSUPP {
		t.Fatalf("probe failed with %v, not ENOSYS or EOPNOTSUPP", err)
	}
}
