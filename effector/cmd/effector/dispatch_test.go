package main

import (
	"crypto/x509"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/secrets"
)

// A dispatch runs in the Instance Effector alone (ADR-0071): kindsFor gives that placement the
// dispatch runner, and a Sandbox Effector none.
func TestKindsForGivesTheInstanceEffectorTheDispatchRunnerAlone(t *testing.T) {
	config := &secrets.Config{Version: 1, Placement: "instance"}
	held := map[string]string{}
	t.Setenv("JR2_EFFECTOR_WORK", "")
	instance, err := kindsFor(config, held, scrub.New(held), x509.NewCertPool(), mount{})
	if err != nil {
		t.Fatal(err)
	}
	if instance.Dispatch == nil || instance.Push != nil || instance.Command != nil {
		t.Fatalf("the Instance Effector's kinds: %+v", instance)
	}

	t.Setenv("JR2_EFFECTOR_WORK", t.TempDir())
	t.Setenv("JR2_EFFECTOR_SCRATCH", t.TempDir())
	sandbox, err := kindsFor(&secrets.Config{Version: 1, Placement: "sandbox"}, held, scrub.New(held),
		x509.NewCertPool(), mount{key: "/k/key", config: "/c/effector.json", secrets: "/s", git: "/g"})
	if err != nil {
		t.Fatal(err)
	}
	if sandbox.Dispatch != nil {
		t.Fatal("a Sandbox Effector runs a dispatch")
	}
}

// The signed wire, end to end in the binary (ADR-0068, ADR-0071): a dispatch start is validated,
// its token is one this Effector holds for that host, the door gets it, and the answer that comes
// back is scrubbed — here the door echoes the token into the run id.
func TestTheBinaryRunsADispatchAndScrubsItsAnswer(t *testing.T) {
	var auth, by string
	door := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/workflows/review/runs" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		auth, by = r.Header.Get("Authorization"), r.Header.Get("jr2-dispatched-by")
		_, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"runId":"run-`+url.PathEscape(strings.TrimPrefix(auth, "Bearer "))+`"}`)
	}))
	defer door.Close()
	e := startEffector(t, door.URL)
	body := fmt.Sprintf(`{"kind":"dispatch","url":[{"text":%q}],"workflow":"review","input":{"ticket":"PROJ-7"},`+
		`"auth":{"bearer":{"secret":"jira"}},"dispatchedBy":{"run":"r","slot":"review","effect":"d1","depth":1,`+
		`"instance":"caller"},"wait":false,"timeoutMs":5000}`, door.URL)
	raw := e.run(t, "d1", body)
	if !strings.Contains(raw, `"outcome":"started"`) || !strings.Contains(raw, `"run":"run-[secret:jira]"`) ||
		strings.Contains(raw, jiraSecret) {
		t.Fatalf("got %s", raw)
	}
	if auth != "Bearer "+jiraSecret || !strings.Contains(by, `"effect":"d1"`) {
		t.Fatalf("the door got %q, %q", auth, by)
	}

	// A dispatch whose token is not placed for the door's host is refused before anything is sent.
	other := strings.Replace(body, `"secret":"jira"`, `"secret":"nope"`, 1)
	if status, raw := e.call(t, "POST", "/effects/d2", other); status != 400 || !strings.Contains(raw, "secret nope") {
		t.Fatalf("got %d %s", status, raw)
	}
}
