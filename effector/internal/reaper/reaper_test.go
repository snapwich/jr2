package reaper

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
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

// A live Effect's processes that stay in its group are its own: another Effect's settle leaves them.
func TestASettleLeavesTheGroupOfAnotherLiveEffect(t *testing.T) {
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

// A double fork — the middle process ends, the grandchild is reparented — is caught too.
func TestADoubleForkIsDeadWhenTheEffectHasSettled(t *testing.T) {
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

// B12 rule 1's "repeat until none remain": a stray that left its group holds a child that left
// its own. The first scan sees only the outer stray (the inner one's parent is the stray, not the
// Effector); the inner one is the Effector's only after the outer is dead, so only a second scan
// finds it.
func TestANestedEscapeeIsDeadWhenTheEffectHasSettled(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("no setsid(1) on this host")
	}
	if err := SetSubreaper(); err != nil {
		t.Fatal(err)
	}
	r := New()
	g := r.Group()
	inner := filepath.Join(t.TempDir(), "inner")
	outer := start(t, g, "setsid sh -c 'setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! > "+inner+
		"; exec sleep 300' </dev/null >/dev/null 2>&1 & echo $!")
	var pin int
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		raw, _ := os.ReadFile(inner)
		if n, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && alive(n) {
			pin = n
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if pin == 0 {
		t.Fatal("the nested escapee did not start")
	}
	t.Cleanup(func() { _ = syscall.Kill(pin, syscall.SIGKILL) })
	if ppid, _, _ := stat("/proc/" + strconv.Itoa(pin) + "/stat"); ppid == r.self {
		t.Fatalf("the nested escapee %d is already the Effector's child: the test proves nothing", pin)
	}
	g.Settle()
	if alive(outer) {
		t.Fatal("the outer escapee outlived the settle")
	}
	if alive(pin) {
		t.Fatalf("the nested escapee %d outlived the settle", pin)
	}
}

// The residual ADR-0068 names beside B12 rule 1: membership is the process group, so a
// descendant of a LIVE Effect that leaves its group (an ssh-agent, any daemon) is in no live
// Effect's group once the Effector adopts it, and another Effect's settle kills it. Design B12
// says "belong to no live Effect"; telling this descendant from a settled Effect's needs a
// decision not yet made. This test holds the ADR's sentence true until that decision.
func TestAnotherEffectsSettleKillsALiveEffectsEscapee(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("no setsid(1) on this host")
	}
	if err := SetSubreaper(); err != nil {
		t.Fatal(err)
	}
	r := New()
	a, b := r.Group(), r.Group()
	pb := start(t, b, "setsid sh -c 'exec sleep 300' </dev/null >/dev/null 2>&1 & echo $!")
	time.Sleep(50 * time.Millisecond)
	if !alive(pb) {
		t.Fatal("b's escapee did not start")
	}
	a.Settle()
	if alive(pb) {
		t.Fatal("b's escapee outlived a's settle: the residual ADR-0068 names is gone; rewrite the ADR and this test")
	}
	b.Settle()
}
