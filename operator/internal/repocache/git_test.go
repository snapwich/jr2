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
	// in words `j2 status` can print.
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
