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
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// Git is the seam between the agent and the git binary: one call, one
// invocation. `dir` is the working directory ("" for none), `env` is appended
// to the process environment — credentials ride here, never in `args`
// (ADR-0051). The string is git's combined output; on failure the error's
// text is git's own words, which the agent writes verbatim into the Repo's
// status for `j2 status` to print.
type Git interface {
	Run(ctx context.Context, dir string, env []string, args ...string) (string, error)
}

// ExecGit is the real seam: it execs `git` from PATH. The context's deadline
// is the call's budget: past it the whole process group is killed — git and
// the ssh or git-remote-https it spawned, which would otherwise keep the
// output pipe open and the call blocked — and the error names the budget.
func ExecGit() Git { return execGit{} }

type execGit struct{}

const (
	// errorTextLimit caps how much of git's output travels into a status field.
	errorTextLimit = 2000
	// waitDelay bounds the wait for the output pipe after a kill, for a
	// grandchild that left the process group.
	waitDelay = 5 * time.Second
)

func (execGit) Run(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = waitDelay
	started := time.Now()
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			text = strings.TrimSpace(fmt.Sprintf("git %s timed out after %s\n%s", args[0], time.Since(started).Round(time.Second), text))
		} else if text == "" {
			text = err.Error()
		}
		if len(text) > errorTextLimit {
			text = text[len(text)-errorTextLimit:]
		}
		return text, errors.New(text)
	}
	return text, nil
}
