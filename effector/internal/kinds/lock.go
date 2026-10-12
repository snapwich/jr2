package kinds

import (
	"context"
	"sync"
	"time"
)

// The two classes of a Sandbox Effector's lock (ADR-0068 rule 2). A `gpg` Effect is a push
// that signs with a GPG key: it starts a gpg-agent, which holds the key on a Unix socket that
// Landlock does not cover. A `command` Effect is a credentialed command, whose child is often the
// Agent's code. Effects of one class run together; an Effect of one class waits while any Effect
// of the other is live, so no child of a command is alive while a gpg-agent is.
const (
	ClassGPG     = "gpg"
	ClassCommand = "command"
)

// Lock is one Sandbox Effector's lock over the two classes. The zero value is unlocked.
type Lock struct {
	mu      sync.Mutex
	class   string
	live    int
	changed chan struct{}
}

// Acquire waits until no Effect of the other class is live, then counts this one in. It answers
// false when the deadline passes or ctx ends first: the Effect then never runs.
func (l *Lock) Acquire(ctx context.Context, class string, deadline time.Time) bool {
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	for {
		l.mu.Lock()
		if l.live == 0 || l.class == class {
			l.class = class
			l.live++
			l.mu.Unlock()
			return true
		}
		if l.changed == nil {
			l.changed = make(chan struct{})
		}
		changed := l.changed
		l.mu.Unlock()
		select {
		case <-changed:
		case <-timer.C:
			return false
		case <-ctx.Done():
			return false
		}
	}
}

// Release counts one Effect out. Its caller has ended every process the Effect started first: the
// agent a GPG push started is gone, and its Effect's processes are reaped (package reaper).
func (l *Lock) Release() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.live--
	if l.live == 0 {
		l.class = ""
	}
	if l.changed != nil {
		close(l.changed)
		l.changed = nil
	}
}
