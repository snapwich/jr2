package reaper

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func alive(pid int) bool {
	// A zombie still answers kill(0); read its state as well.
	if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
		return false
	}
	_, _, ok := stat("/proc/" + strconv.Itoa(pid) + "/stat")
	return ok
}

// start runs a shell under g that leaves one process behind and prints its pid.
func start(t *testing.T, g *Group, script string) int {
	t.Helper()
	var out bytes.Buffer
	cmd := exec.Command("sh", "-c", script)
	cmd.Stdout = &out
	if err := Run(With(context.Background(), g), cmd); err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(out.String()))
	if err != nil {
		t.Fatalf("no pid: %q", out.String())
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	return pid
}

func waitDead(pid int) bool {
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !alive(pid) {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// B12 rule 1: a descendant that leaves its group with setsid is reparented to the Effector, and
// the settle kills and reaps it before it returns.
func TestASetsidEscapeeIsDeadWhenItsEffectHasSettled(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("no setsid(1) on this host")
	}
	if err := SetSubreaper(); err != nil {
		t.Fatal(err)
	}
	r := New()
	g := r.Group()
	pid := start(t, g, "setsid sh -c 'exec sleep 300' </dev/null >/dev/null 2>&1 & echo $!")
	time.Sleep(50 * time.Millisecond)
	if !alive(pid) {
		t.Fatal("the escapee did not start")
	}
	ppid, _, _ := stat("/proc/" + strconv.Itoa(pid) + "/stat")
	if ppid != r.self {
		t.Fatalf("the escapee's parent is %d, not the subreaper %d", ppid, r.self)
	}
	g.Settle()
	if alive(pid) {
		t.Fatal("the escapee outlived its Effect's settle")
	}
	if s := r.Strays(); len(s) != 0 {
		t.Fatalf("strays remain: %v", s)
	}
}

// A live Effect's processes are its own: another Effect's settle leaves them.
func TestASettleLeavesTheProcessesOfAnotherLiveEffect(t *testing.T) {
	if err := SetSubreaper(); err != nil {
		t.Fatal(err)
	}
	r := New()
	a, b := r.Group(), r.Group()
	pa := start(t, a, "sleep 300 </dev/null >/dev/null 2>&1 & echo $!")
	pb := start(t, b, "sleep 300 </dev/null >/dev/null 2>&1 & echo $!")
	a.Settle()
	if alive(pa) {
		t.Fatal("a's process outlived a's settle")
	}
	if !alive(pb) {
		t.Fatal("a's settle killed b's process, which belongs to a live Effect")
	}
	b.Settle()
	if !waitDead(pb) {
		t.Fatal("b's process outlived b's settle")
	}
}

// A double fork — the middle process ends, the grandchild is reparented — is caught too, and so is
// the child a stray starts after the first scan.
func TestADoubleForkAndAStraysChildAreDeadWhenTheEffectHasSettled(t *testing.T) {
	if err := SetSubreaper(); err != nil {
		t.Fatal(err)
	}
	r := New()
	g := r.Group()
	pid := start(t, g, "(sh -c 'sleep 300 & sleep 300' </dev/null >/dev/null 2>&1 & echo $!) ")
	time.Sleep(50 * time.Millisecond)
	g.Settle()
	if alive(pid) {
		t.Fatal("the reparented process outlived the settle")
	}
	if s := r.Strays(); len(s) != 0 {
		t.Fatalf("strays remain: %v", s)
	}
}
