package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/sign"
	"github.com/snapwich/jr2/effector/internal/wire"
)

var key = []byte("placement-key-for-the-server-tests")

const startBody = `{"kind":"http","method":"GET","url":[{"text":"https://api.example.com"}],"timeoutMs":1000,"maxBody":100}`

// fakeRunner settles each Effect when release is closed, and counts runs.
type fakeRunner struct {
	runs    atomic.Int32
	release chan struct{}
	output  wire.Output
	missing string
}

func (f *fakeRunner) Missing(*wire.StartRequest) string { return f.missing }
func (f *fakeRunner) Run(context.Context, *wire.StartRequest) wire.Output {
	f.runs.Add(1)
	<-f.release
	return f.output
}

func newServer(t *testing.T, runner Runner) (*Server, *httptest.Server) {
	t.Helper()
	s := New(Options{
		Verifier: sign.NewVerifier(key, nil),
		Runner:   runner,
		Scrubber: scrub.New(map[string]string{"jira": "the-jira-secret-value"}),
		Replica:  wire.Replica{Name: "effector-a", Address: "10.0.0.1:8082"},
		Hold:     100 * time.Millisecond,
	})
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return s, srv
}

type answer struct {
	status int
	body   []byte
}

// call signs a request with k and checks the answer's signature against the same key.
func call(t *testing.T, base, method, path, body string, k []byte) answer {
	t.Helper()
	nonce := newNonce()
	at := strconv.FormatInt(time.Now().UnixMilli(), 10)
	return send(t, base, method, path, body, at, nonce, sign.RequestMAC(k, method, path, at, nonce, []byte(body)))
}

func send(t *testing.T, base, method, path, body, at, nonce, signature string) answer {
	t.Helper()
	req, _ := http.NewRequest(method, base+path, strings.NewReader(body))
	if at != "" {
		req.Header.Set(sign.HeaderTime, at)
		req.Header.Set(sign.HeaderNonce, nonce)
		req.Header.Set(sign.HeaderSignature, signature)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusUnauthorized {
		want := sign.ResponseMAC(key, resp.StatusCode, method, path, nonce, raw)
		if resp.Header.Get(sign.HeaderSignature) != want {
			t.Fatalf("the answer to %s %s is not signed for its request", method, path)
		}
	}
	return answer{resp.StatusCode, raw}
}

func newNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func state(t *testing.T, a answer) wire.EffectState {
	t.Helper()
	var s wire.EffectState
	if err := wire.Decode(bytes.NewReader(a.body), &s); err != nil {
		t.Fatalf("%s: %v", a.body, err)
	}
	return s
}

func TestARefusedRequestLearnsNothing(t *testing.T) {
	runner := &fakeRunner{release: make(chan struct{})}
	_, srv := newServer(t, runner)
	at := strconv.FormatInt(time.Now().UnixMilli(), 10)
	nonce := newNonce()
	cases := map[string]answer{
		"unsigned":         send(t, srv.URL, "POST", "/effects/e1", startBody, "", "", ""),
		"another key":      call(t, srv.URL, "POST", "/effects/e1", startBody, []byte("not the placement's key")),
		"an unknown route": send(t, srv.URL, "GET", "/nothing", "", "", "", ""),
		"signed for another body": send(t, srv.URL, "POST", "/effects/e1", startBody, at, nonce,
			sign.RequestMAC(key, "POST", "/effects/e1", at, nonce, []byte(`{}`))),
	}
	for name, a := range cases {
		if a.status != http.StatusUnauthorized || len(a.body) != 0 {
			t.Errorf("%s: got %d %q", name, a.status, a.body)
		}
	}
	if runner.runs.Load() != 0 {
		t.Fatal("a refused request ran an Effect")
	}
}

func TestAReplayedRequestIsRefused(t *testing.T) {
	runner := &fakeRunner{release: make(chan struct{})}
	defer close(runner.release)
	_, srv := newServer(t, runner)
	at := strconv.FormatInt(time.Now().UnixMilli(), 10)
	nonce := newNonce()
	sig := sign.RequestMAC(key, "POST", "/effects/e1", at, nonce, []byte(startBody))
	if a := send(t, srv.URL, "POST", "/effects/e1", startBody, at, nonce, sig); a.status != http.StatusAccepted {
		t.Fatalf("got %d %s", a.status, a.body)
	}
	if a := send(t, srv.URL, "POST", "/effects/e1", startBody, at, nonce, sig); a.status != http.StatusUnauthorized {
		t.Fatalf("a replay got %d %s", a.status, a.body)
	}
}

func TestARequestOver4MiBIsRefusedAsUnsigned(t *testing.T) {
	runner := &fakeRunner{release: make(chan struct{})}
	defer close(runner.release)
	_, srv := newServer(t, runner)
	// Signed with the right key, one byte past the bound: it cannot be verified, so it is unsigned.
	over := strings.Repeat(" ", maxRequestBody+1-len(startBody)) + startBody
	if a := call(t, srv.URL, "POST", "/effects/over", over, key); a.status != http.StatusUnauthorized || len(a.body) != 0 {
		t.Fatalf("over the bound: got %d %q", a.status, a.body)
	}
	if runner.runs.Load() != 0 {
		t.Fatal("a request over the bound ran an Effect")
	}
	// Exactly at the bound it is read whole, verified and started.
	at := strings.Repeat(" ", maxRequestBody-len(startBody)) + startBody
	if a := call(t, srv.URL, "POST", "/effects/at", at, key); a.status != http.StatusAccepted {
		t.Fatalf("at the bound: got %d %s", a.status, a.body)
	}
	if maxRequestBody != 4<<20 {
		t.Fatalf("the bound is %d bytes; ADR-0068 and the Orchestrator's MAX_START_BYTES say 4 MiB", maxRequestBody)
	}
}

func TestAPostStartsOnceAndASecondAttaches(t *testing.T) {
	runner := &fakeRunner{release: make(chan struct{}), output: wire.Output{Outcome: wire.OutcomeUnknown, Reason: "r"}}
	_, srv := newServer(t, runner)
	first := call(t, srv.URL, "POST", "/effects/e1", startBody, key)
	if first.status != http.StatusAccepted {
		t.Fatalf("got %d %s", first.status, first.body)
	}
	if s := state(t, first); s.State != wire.StateRunning || s.Replica.Name != "effector-a" || s.Replica.Address != "10.0.0.1:8082" {
		t.Fatalf("got %+v", s)
	}
	again := call(t, srv.URL, "POST", "/effects/e1", startBody, key)
	if again.status != http.StatusOK || state(t, again).State != wire.StateRunning {
		t.Fatalf("got %d %s", again.status, again.body)
	}
	close(runner.release)
	settled := call(t, srv.URL, "GET", "/effects/e1", "", key)
	if s := state(t, settled); s.State != wire.StateSettled || s.Output.Outcome != wire.OutcomeUnknown {
		t.Fatalf("got %s", settled.body)
	}
	if runner.runs.Load() != 1 {
		t.Fatalf("ran %d times", runner.runs.Load())
	}
}

func TestAPollHoldsThenSaysRunning(t *testing.T) {
	runner := &fakeRunner{release: make(chan struct{})}
	defer close(runner.release)
	_, srv := newServer(t, runner)
	call(t, srv.URL, "POST", "/effects/e1", startBody, key)
	began := time.Now()
	a := call(t, srv.URL, "GET", "/effects/e1", "", key)
	if a.status != http.StatusOK || state(t, a).State != wire.StateRunning || time.Since(began) < 90*time.Millisecond {
		t.Fatalf("got %d %s after %v", a.status, a.body, time.Since(began))
	}
}

func TestAPollToTheWrongReplicaSaysSo(t *testing.T) {
	_, srv := newServer(t, &fakeRunner{release: make(chan struct{})})
	a := call(t, srv.URL, "GET", "/effects/elsewhere", "", key)
	s := state(t, a)
	if a.status != http.StatusNotFound || s.State != wire.StateUnknown || s.Replica.Name != "effector-a" {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}

func TestAMalformedRequestIsRefusedSignedAndRunsNothing(t *testing.T) {
	runner := &fakeRunner{release: make(chan struct{})}
	_, srv := newServer(t, runner)
	for _, body := range []string{
		`{"kind":"http","method":"GET","url":[{"text":"https://x"}],"timeoutMs":1,"maxBody":1,"extra":true}`,
		`{"kind":"push"}`,
		`{"kind":"http","method":"TRACE","url":[{"text":"https://x"}],"timeoutMs":1,"maxBody":1}`,
		`{"kind":"http","method":"GET","url":[{"text":"https://x"}],"headers":{"host":[{"text":"y"}]},"timeoutMs":1,"maxBody":1}`,
	} {
		a := call(t, srv.URL, "POST", "/effects/bad", body, key)
		if a.status != http.StatusBadRequest || !strings.Contains(string(a.body), "malformed") {
			t.Fatalf("%s: got %d %s", body, a.status, a.body)
		}
	}
	runner.missing = "absent"
	if a := call(t, srv.URL, "POST", "/effects/bad", startBody, key); a.status != http.StatusBadRequest ||
		!strings.Contains(string(a.body), "secret absent") {
		t.Fatalf("got %d %s", a.status, a.body)
	}
	if runner.runs.Load() != 0 {
		t.Fatal("a refused request ran")
	}
}

func TestTheAnswerIsScrubbedBeforeItIsSigned(t *testing.T) {
	runner := &fakeRunner{release: make(chan struct{}), output: wire.Output{
		Outcome: wire.OutcomeUnreachable, Reason: "dial https://x/the-jira-secret-value failed",
	}}
	close(runner.release)
	_, srv := newServer(t, runner)
	call(t, srv.URL, "POST", "/effects/e1", startBody, key)
	a := call(t, srv.URL, "GET", "/effects/e1", "", key)
	if strings.Contains(string(a.body), "the-jira-secret-value") || !strings.Contains(string(a.body), "[secret:jira]") {
		t.Fatalf("got %s", a.body)
	}
}

func TestADrainRefusesNewEffectsAndWaitsForTheOutcomeToBeRead(t *testing.T) {
	runner := &fakeRunner{release: make(chan struct{}), output: wire.Output{Outcome: wire.OutcomeUnknown, Reason: "r"}}
	s, srv := newServer(t, runner)
	call(t, srv.URL, "POST", "/effects/inflight", startBody, key)
	var drained sync.WaitGroup
	drained.Go(func() { s.Drain(context.Background()) })
	waitFor(t, s.isStopping)
	refused := call(t, srv.URL, "POST", "/effects/new", startBody, key)
	if refused.status != http.StatusServiceUnavailable || !strings.Contains(string(refused.body), `"stopping"`) {
		t.Fatalf("got %d %s", refused.status, refused.body)
	}
	if resp, _ := http.Get(srv.URL + "/healthz"); resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("a draining replica reports ready: %d", resp.StatusCode)
	}
	close(runner.release)
	done := make(chan struct{})
	go func() { drained.Wait(); close(done) }()
	select {
	case <-done:
		t.Fatal("the drain ended before the outcome was read")
	case <-time.After(150 * time.Millisecond):
	}
	if a := call(t, srv.URL, "GET", "/effects/inflight", "", key); state(t, a).State != wire.StateSettled {
		t.Fatalf("got %s", a.body)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the drain did not end once the outcome was read")
	}
}

func TestADrainEndsAtItsDeadline(t *testing.T) {
	runner := &fakeRunner{release: make(chan struct{})}
	defer close(runner.release)
	s, srv := newServer(t, runner)
	call(t, srv.URL, "POST", "/effects/stuck", startBody, key)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	s.Drain(ctx)
}

func TestAnUnreadOutcomeIsDroppedAfterRetain(t *testing.T) {
	runner := &fakeRunner{release: make(chan struct{}), output: wire.Output{Outcome: wire.OutcomeUnknown, Reason: "r"}}
	close(runner.release)
	s, srv := newServer(t, runner)
	call(t, srv.URL, "POST", "/effects/e1", startBody, key)
	waitFor(t, func() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.effects["e1"].output != nil })
	s.Sweep(time.Now())
	if a := call(t, srv.URL, "GET", "/effects/e1", "", key); a.status != http.StatusOK {
		t.Fatalf("dropped before Retain: %d", a.status)
	}
	s.Sweep(time.Now().Add(11 * time.Minute))
	if a := call(t, srv.URL, "GET", "/effects/e1", "", key); a.status != http.StatusNotFound {
		t.Fatalf("kept past Retain: %d %s", a.status, a.body)
	}
}

func TestHealthIsUnsignedAndSaysNothingElse(t *testing.T) {
	_, srv := newServer(t, &fakeRunner{release: make(chan struct{})})
	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("got %v %v", resp, err)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "ok" {
		t.Fatalf("got %q", body)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
