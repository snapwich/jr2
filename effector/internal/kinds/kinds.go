// Package kinds routes a start to the kind that runs it (ADR-0067): `http` and `upload` to the
// http runner, `push` to the push runner, a credentialed `command` to the command runner. The
// Instance Effector holds only the first; a Sandbox Effector holds all three, and confines a
// credentialed command's child with Landlock (ADR-0068).
package kinds

import (
	"context"

	"github.com/snapwich/jr2/effector/internal/commandkind"
	"github.com/snapwich/jr2/effector/internal/httpkind"
	"github.com/snapwich/jr2/effector/internal/pushkind"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// Runner is one Effector's kinds. A nil Push or Command is a kind this placement does not run.
type Runner struct {
	HTTP    *httpkind.Runner
	Push    *pushkind.Runner
	Command *commandkind.Runner
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
	case wire.KindUpload:
		if r.HTTP.WorkRoot == "" {
			return "an upload, which runs in a Sandbox Effector"
		}
	}
	if req.Body != nil && req.Body.File != nil && r.HTTP.WorkRoot == "" {
		return "a file body, which runs in a Sandbox Effector"
	}
	return r.HTTP.Missing(req)
}

// Pin fixes the commit a push or a credentialed command runs against, when the start names none:
// the Agent's branch tip, read as data now. It answers the commit, which the start's answer
// carries so the Orchestrator writes it to the ledger's intent row; "" when it could not be read
// (the run then answers why) or the kind runs against none.
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

// Run runs the start to its outcome.
func (r *Runner) Run(ctx context.Context, req *wire.StartRequest) wire.Output {
	switch req.Kind {
	case wire.KindPush:
		return r.Push.Run(ctx, req)
	case wire.KindCommand:
		return r.Command.Run(ctx, req)
	}
	return r.HTTP.Run(ctx, req)
}
