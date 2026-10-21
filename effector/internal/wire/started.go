package wire

import "context"

// startedKey carries the hook a dispatch reports its run through (ADR-0071).
type startedKey struct{}

// WithStarted gives ctx a hook that a dispatch calls once the door has answered with the run it
// started, before its wait: the server shows the run on the Effect's `running` state, so the
// Orchestrator writes it to the ledger's intent row while the wait runs (ADR-0071).
func WithStarted(ctx context.Context, hook func(run string)) context.Context {
	return context.WithValue(ctx, startedKey{}, hook)
}

// Started calls ctx's hook with the run, when ctx has one.
func Started(ctx context.Context, run string) {
	if hook, ok := ctx.Value(startedKey{}).(func(string)); ok && hook != nil {
		hook(run)
	}
}
