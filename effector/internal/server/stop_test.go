package server

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/sign"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// The stop route (ADR-0067, ADR-0068): `DELETE /effects/<id>` stops a credentialed command whose
// state exited, and a dispatch's wait (ADR-0071). It is signed like every request; a push and an
// http Effect are one request each and end on their own, so a DELETE on one answers as an unknown
// method does.

// stoppableRunner runs each Effect until its context is cancelled, and answers the cause it saw.
type stoppableRunner struct {
	fakeRunner
	causes chan error
}

func (f *stoppableRunner) Run(ctx context.Context, _ *wire.StartRequest) wire.Output {
	f.runs.Add(1)
	<-ctx.Done()
	f.causes <- context.Cause(ctx)
	return wire.Output{Outcome: wire.OutcomeExited, Command: &wire.CommandResult{Signal: "SIGTERM", Tail: "stopped\n"}}
}

func fixture(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/wire/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestADeleteStopsACredentialedCommandAndAnswersItsOutcome(t *testing.T) {
	runner := &stoppableRunner{causes: make(chan error, 1)}
	_, srv := newServer(t, runner)
	if a := call(t, srv.URL, "POST", "/effects/c1", fixture(t, "request.command-env.json"), key); a.status != http.StatusAccepted {
		t.Fatalf("start: %d %s", a.status, a.body)
	}
	a := call(t, srv.URL, "DELETE", "/effects/c1", "", key)
	if !errors.Is(<-runner.causes, wire.ErrStopped) {
		t.Fatal("the command was not stopped by the DELETE")
	}
	s := state(t, a)
	if a.status != http.StatusOK || s.State != wire.StateSettled || s.Output.Outcome != wire.OutcomeExited ||
		s.Output.Command.Signal != "SIGTERM" {
		t.Fatalf("got %d %s", a.status, a.body)
	}
	// A DELETE on a settled command stops nothing more and answers its outcome again.
	again := call(t, srv.URL, "DELETE", "/effects/c1", "", key)
	if again.status != http.StatusOK || state(t, again).State != wire.StateSettled || runner.runs.Load() != 1 {
		t.Fatalf("got %d %s", again.status, again.body)
	}
}

func TestAnUnsignedDeleteIsRefusedAndStopsNothing(t *testing.T) {
	runner := &stoppableRunner{causes: make(chan error, 1)}
	_, srv := newServer(t, runner)
	call(t, srv.URL, "POST", "/effects/c1", fixture(t, "request.command-env.json"), key)
	for name, a := range map[string]answer{
		"unsigned":    send(t, srv.URL, "DELETE", "/effects/c1", "", "", "", ""),
		"another key": call(t, srv.URL, "DELETE", "/effects/c1", "", []byte("not the placement's key")),
	} {
		if a.status != http.StatusUnauthorized || len(a.body) != 0 {
			t.Errorf("%s: got %d %q", name, a.status, a.body)
		}
	}
	select {
	case <-runner.causes:
		t.Fatal("a refused DELETE stopped the command")
	default:
	}
	call(t, srv.URL, "DELETE", "/effects/c1", "", key)
	<-runner.causes
}

func TestADeleteOnAPushOrAnHttpEffectAnswersAsAnUnknownMethod(t *testing.T) {
	for name, body := range map[string]string{
		"http": startBody,
		"push": fixture(t, "request.push-signed.json"),
	} {
		t.Run(name, func(t *testing.T) {
			runner := &fakeRunner{release: make(chan struct{}),
				output: wire.Output{Outcome: wire.OutcomeUnknown, Reason: "ran to its end"}}
			_, srv := newServer(t, runner)
			if a := call(t, srv.URL, "POST", "/effects/e1", body, key); a.status != http.StatusAccepted {
				t.Fatalf("start: %d %s", a.status, a.body)
			}
			put := call(t, srv.URL, "PUT", "/effects/e1", "", key)
			del := call(t, srv.URL, "DELETE", "/effects/e1", "", key)
			if del.status != http.StatusMethodNotAllowed || del.status != put.status || string(del.body) != string(put.body) {
				t.Fatalf("DELETE got %d %s; PUT got %d %s", del.status, del.body, put.status, put.body)
			}
			// The text names every method an Effect's path takes, the stop route included.
			if !strings.Contains(string(del.body), `"POST or GET; DELETE stops a credentialed command or a dispatch's wait"`) {
				t.Fatalf("405 text: %s", del.body)
			}
			// It runs on to its end.
			close(runner.release)
			if s := state(t, call(t, srv.URL, "GET", "/effects/e1", "", key)); s.State != wire.StateSettled {
				t.Fatalf("got %+v", s)
			}
		})
	}
}

func TestADeleteOfAnEffectThisReplicaDoesNotHoldSaysSo(t *testing.T) {
	_, srv := newServer(t, &fakeRunner{release: make(chan struct{})})
	a := call(t, srv.URL, "DELETE", "/effects/elsewhere", "", key)
	if s := state(t, a); a.status != http.StatusNotFound || s.State != wire.StateUnknown {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

// A fast exit can send the stop while the command's start is still on the wire (ADR-0067): the
// DELETE of an id this replica does not hold is kept, and the start that arrives after it runs
// nothing. It settles `unknown`, as a stop before the program started does.
func TestAStartThatArrivesAfterItsStopRunsNothing(t *testing.T) {
	runner := &stoppableRunner{causes: make(chan error, 1)}
	_, srv := newServer(t, runner)
	del := call(t, srv.URL, "DELETE", "/effects/c1", "", key)
	if s := state(t, del); del.status != http.StatusNotFound || s.State != wire.StateUnknown {
		t.Fatalf("DELETE got %d %s", del.status, del.body)
	}
	start := call(t, srv.URL, "POST", "/effects/c1", fixture(t, "request.command-env.json"), key)
	s := state(t, start)
	if start.status != http.StatusOK || s.State != wire.StateSettled || s.Output.Outcome != wire.OutcomeUnknown ||
		s.Output.Reason != wire.StoppedBeforeStart {
		t.Fatalf("start got %d %s", start.status, start.body)
	}
	if poll := state(t, call(t, srv.URL, "GET", "/effects/c1", "", key)); poll.State != wire.StateSettled ||
		poll.Output.Reason != wire.StoppedBeforeStart {
		t.Fatalf("poll got %+v", poll)
	}
	if runner.runs.Load() != 0 {
		t.Fatalf("the command ran %d times after its stop", runner.runs.Load())
	}
}

// Only a credentialed command has the stop route: a push or an http start whose id a DELETE named
// first runs as any start does.
func TestAStopKeptForAnUnknownIdLeavesAPushOrAnHttpStartAsItIs(t *testing.T) {
	for name, body := range map[string]string{
		"http": startBody,
		"push": fixture(t, "request.push-signed.json"),
	} {
		t.Run(name, func(t *testing.T) {
			runner := &fakeRunner{release: make(chan struct{}), output: wire.Output{Outcome: wire.OutcomeUnknown, Reason: "ran"}}
			close(runner.release)
			_, srv := newServer(t, runner)
			call(t, srv.URL, "DELETE", "/effects/e1", "", key)
			if a := call(t, srv.URL, "POST", "/effects/e1", body, key); a.status != http.StatusAccepted {
				t.Fatalf("start: %d %s", a.status, a.body)
			}
			waitFor(t, func() bool { return runner.runs.Load() == 1 })
		})
	}
}

// The kept stop outlives every start signed before it: a request is refused once its time is a
// signing window behind this replica's clock, so the stop is kept twice that, whatever Retain is.
func TestAStopKeptForAnUnknownIdOutlivesTheSigningWindow(t *testing.T) {
	runner := &stoppableRunner{causes: make(chan error, 1)}
	s, srv := newServer(t, runner)
	s.opts.Retain = time.Second
	call(t, srv.URL, "DELETE", "/effects/c1", "", key)
	s.Sweep(time.Now().Add(2*sign.Window - time.Second))
	s.mu.Lock()
	_, kept := s.effects["c1"]
	s.mu.Unlock()
	if !kept {
		t.Fatal("the stop was dropped inside the signing window")
	}
	s.Sweep(time.Now().Add(2*sign.Window + time.Second))
	s.mu.Lock()
	_, kept = s.effects["c1"]
	s.mu.Unlock()
	if kept {
		t.Fatal("the stop was kept past twice the signing window")
	}
}

// waitRunner is a dispatch's wait as the server sees it: it runs until its context ends, and
// answers what a stopped wait answers.
type waitRunner struct {
	causes chan error
	waits  chan bool
}

func (w *waitRunner) Missing(*wire.StartRequest) string { return "" }
func (w *waitRunner) Pin(*wire.StartRequest) string     { return "" }
func (w *waitRunner) Run(ctx context.Context, req *wire.StartRequest) wire.Output {
	w.waits <- req.Wait != nil && *req.Wait
	if req.Wait == nil || !*req.Wait {
		return wire.Output{Outcome: wire.OutcomeStarted, Run: "run-1"}
	}
	<-ctx.Done()
	w.causes <- context.Cause(ctx)
	return wire.Output{Outcome: wire.OutcomeUnknown, Reason: "the wait for run run-1 was stopped"}
}

// A dispatch's wait is stopped as a command is (ADR-0071): its state exited, so the poll of the
// door with the target's token ends here, and the answer is its outcome.
func TestADeleteStopsADispatchsWaitAndAnswersItsOutcome(t *testing.T) {
	runner := &waitRunner{causes: make(chan error, 1), waits: make(chan bool, 1)}
	_, srv := newServer(t, runner)
	if a := call(t, srv.URL, "POST", "/effects/d1", fixture(t, "request.dispatch-wait.json"), key); a.status != http.StatusAccepted {
		t.Fatalf("start: %d %s", a.status, a.body)
	}
	<-runner.waits
	a := call(t, srv.URL, "DELETE", "/effects/d1", "", key)
	if !errors.Is(<-runner.causes, wire.ErrStopped) {
		t.Fatal("the wait was not stopped by the DELETE")
	}
	if s := state(t, a); a.status != http.StatusOK || s.State != wire.StateSettled ||
		s.Output.Outcome != wire.OutcomeUnknown {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

// A stop that came before its dispatch's start is kept: the start still goes to the door — it may
// be the one that started the run — and is not waited for (ADR-0071).
func TestADispatchStartAfterItsStopIsNotWaitedFor(t *testing.T) {
	runner := &waitRunner{causes: make(chan error, 1), waits: make(chan bool, 1)}
	_, srv := newServer(t, runner)
	call(t, srv.URL, "DELETE", "/effects/d1", "", key)
	if a := call(t, srv.URL, "POST", "/effects/d1", fixture(t, "request.dispatch-wait.json"), key); a.status != http.StatusAccepted {
		t.Fatalf("start: %d %s", a.status, a.body)
	}
	if waited := <-runner.waits; waited {
		t.Fatal("a dispatch stopped before its start waits")
	}
}
