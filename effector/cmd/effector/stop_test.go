package main

import (
	"strings"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/gittest"
)

// A stopped state stops its credentialed command (ADR-0067, ADR-0068), with real processes: the
// Orchestrator's signed DELETE on the Effect's own path sends SIGTERM to the command's process
// group, then SIGKILL past a grace, and the Effect settles once its processes are gone, with the
// signal that ended it.

// startCommand starts a command and waits a moment for its script to reach its sleep: the pid it
// prints (`escapee=<pid>`) is read from the outcome's tail.
func (e *effector) startCommand(t *testing.T, id, body string) {
	t.Helper()
	if status, raw := e.call(t, "POST", "/effects/"+id, body); status != 202 {
		t.Fatalf("start: got %d %s", status, raw)
	}
	time.Sleep(1500 * time.Millisecond)
}

func TestADeleteStopsACredentialedCommandsGroup(t *testing.T) {
	p := gittest.NewPod(t, "work")
	p.Commit("a long command", map[string]string{"long.sh": "echo \"escapee=$$\"\nexec sleep 300\n"})
	e, out := startSandboxEffectorWith(t, p, true)
	if e == nil {
		t.Fatalf("the effector never served: %s", out)
	}
	e.startCommand(t, "long-1", commandStart("long.sh"))
	began := time.Now()
	status, got := e.call(t, "DELETE", "/effects/long-1", "")
	if status != 200 || !strings.Contains(got, `"state":"settled"`) {
		t.Fatalf("DELETE: got %d %s", status, got)
	}
	if d := time.Since(began); d > 4*time.Second {
		t.Fatalf("a command that ends on SIGTERM was stopped after %s", d)
	}
	if !strings.Contains(got, `"outcome":"killed"`) || !strings.Contains(got, `"signal":"SIGTERM"`) {
		t.Fatalf("got %s", got)
	}
	if pid := escapee(t, got); alive(pid) {
		t.Fatalf("the stopped command %d is still running", pid)
	}
	// The outcome stays the Effect's: a poll reads it, and a second DELETE stops nothing more.
	if status, again := e.call(t, "DELETE", "/effects/long-1", ""); status != 200 || again != got {
		t.Fatalf("a second DELETE: got %d %s", status, again)
	}
}

func TestADeleteKillsAChildThatIgnoresSigterm(t *testing.T) {
	p := gittest.NewPod(t, "work")
	p.Commit("a stubborn command", map[string]string{
		"stubborn.sh": "trap '' TERM\nsleep 300 &\necho \"escapee=$!\"\nwait\nwait\n",
	})
	e, out := startSandboxEffectorWith(t, p, true)
	if e == nil {
		t.Fatalf("the effector never served: %s", out)
	}
	e.startCommand(t, "stubborn-1", commandStart("stubborn.sh"))
	began := time.Now()
	status, got := e.call(t, "DELETE", "/effects/stubborn-1", "")
	if status != 200 || !strings.Contains(got, `"state":"settled"`) {
		t.Fatalf("DELETE: got %d %s", status, got)
	}
	if d := time.Since(began); d < 4*time.Second || d > 15*time.Second {
		t.Fatalf("a child that ignores SIGTERM was ended after %s, not after the grace", d)
	}
	if !strings.Contains(got, `"outcome":"killed"`) || !strings.Contains(got, `"signal":"SIGKILL"`) {
		t.Fatalf("got %s", got)
	}
	if pid := escapee(t, got); alive(pid) {
		t.Fatalf("the child %d that ignored SIGTERM is still running", pid)
	}
}
