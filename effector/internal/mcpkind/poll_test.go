package mcpkind

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/snapwich/jr2/effector/internal/wire"
)

// A 2025-11-25 server that polls: each GET gives a new event id and closes; the 8th gives the answer.
func TestPollingServerIsReadPastFiveResumes(t *testing.T) {
	var gets atomic.Int32
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "id: ev-0\ndata:\nretry: 50\n\n")
	}}
	f.get = func(w http.ResponseWriter, r *http.Request) {
		n := gets.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		if n < 8 {
			_, _ = fmt.Fprintf(w, "id: ev-%d\ndata:\nretry: 50\n\n", n)
			return
		}
		_, _ = fmt.Fprintf(w, "id: ev-%d\ndata: %s\n\n", n,
			`{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"posted"}]}}`)
	}
	r, _ := setup(t, f)
	out := r.Run(context.Background(), call("post", `{}`))
	if out.Outcome != wire.OutcomeReturned {
		t.Fatalf("lost an answer inside the 5 s timeout: %s (%s)", out.Outcome, out.Reason)
	}
}
