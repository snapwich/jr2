// Package kinds routes a start to the kind that runs it (ADR-0067): `http` — a file body (ADR-0067)
// included — to the http runner, `push` to the push runner, a credentialed `command` to the command
// runner, a `dispatch` to another Orchestrator (ADR-0071) to the dispatch runner. The Instance
// Effector holds http and dispatch; a Sandbox Effector holds http, push and command, and confines a
// credentialed command's child with Landlock (ADR-0068).
//
// One child cannot reach another (ADR-0068). Every Effect's processes are its own group (package
// reaper), ended when it settles; and a Sandbox Effector's one Lock keeps a GPG-signing push and a
// credentialed command from being live together. An Effect settles only after its processes are
// gone, and it releases the Lock only then.
package kinds

import (
	"context"
	"errors"
	"time"

	"github.com/snapwich/jr2/effector/internal/commandkind"
	"github.com/snapwich/jr2/effector/internal/dispatchkind"
	"github.com/snapwich/jr2/effector/internal/httpkind"
	"github.com/snapwich/jr2/effector/internal/pushkind"
	"github.com/snapwich/jr2/effector/internal/reaper"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// Runner is one Effector's kinds. A nil Push, Command or Dispatch is a kind this placement does not
// run.
type Runner struct {
	HTTP     *httpkind.Runner
	Push     *pushkind.Runner
	Command  *commandkind.Runner
	Dispatch *dispatchkind.Runner
	// Reaper ends what each Effect started when it settles; nil, nothing is tracked.
	Reaper *reaper.Reaper
	// Lock is the Sandbox Effector's lock over the two classes; nil, none is held.
	Lock *Lock
}

// Class is the Lock's class of a start, or "" for a start that holds none: `gpg` for a push that
// signs with a GPG key, `command` for a credentialed command. A dispatch holds none: it runs in the
// Instance Effector, which has no Lock.
func (r *Runner) Class(req *wire.StartRequest) string {
	switch {
	case req.Kind == wire.KindCommand:
		return ClassCommand
	case req.Kind == wire.KindPush && req.Push != nil && req.Push.Sign && r.Push != nil:
		if e := r.Push.Config.EntryFor(req.Push.Credential, req.Push.URL); e != nil && e.Sign != nil && e.Sign.GPGKey != "" {
			return ClassGPG
		}
	}
	return ""
}

// Missing names what makes the start a defect of jr2 or config: a secret this Effector does not
// hold, a credential it has no files for, a kind this placement does not run.
func (r *Runner) Missing(req *wire.StartRequest) string {
	switch req.Kind {
	case wire.KindPush:
		if r.Push == nil {
			return "a push, which runs in a Sandbox Effector"
		}
		return r.Push.Check(req)
	case wire.KindCommand:
		if r.Command == nil {
			return "a credentialed command, which runs in a Sandbox Effector"
		}
		return r.Command.Missing(req)
	case wire.KindDispatch:
		if r.Dispatch == nil {
			return "a dispatch to another Orchestrator, which runs in the Instance Effector"
		}
		return r.Dispatch.Missing(req)
	}
	if req.Body != nil && req.Body.File != nil && r.HTTP.WorkRoot == "" {
		return "a file body, which runs in a Sandbox Effector"
	}
	return r.HTTP.Missing(req)
}

// Pin fixes the commit a push or a credentialed command runs against, when the start names none:
// the Agent's branch tip, read as data now. It answers the commit, which the start's answer
// carries so the Orchestrator writes it to the ledger's intent row; "" when it could not be read
// (the run then answers why) or the kind runs against none — an http or a dispatch.
func (r *Runner) Pin(req *wire.StartRequest) string {
	switch {
	case req.Push != nil && r.Push != nil:
		if req.Push.Pin == "" {
			req.Push.Pin, _ = pushkind.Pin(r.Push.WorkRoot, req.Push.Repo, req.Push.Branch)
		}
		return req.Push.Pin
	case req.Command != nil && r.Command != nil:
		if req.Command.Pin == "" {
			req.Command.Pin, _ = pushkind.Pin(r.Command.WorkRoot, req.Command.Repo, req.Command.Branch)
		}
		return req.Command.Pin
	}
	return ""
}

// Run runs the start to its outcome. A start of a class waits for the Lock within its own timeout;
// past it, it settles as a timed-out Effect of its kind and never runs late. Whatever it started
// is ended before it settles, and the Lock is released after that.
func (r *Runner) Run(ctx context.Context, req *wire.StartRequest) wire.Output {
	g := r.Reaper.Group()
	ctx = reaper.With(ctx, g)
	if class := r.Class(req); class != "" && r.Lock != nil {
		timeout := time.Duration(req.TimeoutMs) * time.Millisecond
		started := time.Now()
		if !r.Lock.Acquire(ctx, class, started.Add(timeout)) {
			g.Settle()
			if errors.Is(context.Cause(ctx), wire.ErrStopped) {
				// Stopped while it waited for the other class (ADR-0067): it never ran.
				return wire.Output{Outcome: wire.OutcomeUnknown, Reason: wire.StoppedBeforeStart}
			}
			return timedOut(req, class)
		}
		defer r.Lock.Release()
		// The wait is part of the Effect's timeout.
		left := timeout - time.Since(started)
		req.TimeoutMs = max(1, left.Milliseconds())
	}
	// Before the Release above: an Effect is settled only once its processes are gone.
	defer g.Settle()
	return r.run(ctx, req)
}

// timedOut is a start that waited past its timeout for the other class to end: it never ran.
func timedOut(req *wire.StartRequest, class string) wire.Output {
	other := "a GPG-signing push"
	if class == ClassGPG {
		other = "the credentialed commands"
	}
	why := "the timeout passed while it waited for " + other + " of this Sandbox Effector to end"
	if req.Kind == wire.KindCommand {
		return wire.Output{Outcome: wire.OutcomeTimeout, Command: &wire.CommandResult{Tail: why + "; it did not run\n"}}
	}
	return wire.Output{Outcome: wire.OutcomeRejected, Reason: why + "; nothing was pushed",
		Push: &wire.PushResult{Stage: "sign"}}
}

func (r *Runner) run(ctx context.Context, req *wire.StartRequest) wire.Output {
	switch req.Kind {
	case wire.KindPush:
		return r.Push.Run(ctx, req)
	case wire.KindCommand:
		return r.Command.Run(ctx, req)
	case wire.KindDispatch:
		return r.Dispatch.Run(ctx, req)
	}
	return r.HTTP.Run(ctx, req)
}
