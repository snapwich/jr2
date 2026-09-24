/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package repocache

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestExecGitKillsAHungCallAtItsBudgetWithItsChildren(t *testing.T) {
	// A git that never returns — here an alias that sleeps, standing in for
	// an ssh with no answer — is killed at the context's deadline together
	// with the child holding its output pipe, and the error names the budget
	// in words `jr2 status` can print.
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := ExecGit().Run(ctx, t.TempDir(), nil, "-c", "alias.hang=!sleep 30", "hang")
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("a call past its budget must fail")
	}
	if !strings.Contains(err.Error(), "git -c timed out after") {
		t.Fatalf("the error must name the timeout, got %q", err)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("the kill must reach the child holding the pipe; the call took %v", elapsed)
	}
}

func TestExecGitReturnsGitsOwnWordsOnFailure(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH")
	}
	_, err := ExecGit().Run(context.Background(), t.TempDir(), nil, "rev-parse", "--verify", "HEAD")
	if err == nil || !strings.Contains(err.Error(), "fatal") {
		t.Fatalf("expected git's own words, got %v", err)
	}
}
