/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package uploadpack

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// The fetch lock (ADR-0053, ADR-0075). All Worktrees of a clone share
// `refs/remotes/origin/*`, and two fetches that overlap on a moved remote can
// fail with `cannot lock ref`. So one fetch at a time reads the cache in a
// clone, from its ref advertisement until it has written its refs.
//
// The lock is a flock on a file in the common git dir, so each seat of a pod
// shares it. It belongs to the open file, and a small child process keeps that
// file open: `git upload-pack` can end before the fetch writes its refs, so this
// program cannot hold the lock itself. The child watches the fetch process and
// exits when the fetch ends, however it ends. The kernel then frees the lock.
//
// The chain of processes is `git fetch`, `git remote-ext`, this program. The
// remote-ext process ends with the connection, and a fetch that takes a pack
// ends the connection before it writes its refs. So the child watches the parent
// of that process.
//
// A fetch opens one connection in a clone that borrows from the cache: git opens
// a second one only to follow a tag whose objects it did not have when it began,
// and the alternates hold each object that the cache advertises. So a fetch does
// not wait behind itself.
//
// The lock only helps, so it never fails a fetch. A lock file that does not
// open, a fetch that cannot be named, a child that does not start, or a wait
// that outruns lockWait each leave the fetch to run with no lock.
//
// A cut has its own lock (cut.ts) and fetches while it holds it. One rule keeps
// the two locks apart: a fetch waits only for a fetch. A cut can wait for this
// lock, and nothing that holds this lock waits for a cut, so there is no cycle.

const (
	// HoldCommand is the first argument of the child process that holds the
	// lock. Git never passes it: it is not a service.
	HoldCommand = "hold-fetch-lock"
	// fetchLockFile is in the clone's common git dir, beside the cut's lock.
	fetchLockFile = "jr2-fetch.lock"
	// lockWait bounds the wait in line. A fetch that never ends must not stop
	// the fetches behind it: after this wait, a fetch runs with no lock and the
	// worst result is a `cannot lock ref` that a second fetch repairs.
	lockWait = 30 * time.Second
	// lockTry is the time between two tries for the lock. flock cannot time
	// out, and a blocking try cannot be stopped.
	lockTry = 10 * time.Millisecond
	// exitPoll is the fallback for a kernel or a seccomp profile with no
	// pidfd_open. It is short because each fetch in line waits for it.
	exitPoll = 20 * time.Millisecond
)

// process names one process for the life of that process: a pid alone can come
// back as a later process, and the start time cannot.
type process struct {
	pid   int
	ppid  int
	state string
	start string
}

// alive is false for a zombie: a fetch that exited holds no refs open, and its
// parent can take any time to reap it.
func (p process) alive() bool {
	now, err := readProcess(p.pid)
	return err == nil && now.start == p.start && now.state != "Z" && now.state != "X"
}

// readProcess reads /proc/<pid>/stat. The command name is in parentheses and
// can hold spaces and parentheses, so the fields start after the last one.
func readProcess(pid int) (process, error) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return process{}, err
	}
	return parseStat(pid, raw)
}

func parseStat(pid int, raw []byte) (process, error) {
	const stateField, ppidField, startField = 0, 1, 19
	fields := strings.Fields(string(raw[bytes.LastIndexByte(raw, ')')+1:]))
	if len(fields) <= startField {
		return process{}, fmt.Errorf("process %d has a short stat line", pid)
	}
	ppid, err := strconv.Atoi(fields[ppidField])
	if err != nil {
		return process{}, fmt.Errorf("process %d has a bad parent: %w", pid, err)
	}
	return process{pid: pid, ppid: ppid, state: fields[stateField], start: fields[startField]}, nil
}

// argvOf is the command line of a process, or nothing when it cannot be read.
func argvOf(pid int) []string {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
}

func isGit(argv []string) bool {
	if len(argv) == 0 {
		return false
	}
	base := filepath.Base(argv[0])
	return base == gitBinary || strings.HasPrefix(base, gitBinary+"-")
}

func isRemoteExt(argv []string) bool {
	if !isGit(argv) {
		return false
	}
	return filepath.Base(argv[0]) == "git-remote-ext" || (len(argv) > 1 && argv[1] == "remote-ext")
}

// fetchProcess finds the process whose end frees the lock: the git parent of a
// `git remote-ext` parent. Any other chain has no fetch to watch, so it answers
// false: the git processes can die in the ask, and the parent of an orphan is the
// process that adopted it, which can live as long as the pod. A direct run has no
// fetch at all.
func fetchProcess() (process, bool) {
	parent, err := readProcess(os.Getppid())
	if err != nil || !isRemoteExt(argvOf(parent.pid)) || !isGit(argvOf(parent.ppid)) {
		return process{}, false
	}
	fetch, err := readProcess(parent.ppid)
	return fetch, err == nil
}

// lockFetches takes the lock of the clone for the fetch that runs this program
// and leaves it with a child process. This process closes its own descriptor
// here, and the child's copy keeps the lock, so the exec that follows changes
// nothing. A fetch that dies in line gives its child nothing to wait for, so the
// child exits at once and frees the lock.
func lockFetches(o Options, common string) {
	fetch, ok := o.Fetch()
	if !ok {
		return
	}
	lock, err := os.OpenFile(filepath.Join(common, fetchLockFile), os.O_RDWR|os.O_CREATE, 0o666)
	if err != nil {
		return
	}
	defer func() { _ = lock.Close() }()
	if takeLock(lock, o.LockWait) {
		_ = o.Hold(lock, fetch)
	}
}

// takeLock answers true with the lock held, and false with no lock when the
// wait ended or flock failed.
func takeLock(lock *os.File, wait time.Duration) bool {
	deadline := time.Now().Add(wait)
	for {
		err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return true
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR) {
			return false
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(lockTry)
	}
}

// startHolder starts the child process. It is this same binary, because a pod
// gives no shell and no tail, and Go cannot fork with no exec. The child gets
// the open lock file as descriptor 3. It gets /dev/null for stdio, so a reader
// of the fetch's stdout or stderr sees the end when the fetch ends, and `/` as
// its directory, so it pins no Worktree.
func startHolder(lock *os.File, fetch process) error {
	cmd := exec.Command("/proc/self/exe", HoldCommand, strconv.Itoa(fetch.pid), fetch.start)
	cmd.ExtraFiles = []*os.File{lock}
	cmd.Dir = "/"
	cmd.Env = []string{}
	return cmd.Start()
}

// hold is the child process: it returns when the fetch has ended, and the exit
// frees the lock on the descriptor it inherited.
func hold(args []string) int {
	if len(args) != 2 {
		return 1
	}
	pid, err := strconv.Atoi(args[0])
	if err != nil {
		return 1
	}
	awaitExit(process{pid: pid, start: args[1]})
	return 0
}

func pollExit(p process) {
	for p.alive() {
		time.Sleep(exitPoll)
	}
}
