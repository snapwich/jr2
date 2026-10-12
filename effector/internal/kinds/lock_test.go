package kinds

import (
	"context"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/wire"
)

// ADR-0068 rule 2: Effects of one class run together; an Effect of the other class waits while any is
// live, and a waiter that reaches its deadline is told so and holds nothing.
func TestTheLockLetsOneClassRunTogetherAndKeepsTheOtherWaiting(t *testing.T) {
	var l Lock
	ctx := context.Background()
	soon := func() time.Time { return time.Now().Add(time.Second) }
	for range 2 {
		if !l.Acquire(ctx, ClassCommand, soon()) {
			t.Fatal("two commands did not run together")
		}
	}
	if l.Acquire(ctx, ClassGPG, time.Now().Add(50*time.Millisecond)) {
		t.Fatal("a GPG push ran while commands were live")
	}
	got := make(chan bool, 1)
	go func() { got <- l.Acquire(ctx, ClassGPG, soon()) }()
	l.Release()
	select {
	case <-got:
		t.Fatal("a GPG push ran while one command was still live")
	case <-time.After(50 * time.Millisecond):
	}
	l.Release()
	if !<-got {
		t.Fatal("the GPG push did not run once the commands ended")
	}
	if l.Acquire(ctx, ClassCommand, time.Now().Add(50*time.Millisecond)) {
		t.Fatal("a command ran while a GPG push was live")
	}
	l.Release()
	if !l.Acquire(ctx, ClassCommand, soon()) {
		t.Fatal("the lock was not free after the push")
	}
}

// A start that waits past its timeout settles as a timed-out Effect of its kind, and never runs.
func TestAStartPastItsTimeoutSettlesTimedOutAndNeverRuns(t *testing.T) {
	r := &Runner{Lock: &Lock{}}
	if !r.Lock.Acquire(context.Background(), ClassGPG, time.Now().Add(time.Second)) {
		t.Fatal("the lock was held")
	}
	req := &wire.StartRequest{Kind: wire.KindCommand, TimeoutMs: 60,
		Command: &wire.CommandSpec{Argv: []string{"true"}}}
	out := r.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeTimeout || out.Command == nil ||
		out.Command.Tail != "the timeout passed while it waited for a GPG-signing push of this Sandbox Effector to end; it did not run\n" {
		t.Fatalf("got %+v %+v", out, out.Command)
	}
}
