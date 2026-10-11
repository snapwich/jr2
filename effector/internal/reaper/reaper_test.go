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

// The test binary doubles as the keeper (`effector keep`), as the Effector's own binary does in a
// pod.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "keep" {
		// syscall.Exit, not os.Exit: under -coverprofile the test binary's exit hook writes
		// "GOCOVERDIR not set" to stderr, into the output the test reads. The Effector's binary has no such hook.
		syscall.Exit(Keep(os.Args[2:]))
	}
	os.Exit(m.Run())
}

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

// keeper is a command that runs script under its Effect's keeper (Keep), as a credentialed
// command runs, with the keeper's status pipe.
func keeper(t *testing.T, script string) (*exec.Cmd, *os.File) {
	t.Helper()
	report, status, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = report.Close() })
	cmd := exec.Command(os.Args[0], KeepArgs("/bin/sh", []string{"sh", "-c", script})...)
	cmd.ExtraFiles = []*os.File{status}
	return cmd, report
}

// runKept runs a keeper as the Effector does: the status pipe's write end is the keeper's alone once
// it has started.
func runKept(cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.ExtraFiles[0].Close()
	return cmd.Wait()
}

// readPid waits for a pid that a script wrote to file.
func readPid(t *testing.T, file string) int {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		raw, _ := os.ReadFile(file)
		if n, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && alive(n) {
			t.Cleanup(func() { _ = syscall.Kill(n, syscall.SIGKILL) })
			return n
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no pid in %s", file)
	return 0
}

// B12 rule 1, "belong to no live Effect": a descendant of a LIVE Effect that leaves its group (an
// ssh-agent, any daemon) is its keeper's, not the Effector's, so another Effect's settle leaves it.
// Its own Effect's settle ends it.
func TestAnotherEffectsSettleLeavesALiveEffectsEscapee(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("no setsid(1) on this host")
	}
	if err := SetSubreaper(); err != nil {
		t.Fatal(err)
	}
	r := New()
	a, b := r.Group(), r.Group()
	file := filepath.Join(t.TempDir(), "daemon")
	// The subshell ends at once, so the daemon is orphaned while b's top process still runs.
	cmd, _ := keeper(t, "(setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! > "+file+"); exec sleep 300")
	if err := Start(With(context.Background(), b), cmd); err != nil {
		t.Fatal(err)
	}
	_ = cmd.ExtraFiles[0].Close()
	t.Cleanup(func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) })
	go func() { _ = cmd.Wait() }()
	daemon := readPid(t, file)
	deadline := time.Now().Add(2 * time.Second)
	for {
		ppid, _, _ := stat("/proc/" + strconv.Itoa(daemon) + "/stat")
		if ppid == cmd.Process.Pid {
			break
		}
		if ppid == r.self || time.Now().After(deadline) {
			t.Fatalf("the daemon's parent is %d, not b's keeper %d", ppid, cmd.Process.Pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
	start(t, a, "sleep 300 </dev/null >/dev/null 2>&1 & echo $!")
	a.Settle()
	if !alive(daemon) {
		t.Fatal("a's settle killed b's daemon while b is live")
	}
	b.Settle()
	if !waitDead(daemon) {
		t.Fatal("b's daemon outlived b's settle")
	}
	if s := r.Strays(); len(s) != 0 {
		t.Fatalf("strays remain: %v", s)
	}
}

// The keeper ends what its child left when the child ends, before it answers, and answers the
// child's own end: an exit code, or the signal that killed it.
func TestTheKeeperEndsWhatItsChildLeftAndAnswersTheChildsEnd(t *testing.T) {
	if _, err := exec.LookPath("setsid"); err != nil {
		t.Skip("no setsid(1) on this host")
	}
	file := filepath.Join(t.TempDir(), "escapee")
	// The escapee holds the keeper's stdout open: the keeper's end must not wait for it.
	cmd, report := keeper(t, "setsid sleep 300 & echo $! > "+file+"; exit 3")
	var out bytes.Buffer
	cmd.Stdout = &out
	started := time.Now()
	if err := runKept(cmd); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(started); d > 10*time.Second {
		t.Fatalf("the keeper took %s", d)
	}
	pid := readPidAny(t, file)
	if alive(pid) {
		t.Fatalf("the escapee %d outlived its keeper", pid)
	}
	ws, ok := KeptStatus(report)
	if !ok || ws.Signaled() || ws.ExitStatus() != 3 {
		t.Fatalf("the keeper answered %v (%v), not exit 3", ws, ok)
	}

	cmd, report = keeper(t, "kill -TERM $$")
	if err := runKept(cmd); err != nil {
		t.Fatal(err)
	}
	ws, ok = KeptStatus(report)
	if !ok || !ws.Signaled() || ws.Signal() != syscall.SIGTERM {
		t.Fatalf("the keeper answered %v (%v), not SIGTERM", ws, ok)
	}
}

// readPidAny reads a pid a script wrote to file, alive or not.
func readPidAny(t *testing.T, file string) int {
	t.Helper()
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("no pid: %q", raw)
	}
	t.Cleanup(func() { _ = syscall.Kill(n, syscall.SIGKILL) })
	return n
}

// The status pipe is the keeper's alone: its child does not hold it, so the keeper's answer ends
// when the keeper does.
func TestTheKeepersChildDoesNotHoldItsStatusPipe(t *testing.T) {
	cmd, _ := keeper(t, "ls /proc/$$/fd")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := runKept(cmd); err != nil {
		t.Fatal(err)
	}
	for f := range strings.FieldsSeq(out.String()) {
		if f == strconv.Itoa(StatusFD) {
			t.Fatalf("the child holds descriptor %d: %s", StatusFD, out.String())
		}
	}
}
