package main

import (
	"bytes"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The exec probe of a container on the Fence (ADR-0084): 0 only for a 2xx status from the url.
// The Harness's own /healthz answers 204 (packages/harness/src/app.ts), so 204 must pass. A
// redirect is not followed and fails.
func TestHealthcheckPassesOnlyOn2xx(t *testing.T) {
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		if status == http.StatusFound {
			http.Redirect(w, r, "/elsewhere", status)
			return
		}
		w.WriteHeader(status)
	}))
	defer srv.Close()

	for _, tc := range []struct {
		status int
		want   int
	}{
		{http.StatusNoContent, 0}, // the Harness's answer
		{http.StatusOK, 0},
		{http.StatusServiceUnavailable, 1},
		{http.StatusFound, 1},
		{http.StatusNotFound, 1},
		{http.StatusInternalServerError, 1},
	} {
		status = tc.status
		var stderr bytes.Buffer
		if got := healthcheck([]string{srv.URL + "/healthz"}, &stderr); got != tc.want {
			t.Fatalf("status %d: exit %d, want %d (%s)", tc.status, got, tc.want, stderr.String())
		}
		if tc.want != 0 && !strings.Contains(stderr.String(), "answered") {
			t.Fatalf("status %d: the reason is not on stderr: %q", tc.status, stderr.String())
		}
	}
}

// A port where nothing listens fails at once, with the reason.
func TestHealthcheckFailsWhenNothingListens(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	addr := l.Addr().String()
	must(t, l.Close())
	var stderr bytes.Buffer
	if got := healthcheck([]string{"http://" + addr + "/healthz"}, &stderr); got != 1 {
		t.Fatalf("exit %d, want 1", got)
	}
	if !strings.Contains(stderr.String(), "refused") {
		t.Fatalf("the reason: %q", stderr.String())
	}
}

// A server that does not answer fails within the 1 s bound, not at the kubelet's timeout.
func TestHealthcheckFailsAfterOneSecondWithNoAnswer(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer srv.Close()
	defer close(release)
	started := time.Now()
	var stderr bytes.Buffer
	if got := healthcheck([]string{srv.URL + "/healthz"}, &stderr); got != 1 {
		t.Fatalf("exit %d, want 1", got)
	}
	if took := time.Since(started); took < healthcheckTimeout || took > 3*healthcheckTimeout {
		t.Fatalf("took %v, want about %v", took, healthcheckTimeout)
	}
}

func TestHealthcheckRefusesABadCall(t *testing.T) {
	for _, args := range [][]string{nil, {"a", "b"}, {"127.0.0.1:8080/healthz"}, {"unix:///run/x"}} {
		var stderr bytes.Buffer
		if got := healthcheck(args, &stderr); got != 2 {
			t.Fatalf("%q: exit %d, want 2", args, got)
		}
	}
}
