package reaper

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// StatusFD is the descriptor on which the keeper writes its child's wait status: the first of
// exec's ExtraFiles.
const StatusFD = 3

// KeepArgs is the argv after the Effector binary that runs path with argv under a keeper:
// `keep -- <path> <argv...>`.
func KeepArgs(path string, argv []string) []string {
	return append([]string{"keep", "--", path}, argv...)
}

// Keep is `effector keep -- <path> <argv...>`: one Effect's own subreaper (ADR-0068 rule 1). A
// credentialed command's program is the author's or the Agent's code, and it can start a daemon
// that leaves its process group. Under the Effector alone, that daemon would be the Effector's
// once its parent ends, in no live Effect's group, and the settle of any other Effect would kill
// it while its own Effect still runs. So the keeper stands between the Effector and the confiner:
// it sets PR_SET_CHILD_SUBREAPER, starts path in its own process group (the one reaper.Start made
// for it), and waits. A descendant that leaves the group is then the keeper's, never the
// Effector's, while the Effect is live.
//
// When the child ends, the keeper kills and reaps every process whose parent it is, until none
// remains, then writes the child's wait status on StatusFD and exits 0. When the keeper itself is
// killed (the Effect's timeout, a stop), what it held is reparented to the Effector, and the
// Effect's settle kills it: its Effect is the one that ends. The keeper runs unconfined, outside
// the child's Landlock domain, which therefore cannot ptrace it.
func Keep(args []string) int {
	// Before anything starts: the status pipe is the keeper's own, never its child's.
	syscall.CloseOnExec(StatusFD)
	status := os.NewFile(StatusFD, "jr2-status")
	if len(args) < 2 || args[0] != "--" {
		_, _ = fmt.Fprintln(os.Stderr, "jr2: the command was not run: usage: effector keep -- <path> <argv...>")
		return 126
	}
	if err := SetSubreaper(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "jr2: the command was not run: no subreaper: %v\n", err)
		return 126
	}
	cmd := &exec.Cmd{Path: args[1], Args: args[2:], Env: os.Environ(),
		Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr}
	if err := cmd.Start(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "jr2: the command was not run: %v\n", err)
		return 127
	}
	_ = cmd.Wait()
	ws, _ := cmd.ProcessState.Sys().(syscall.WaitStatus)
	reapChildren(os.Getpid())
	if status != nil {
		_, _ = fmt.Fprintf(status, "%d\n", uint32(ws))
		_ = status.Close()
	}
	return 0
}

// reapChildren kills and reaps every process whose parent is self, until none remains: a
// grandchild whose parent is killed is self's next, so the loop scans again.
func reapChildren(self int) {
	for {
		kids := childrenOf("/proc", self)
		if len(kids) == 0 {
			return
		}
		for _, pid := range kids {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
		for _, pid := range kids {
			var ws syscall.WaitStatus
			for {
				_, err := syscall.Wait4(pid, &ws, 0, nil)
				if !errors.Is(err, syscall.EINTR) {
					break
				}
			}
		}
	}
}

// childrenOf is every process in proc whose parent is self, an exited one not yet reaped included.
func childrenOf(proc string, self int) []int {
	entries, err := os.ReadDir(proc)
	if err != nil {
		return nil
	}
	var out []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if ppid, _, ok := stat(filepath.Join(proc, e.Name(), "stat")); ok && ppid == self {
			out = append(out, pid)
		}
	}
	return out
}

// KeptStatus reads the wait status a keeper wrote, and says whether it wrote one: a keeper that
// was killed wrote none.
func KeptStatus(r io.Reader) (syscall.WaitStatus, bool) {
	raw, err := io.ReadAll(io.LimitReader(r, 64))
	if err != nil {
		return 0, false
	}
	n, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 32)
	if err != nil {
		return 0, false
	}
	return syscall.WaitStatus(n), true
}
