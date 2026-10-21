package kinds

import (
	"strings"
	"testing"

	"github.com/snapwich/jr2/effector/internal/dispatchkind"
	"github.com/snapwich/jr2/effector/internal/httpkind"
	"github.com/snapwich/jr2/effector/internal/wire"
)

func dispatchStart() *wire.StartRequest {
	base := "https://ops.example.com"
	wait := false
	return &wire.StartRequest{Kind: wire.KindDispatch, URL: wire.Text{{Text: &base}}, Workflow: "review",
		Auth:      &wire.Auth{Bearer: &wire.SecretRef{Secret: "ops"}},
		Wait:      &wait,
		TimeoutMs: 1000}
}

// A dispatch runs in the Instance Effector alone (ADR-0071): a placement with no dispatch runner
// names that, a defect the server refuses before the Effect starts.
func TestADispatchWhereNoneRunsNamesThePlacement(t *testing.T) {
	sandbox := &Runner{HTTP: &httpkind.Runner{WorkRoot: "/work"}}
	if got := sandbox.Missing(dispatchStart()); !strings.Contains(got, "runs in the Instance Effector") {
		t.Fatalf("got %q", got)
	}
	instance := &Runner{HTTP: &httpkind.Runner{}, Dispatch: &dispatchkind.Runner{Secrets: map[string]string{}}}
	if got := instance.Missing(dispatchStart()); got != "ops" {
		t.Fatalf("the dispatch runner's own check: got %q", got)
	}
	instance.Dispatch.Secrets["ops"] = "t"
	if got := instance.Missing(dispatchStart()); got != "" {
		t.Fatalf("got %q", got)
	}
	// It holds no Lock class and pins no commit.
	if instance.Class(dispatchStart()) != "" || instance.Pin(dispatchStart()) != "" {
		t.Fatal("a dispatch holds a class or a pin")
	}
}
