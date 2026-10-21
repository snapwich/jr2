package dispatchkind

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

const token = "ops-instance-token/with+chars=="

var held = map[string]string{"ops": token}

func runner(t *testing.T, srv *httptest.Server, names ...string) *Runner {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	roots := x509.NewCertPool()
	if srv.Certificate() != nil {
		roots.AddCert(srv.Certificate())
	}
	return &Runner{
		Secrets: held,
		Config: &secrets.Config{Version: 1, Placement: "instance",
			Targets: []secrets.Target{{Scheme: u.Scheme, Host: u.Hostname(), Port: port, Secrets: names}}},
		Scrubber: scrub.New(held),
		Roots:    roots,
		Poll:     10 * time.Millisecond,
	}
}

func request(base, workflow string, wait bool) *wire.StartRequest {
	return &wire.StartRequest{
		Kind:     wire.KindDispatch,
		URL:      wire.Text{{Text: &base}},
		Workflow: workflow,
		Input:    json.RawMessage(`{"ticket":"PROJ-7"}`),
		Auth:     &wire.Auth{Bearer: &wire.SecretRef{Secret: "ops"}},
		DispatchedBy: &wire.DispatchedBy{Run: "caller-run", Slot: "review", Effect: "ledger-row-1", Depth: 1,
			Instance: "caller-instance"},
		Wait:      &wait,
		TimeoutMs: 5000,
	}
}

// encoded is every form an output leaves the Effector in.
func encoded(t *testing.T, out wire.Output) string {
	t.Helper()
	raw, err := wire.Encode(out)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func noToken(t *testing.T, out wire.Output) {
	t.Helper()
	s := encoded(t, out)
	for _, leak := range scrub.Forms(token) {
		if strings.Contains(s, leak) {
			t.Fatalf("a form of the token came back: %q in %s", leak, s)
		}
	}
}

// orchestrator is a fake door: one run per key, 201 then 200 on a repeat (ADR-0071).
type orchestrator struct {
	mu      sync.Mutex
	runs    map[string]string // key -> run id
	starts  []*http.Request
	bodies  []string
	polls   atomic.Int32
	status  func(n int32) (int, string) // the poll's answer, by poll number
	refusal func(w http.ResponseWriter) bool
}

func (o *orchestrator) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /workflows/{name}/runs", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		o.mu.Lock()
		o.starts = append(o.starts, r)
		o.bodies = append(o.bodies, string(body))
		o.mu.Unlock()
		if o.refusal != nil && o.refusal(w) {
			return
		}
		var by wire.DispatchedBy
		if err := json.Unmarshal([]byte(r.Header.Get(Header)), &by); err != nil || by.Effect == "" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"jr2-dispatched-by is not JSON"}`)
			return
		}
		o.mu.Lock()
		defer o.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if run, ok := o.runs[by.Effect]; ok {
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, `{"runId":"`+run+`","instanceId":"i-1","existing":true}`)
			return
		}
		run := "run-" + strconv.Itoa(len(o.runs)+1)
		o.runs[by.Effect] = run
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"runId":"`+run+`","instanceId":"i-1"}`)
	})
	mux.HandleFunc("GET /runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		code, body := o.status(o.polls.Add(1))
		w.WriteHeader(code)
		_, _ = io.WriteString(w, body)
	})
	return mux
}

func fake() (*orchestrator, *httptest.Server) {
	o := &orchestrator{runs: map[string]string{}, status: func(int32) (int, string) {
		return 200, `{"runId":"run-1","status":"active"}`
	}}
	return o, httptest.NewServer(o.handler())
}

func TestAStartThenARepeatedKeyAnswerTheSameRun(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	r := runner(t, srv, "ops")
	first := r.Run(context.Background(), request(srv.URL, "review", false))
	again := r.Run(context.Background(), request(srv.URL, "review", false))
	if first.Outcome != wire.OutcomeStarted || first.Run != "run-1" {
		t.Fatalf("got %+v", first)
	}
	if again.Outcome != wire.OutcomeStarted || again.Run != "run-1" || len(o.runs) != 1 {
		t.Fatalf("a repeated key started another run: %+v, runs %v", again, o.runs)
	}
	got := o.starts[0]
	if got.URL.Path != "/workflows/review/runs" || got.Header.Get("Authorization") != "Bearer "+token ||
		got.Header.Get("Content-Type") != "application/json" || o.bodies[0] != `{"ticket":"PROJ-7"}` {
		t.Fatalf("the start is not what the definition built: %s %v %q", got.URL, got.Header, o.bodies[0])
	}
	var by map[string]any
	if err := json.Unmarshal([]byte(got.Header.Get(Header)), &by); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"run": "caller-run", "slot": "review", "effect": "ledger-row-1", "depth": float64(1),
		"instance": "caller-instance"}
	for k, v := range want {
		if by[k] != v {
			t.Fatalf("the header's %s is %v, not %v: %v", k, by[k], v, by)
		}
	}
	noToken(t, first)
}

func TestASlashedNameIsOneEncodedSegment(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	out := runner(t, srv, "ops").Run(context.Background(), request(srv.URL, "task/review-loop", false))
	if out.Outcome != wire.OutcomeStarted {
		t.Fatalf("got %+v", out)
	}
	if uri := o.starts[0].RequestURI; uri != "/workflows/task%2Freview-loop/runs" {
		t.Fatalf("got %s", uri)
	}
}

func TestADoorRefusalIsOutputWithItsStatusAndReport(t *testing.T) {
	cases := []struct {
		code int
		body string
		want []string
	}{
		{422, `{"error":"refused","report":["(chart).states.a: unknown state","(chart): no initial"]}`,
			[]string{"(chart).states.a: unknown state", "(chart): no initial"}},
		{400, `{"error":"invalid input for workflow \"review\""}`, []string{`invalid input for workflow "review"`}},
		{404, `{"error":"no workflow \"review\""}`, []string{`no workflow "review"`}},
		{409, `not json`, []string{"the door answered 409 Conflict"}},
		// The door echoing the token back: the report is scrubbed.
		{401, `{"error":"token ` + token + ` is not this Instance's"}`, []string{"token [secret:ops] is not this Instance's"}},
	}
	for _, c := range cases {
		o, srv := fake()
		o.refusal = func(w http.ResponseWriter) bool {
			w.WriteHeader(c.code)
			_, _ = io.WriteString(w, c.body)
			return true
		}
		out := runner(t, srv, "ops").Run(context.Background(), request(srv.URL, "review", true))
		srv.Close()
		if out.Outcome != wire.OutcomeRefused || out.HTTPStatus != c.code || strings.Join(out.Report, "|") !=
			strings.Join(c.want, "|") {
			t.Fatalf("%d: got %+v", c.code, out)
		}
		noToken(t, out)
		if o.polls.Load() != 0 {
			t.Fatalf("%d: a refused start was polled", c.code)
		}
	}
}

func TestAWaitSettlesOnTheThirdPollWithTheRunsOutput(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	o.status = func(n int32) (int, string) {
		if n < 3 {
			return 200, `{"runId":"run-1","status":"active","context":{"x":1}}`
		}
		// The callee's output echoes the token, as a value and as a key: it leaves scrubbed.
		return 200, `{"runId":"run-1","status":"done","output":{"verdict":"approve","score":0.9,` +
			`"note":"saw ` + token + `","` + token + `":[1,null,true],"big":12345678901234567890}}`
	}
	out := runner(t, srv, "ops").Run(context.Background(), request(srv.URL, "review", true))
	if out.Outcome != wire.OutcomeSettled || out.Run != "run-1" || out.Status != "done" || o.polls.Load() != 3 {
		t.Fatalf("got %+v after %d polls", out, o.polls.Load())
	}
	var got map[string]any
	if err := json.Unmarshal(out.Result, &got); err != nil {
		t.Fatal(err)
	}
	if got["verdict"] != "approve" || got["note"] != "saw [secret:ops]" || got["[secret:ops]"] == nil {
		t.Fatalf("the output is not the callee's, scrubbed: %s", out.Result)
	}
	if !strings.Contains(string(out.Result), "12345678901234567890") || !strings.Contains(string(out.Result), "0.9") {
		t.Fatalf("a number changed: %s", out.Result)
	}
	noToken(t, out)
	// Through the wire as the server sends it, and back.
	var back wire.Output
	if err := json.Unmarshal([]byte(encoded(t, out)), &back); err != nil || back.Status != "done" {
		t.Fatalf("got %+v, %v", back, err)
	}
}

func TestAWaitOutlivesAnOrchestratorThatAnswers5xx(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	o.status = func(n int32) (int, string) {
		if n == 1 {
			return 503, `{"error":"restarting"}`
		}
		return 200, `{"runId":"run-1","status":"error"}`
	}
	out := runner(t, srv, "ops").Run(context.Background(), request(srv.URL, "review", true))
	if out.Outcome != wire.OutcomeSettled || out.Status != "error" || out.Result != nil {
		t.Fatalf("got %+v", out)
	}
}

func TestAWaitTimeoutSettlesLive(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	req := request(srv.URL, "review", true)
	req.TimeoutMs = 120
	out := runner(t, srv, "ops").Run(context.Background(), req)
	if out.Outcome != wire.OutcomeSettled || out.Run != "run-1" || out.Status != "live" || o.polls.Load() == 0 {
		t.Fatalf("got %+v after %d polls", out, o.polls.Load())
	}
}

func TestAPollThatIsRefusedIsUnknownNamingThePoll(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	o.status = func(int32) (int, string) { return 404, `{"error":"no run"}` }
	out := runner(t, srv, "ops").Run(context.Background(), request(srv.URL, "review", true))
	if out.Outcome != wire.OutcomeUnknown || !strings.Contains(out.Reason, "the poll of run run-1 answered 404: no run") {
		t.Fatalf("got %+v", out)
	}
}

func TestAHostNotPlacedHereIsRefusedAndNothingIsSent(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	r := runner(t, srv, "ops")
	r.Config.Targets[0].Port++
	out := r.Run(context.Background(), request(srv.URL, "review", false))
	if out.Outcome != wire.OutcomeRefused || out.HTTPStatus != 0 || len(out.Report) != 1 ||
		!strings.Contains(out.Report[0], "is not a host an Effect placed here names") || len(o.starts) != 0 {
		t.Fatalf("got %+v; %d starts", out, len(o.starts))
	}
	// Placed with another secret: the token may not go there either.
	r = runner(t, srv, "other")
	if out := r.Run(context.Background(), request(srv.URL, "review", false)); out.Outcome != wire.OutcomeRefused {
		t.Fatalf("got %+v", out)
	}
}

func TestADeadTargetIsUnreachable(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &httptest.Server{URL: "http://" + ln.Addr().String()}
	_ = ln.Close()
	out := runner(t, srv, "ops").Run(context.Background(), request(srv.URL, "review", false))
	if out.Outcome != wire.OutcomeUnreachable || !strings.Contains(out.Reason, "nothing was started") {
		t.Fatalf("got %+v", out)
	}
}

func TestAStartWithNoAnswerIsUnknown(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	}))
	defer srv.Close()
	r := runner(t, srv, "ops")
	r.Retry = 10 * time.Millisecond
	req := request(srv.URL, "review", false)
	req.TimeoutMs = 300
	out := r.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeUnknown || !strings.Contains(out.Reason, "may have reached the Orchestrator") ||
		!strings.Contains(out.Reason, "times under its key") {
		t.Fatalf("got %+v", out)
	}
}

// The hop the key is for (ADR-0071): the door started the run, and its answer was lost. The start
// is sent again under the same key, and the door answers it with that run: one run.
func TestALostAnswerIsSentAgainUnderItsKeyAndFindsTheRun(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	var lose atomic.Int32
	lose.Store(1)
	inner := o.handler()
	srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && lose.Add(-1) == 0 {
			// The run starts; the answer never comes back.
			inner.ServeHTTP(httptest.NewRecorder(), r)
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
			return
		}
		inner.ServeHTTP(w, r)
	})
	r := runner(t, srv, "ops")
	r.Retry = 10 * time.Millisecond
	out := r.Run(context.Background(), request(srv.URL, "review", false))
	if out.Outcome != wire.OutcomeStarted || out.Run != "run-1" || len(o.runs) != 1 || len(o.starts) != 2 {
		t.Fatalf("got %+v, runs %v, %d starts", out, o.runs, len(o.starts))
	}
}

func TestA5xxIsSentAgainUnderItsKey(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	var fails atomic.Int32
	fails.Store(2)
	o.refusal = func(w http.ResponseWriter) bool {
		if fails.Add(-1) < 0 {
			return false
		}
		w.WriteHeader(http.StatusBadGateway)
		return true
	}
	r := runner(t, srv, "ops")
	r.Retry = 10 * time.Millisecond
	out := r.Run(context.Background(), request(srv.URL, "review", false))
	if out.Outcome != wire.OutcomeStarted || out.Run != "run-1" || len(o.starts) != 3 {
		t.Fatalf("got %+v after %d starts", out, len(o.starts))
	}
}

func TestAWaitNamesItsRunBeforeItSettles(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	o.status = func(n int32) (int, string) {
		if n < 2 {
			return 200, `{"runId":"run-1","status":"active"}`
		}
		return 200, `{"runId":"run-1","status":"done"}`
	}
	var named atomic.Value
	ctx := wire.WithStarted(context.Background(), func(run string) { named.Store(run) })
	out := runner(t, srv, "ops").Run(ctx, request(srv.URL, "review", true))
	if out.Outcome != wire.OutcomeSettled || named.Load() != "run-1" {
		t.Fatalf("got %+v, named %v", out, named.Load())
	}
}

func TestOverTLSTheTokenNeverComesBack(t *testing.T) {
	// The door answers 201 with a run id that holds the token, then a settled run whose status and
	// output hold it in its encodings: every output form is scrubbed.
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]string{"runId": "run-" + url.PathEscape(token)})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "done", "output": map[string]any{
			"auth": auth, "forms": scrub.Forms(token)}})
	}))
	defer srv.Close()
	out := runner(t, srv, "ops").Run(context.Background(), request(srv.URL, "review", true))
	if out.Outcome != wire.OutcomeSettled || out.Status != "done" {
		t.Fatalf("got %+v", out)
	}
	noToken(t, out)
	if !strings.Contains(string(out.Result), `"auth":"[secret:ops]"`) {
		t.Fatalf("the built Authorization is not named: %s", out.Result)
	}
}

func TestMissingNamesASecretNotHeld(t *testing.T) {
	_, srv := fake()
	defer srv.Close()
	req := request(srv.URL, "review", false)
	req.Auth.Bearer.Secret = "nope"
	if got := runner(t, srv, "ops").Missing(req); got != "nope" {
		t.Fatalf("got %q", got)
	}
}

// The first poll comes as the start returns, not one Poll later: a wait whose bound is shorter
// than the interval still reads the run, and a run already done settles `done` with its output.
func TestAWaitPollsAtOnceWithTheDefaultInterval(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	o.status = func(int32) (int, string) { return 200, `{"runId":"run-1","status":"done","output":{"a":1}}` }
	r := runner(t, srv, "ops")
	r.Poll = 0
	req := request(srv.URL, "review", true)
	req.TimeoutMs = 300
	out := r.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeSettled || out.Status != "done" || string(out.Result) != `{"a":1}` ||
		o.polls.Load() != 1 {
		t.Fatalf("got %+v after %d polls", out, o.polls.Load())
	}
}

// A run seen live, and live again at the bound: the last poll read it, so the wait settles `live`.
// With the default interval, the bound's last poll is the second read.
func TestAWaitAtItsBoundReadsTheRunOnceMore(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	r := runner(t, srv, "ops")
	r.Poll = 0
	req := request(srv.URL, "review", true)
	req.TimeoutMs = 300
	out := r.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeSettled || out.Status != "live" || o.polls.Load() != 2 {
		t.Fatalf("got %+v after %d polls", out, o.polls.Load())
	}
}

// A target gone after the start: no poll reads the run, so its status is not known — `unknown`,
// naming the poll and the run, never `live` (ADR-0071).
func TestAWaitWhoseTargetWentAwayIsUnknownNamingThePoll(t *testing.T) {
	o, srv := fake()
	inner := o.handler()
	srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		inner.ServeHTTP(w, req)
		if req.Method == http.MethodPost {
			go func() { _ = srv.Listener.Close() }()
		}
	})
	defer srv.Close()
	req := request(srv.URL, "review", true)
	req.TimeoutMs = 400
	out := runner(t, srv, "ops").Run(context.Background(), req)
	if out.Outcome != wire.OutcomeUnknown || !strings.Contains(out.Reason, "the last poll of it got no answer") ||
		!strings.Contains(out.Reason, "run run-1") || !strings.Contains(out.Reason, "its status is not known") {
		t.Fatalf("got %+v", out)
	}
}

// The last poll answered 5xx: the run was seen live before, and its status at the bound is not known.
func TestAWaitWhoseLastPollFailedIsUnknown(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	o.status = func(n int32) (int, string) {
		if n == 1 {
			return 200, `{"runId":"run-1","status":"active"}`
		}
		return 503, `{"error":"restarting"}`
	}
	req := request(srv.URL, "review", true)
	req.TimeoutMs = 150
	out := runner(t, srv, "ops").Run(context.Background(), req)
	if out.Outcome != wire.OutcomeUnknown || !strings.Contains(out.Reason, "answered 503: restarting") {
		t.Fatalf("got %+v", out)
	}
}

// A stop (the state exited, ADR-0071) ends the wait at once: no poll after it, and the run goes on.
func TestAStoppedWaitEndsAndPollsNoMore(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	ctx, stop := context.WithCancelCause(context.Background())
	done := make(chan wire.Output, 1)
	go func() { done <- runner(t, srv, "ops").Run(ctx, request(srv.URL, "review", true)) }()
	for o.polls.Load() < 2 {
		time.Sleep(5 * time.Millisecond)
	}
	stop(wire.ErrStopped)
	var out wire.Output
	select {
	case out = <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the stop did not end the wait")
	}
	if out.Outcome != wire.OutcomeUnknown || !strings.Contains(out.Reason, "was stopped") {
		t.Fatalf("got %+v", out)
	}
	polls := o.polls.Load()
	time.Sleep(50 * time.Millisecond)
	if o.polls.Load() != polls {
		t.Fatal("a stopped wait polls on")
	}
}

// A run whose context is past the bytes an output may hold is still read: a poll keeps only its
// status and output.
func TestAPollReadsPastALargeContext(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	big := strings.Repeat("x", maxAnswer+1)
	o.status = func(int32) (int, string) {
		return 200, `{"runId":"run-1","context":{"log":"` + big + `","n":[1,{"a":[]}]},"status":"done",` +
			`"output":{"ok":true},"children":[]}`
	}
	out := runner(t, srv, "ops").Run(context.Background(), request(srv.URL, "review", true))
	if out.Outcome != wire.OutcomeSettled || out.Status != "done" || string(out.Result) != `{"ok":true}` {
		t.Fatalf("got %+v", out)
	}
	// An output past the bound is not read whole.
	o.status = func(int32) (int, string) { return 200, `{"status":"done","output":"` + big + `"}` }
	out = runner(t, srv, "ops").Run(context.Background(), request(srv.URL, "review", true))
	if out.Outcome != wire.OutcomeUnknown || !strings.Contains(out.Reason, "output is more than") {
		t.Fatalf("got %+v", out)
	}
}

// The header is ASCII: Node reads a header's bytes as latin1, so each rune past 0x7F rides as a
// JSON escape and the door reads the slot it was sent.
func TestTheHeaderIsASCIIAndKeepsANonASCIISlot(t *testing.T) {
	o, srv := fake()
	defer srv.Close()
	req := request(srv.URL, "review", false)
	req.DispatchedBy.Slot = "révision-😀"
	if out := runner(t, srv, "ops").Run(context.Background(), req); out.Outcome != wire.OutcomeStarted {
		t.Fatalf("got %+v", out)
	}
	raw := o.starts[0].Header.Get(Header)
	for i := 0; i < len(raw); i++ {
		if raw[i] >= 0x80 {
			t.Fatalf("the header is not ASCII: %q", raw)
		}
	}
	var by wire.DispatchedBy
	if err := json.Unmarshal([]byte(raw), &by); err != nil || by.Slot != "révision-😀" {
		t.Fatalf("got %+v, %v from %q", by, err, raw)
	}
}
