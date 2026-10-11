// Package reaper keeps every process an Effect starts inside that Effect (ADR-0068, B12 rule 1).
// The Effector is the child subreaper of its container (PR_SET_CHILD_SUBREAPER): a descendant
// whose parent ends is reparented to the Effector, not to the container's init, so it cannot leave
// the Effector's sight — a `setsid` and a double fork included. Every child an Effect starts runs
// in its own session and process group (setsid), registered with that Effect's Group. A
// descendant can then move only to a new group, or to another group of its child's session —
// never into the Effector's own, which it cannot reach from another session. When the Effect settles, its
// groups are killed, then the Effector scans /proc for processes whose parent is the Effector and
// whose process group belongs to no live Effect, kills and reaps them, and repeats until none
// remain. An Effect is settled only after that loop, so no descendant of a settled Effect outlives
// it with the secret its command named.
//
// The scan and every start hold one lock, so a child that has just been forked is registered
// before any scan can see it.
package reaper

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// prSetChildSubreaper is PR_SET_CHILD_SUBREAPER (linux/prctl.h).
const prSetChildSubreaper = 36

// SetSubreaper makes this process the child subreaper of its descendants.
func SetSubreaper() error {
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetChildSubreaper, 1, 0); errno != 0 {
		return errno
	}
	return nil
}

// Reaper is one Effector's registry of live process groups.
type Reaper struct {
	mu   sync.Mutex
	self int
	// own is the Effector's own process group: no child an Effect starts is in it (each starts a
	// session), so a process in it was started by the Effector outside any Effect.
	own int
	// proc is the /proc to scan; a test may point it elsewhere.
	proc   string
	groups map[*Group]bool
}

// New is the reaper of this process.
func New() *Reaper {
	return &Reaper{self: os.Getpid(), own: syscall.Getpgrp(), proc: "/proc", groups: map[*Group]bool{}}
}

// Group is one Effect's process groups.
type Group struct {
	r     *Reaper
	pgids map[int]bool
}

// Group registers a new Effect's group. A nil Reaper gives a Group that registers nothing.
func (r *Reaper) Group() *Group {
	if r == nil {
		return nil
	}
	g := &Group{r: r, pgids: map[int]bool{}}
	r.mu.Lock()
	r.groups[g] = true
	r.mu.Unlock()
	return g
}

type key struct{}

// With carries g to every start under ctx.
func With(ctx context.Context, g *Group) context.Context {
	if g == nil {
		return ctx
	}
	return context.WithValue(ctx, key{}, g)
}

func from(ctx context.Context) *Group {
	g, _ := ctx.Value(key{}).(*Group)
	return g
}

// Start starts cmd in its own session and process group, registered with the Group ctx carries
// (none: it is started, and registered nowhere).
func Start(ctx context.Context, cmd *exec.Cmd) error {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setsid = true
	cmd.SysProcAttr.Setpgid = false
	g := from(ctx)
	if g == nil {
		return cmd.Start()
	}
	g.r.mu.Lock()
	defer g.r.mu.Unlock()
	if err := cmd.Start(); err != nil {
		return err
	}
	g.pgids[cmd.Process.Pid] = true
	return nil
}

// Run starts cmd as Start does and waits for it.
func Run(ctx context.Context, cmd *exec.Cmd) error {
	if err := Start(ctx, cmd); err != nil {
		return err
	}
	return cmd.Wait()
}

// Settle ends the Effect's processes: each of its groups is killed, then every stray — a process
// the Effector is the parent of, in no live Effect's group — is killed and reaped, until none
// remains. Settle returns only then.
func (g *Group) Settle() {
	if g == nil {
		return
	}
	r := g.r
	r.mu.Lock()
	delete(r.groups, g)
	live := r.livePgids()
	for pgid := range g.pgids {
		if !live[pgid] {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}
	r.mu.Unlock()
	r.Sweep()
}

// livePgids is every process group of a live Effect. Called with mu held.
func (r *Reaper) livePgids() map[int]bool {
	live := map[int]bool{}
	for g := range r.groups {
		for pgid := range g.pgids {
			live[pgid] = true
		}
	}
	return live
}

// Sweep kills and reaps every stray until none remains.
func (r *Reaper) Sweep() {
	for {
		r.mu.Lock()
		strays := r.strays(r.livePgids())
		for _, pid := range strays {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
		r.mu.Unlock()
		if len(strays) == 0 {
			return
		}
		for _, pid := range strays {
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

// Strays is every process the Effector is the parent of whose group no live Effect holds.
func (r *Reaper) Strays() []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.strays(r.livePgids())
}

func (r *Reaper) strays(live map[int]bool) []int {
	entries, err := os.ReadDir(r.proc)
	if err != nil {
		return nil
	}
	var out []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		ppid, pgid, ok := stat(filepath.Join(r.proc, e.Name(), "stat"))
		if !ok || ppid != r.self || live[pgid] || pgid == r.own {
			continue
		}
		out = append(out, pid)
	}
	return out
}

// stat reads a process's parent and process group from /proc/<pid>/stat: the fields after the
// command's closing parenthesis are state, ppid, pgrp.
func stat(path string) (ppid, pgid int, ok bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, false
	}
	s := string(raw)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0, 0, false
	}
	fields := strings.Fields(s[i+1:])
	if len(fields) < 3 {
		return 0, 0, false
	}
	ppid, err1 := strconv.Atoi(fields[1])
	pgid, err2 := strconv.Atoi(fields[2])
	return ppid, pgid, err1 == nil && err2 == nil
}
