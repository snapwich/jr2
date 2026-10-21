// Package server is the Effector's wire (ADR-0068): `POST /effects/<id>` starts an Effect and
// answers at once; a second POST with the same id starts nothing and attaches to the one that
// runs. `GET /effects/<id>` long-polls for its outcome. `DELETE /effects/<id>` stops a credentialed
// command whose state exited (ADR-0067): its process group gets SIGTERM, then SIGKILL past a
// grace, and the answer is its outcome, as a poll's. It stops a dispatch's wait the same way
// (ADR-0071): the poll of the run ends, and the run it started is never touched. A push and an
// http Effect are one request each and end on their own, so a DELETE on one answers as an unknown
// method does. Every request
// is verified before anything else — an unsigned, mis-signed or replayed request gets 401 and an
// empty body, so it learns nothing, not even whether an Effect exists — and every answer is
// scrubbed, then signed.
//
// Replica-aware: an answer names the replica (its pod) that holds the Effect, and a poll to
// a replica that does not hold it says so (`state: unknown`, with that replica's name). A replica
// that is stopping refuses new Effects (503), finishes the ones in flight, and stays up until each
// outcome was read or its drain time is spent. A result nobody polls is dropped after a while: the
// Orchestrator stops polling when the state that asked has exited.
package server

import (
	"context"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/sign"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// Runner runs one Effect to its outcome.
type Runner interface {
	// Missing names a secret the request needs that this Effector does not hold, or "".
	Missing(req *wire.StartRequest) string
	// Pin fixes the commit a push or a credentialed command runs against, before the start is
	// answered, and answers it ("" for a kind that runs against none).
	Pin(req *wire.StartRequest) string
	Run(ctx context.Context, req *wire.StartRequest) wire.Output
}

// Options configure a Server.
type Options struct {
	Verifier *sign.Verifier
	Runner   Runner
	// Scrubber is the last pass over every answer's bytes before it is signed.
	Scrubber *scrub.Scrubber
	Replica  wire.Replica
	// Hold is how long a poll waits for an outcome before it answers `running` (about 25 s).
	Hold time.Duration
	// Retain is how long a settled outcome is kept for a poll that has not come.
	Retain time.Duration
	// Log receives one line per decision; never a value, a path, a header or a body.
	Log *log.Logger
}

// maxRequestBody is the most bytes of a request this replica reads (ADR-0068). A longer body cannot
// be verified, so it is refused as unsigned; the Orchestrator never sends one (its MAX_START_BYTES
// is this number, and a longer start settles `refused` with nothing sent).
const maxRequestBody = 4 << 20

type effect struct {
	kind, method, host string
	pinned             string
	// run is the run a dispatch started, once the door answered (ADR-0071); named closes then.
	run       string
	named     chan struct{}
	done      chan struct{}
	output    *wire.Output
	settledAt time.Time
	read      bool
	// stop cancels the run with wire.ErrStopped: a credentialed command's or a dispatch's stop route.
	stop context.CancelCauseFunc
	// early is a stop of an id this replica did not hold: a credentialed command's start still on
	// the wire. A command start with its id runs nothing; it is kept past the signing window.
	early bool
}

// Server is one replica's Effects.
type Server struct {
	opts Options

	mu       sync.Mutex
	effects  map[string]*effect
	stopping bool
	changed  chan struct{}
}

// New builds a Server.
func New(opts Options) *Server {
	if opts.Hold == 0 {
		opts.Hold = 25 * time.Second
	}
	if opts.Retain == 0 {
		opts.Retain = 10 * time.Minute
	}
	if opts.Log == nil {
		opts.Log = log.New(io.Discard, "", 0)
	}
	return &Server{opts: opts, effects: map[string]*effect{}, changed: make(chan struct{})}
}

// methodsRefusal is the 405's text: the methods an Effect's path takes. DELETE is the stop route,
// a credentialed command's (ADR-0067) and a dispatch's wait's (ADR-0071).
const methodsRefusal = "POST or GET; DELETE stops a credentialed command or a dispatch's wait"

// ServeHTTP is the wire.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// The kubelet's probe: unsigned, and it says only whether this replica takes new Effects.
	if r.URL.Path == "/healthz" && r.Method == http.MethodGet {
		if s.isStopping() {
			http.Error(w, "stopping", http.StatusServiceUnavailable)
			return
		}
		_, _ = io.WriteString(w, "ok")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody+1))
	path := r.URL.RequestURI()
	nonce := r.Header.Get(sign.HeaderNonce)
	if err != nil || len(body) > maxRequestBody ||
		s.opts.Verifier.Verify(r.Method, path, r.Header.Get(sign.HeaderTime), nonce,
			r.Header.Get(sign.HeaderSignature), body) != nil {
		// Before routing, so a refused caller learns nothing about which Effects exist.
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	reply := func(status int, v any) { s.reply(w, status, r.Method, path, nonce, v) }

	id, ok := strings.CutPrefix(r.URL.Path, "/effects/")
	if !ok || !wire.ValidEffectID(id) || r.URL.RawQuery != "" {
		reply(http.StatusNotFound, wire.Refusal{Error: "no such route"})
		return
	}
	switch r.Method {
	case http.MethodPost:
		s.start(r.Context(), reply, id, body)
	case http.MethodGet:
		s.poll(r.Context(), reply, id)
	case http.MethodDelete:
		s.stop(r.Context(), reply, id)
	default:
		reply(http.StatusMethodNotAllowed, wire.Refusal{Error: methodsRefusal})
	}
}

// stop is the stop route: a credentialed command's run is cancelled with wire.ErrStopped, and the
// answer is a poll's — its outcome once it settled, within the hold. Its outcome counts as read:
// nobody polls a stopped Effect. A dispatch is cancelled the same way: its wait, a poll of the
// door with the target's token, ends there, and nothing is sent to the callee, so the run goes on
// (ADR-0071). A push or an http Effect has no stop: one request each, they end
// on their own, and a DELETE on one answers as an unknown method does. A DELETE of an id this
// replica does not hold answers so, and is kept: a fast exit can send the stop while the command's
// start is still on the wire, and that start, when it arrives, runs nothing (ADR-0067).
func (s *Server) stop(ctx context.Context, reply func(int, any), id string) {
	s.mu.Lock()
	e, ok := s.effects[id]
	if !ok {
		done := make(chan struct{})
		close(done)
		s.effects[id] = &effect{kind: wire.KindCommand, host: "-", done: done, early: true, read: true,
			output:    &wire.Output{Outcome: wire.OutcomeUnknown, Reason: wire.StoppedBeforeStart},
			settledAt: time.Now(), stop: func(error) {}}
		s.notify()
	}
	s.mu.Unlock()
	if !ok {
		s.opts.Log.Printf("jr2.effector action=stop-kept effect=%s", id)
		reply(http.StatusNotFound, wire.EffectState{Effect: id, Replica: s.opts.Replica, State: wire.StateUnknown})
		return
	}
	if e.kind != wire.KindCommand && e.kind != wire.KindDispatch {
		reply(http.StatusMethodNotAllowed, wire.Refusal{Error: methodsRefusal})
		return
	}
	s.opts.Log.Printf("jr2.effector action=stop effect=%s", id)
	e.stop(wire.ErrStopped)
	s.poll(ctx, reply, id)
}

// reply scrubs the answer's bytes, signs them, and writes them.
func (s *Server) reply(w http.ResponseWriter, status int, method, path, nonce string, v any) {
	raw, err := wire.Encode(v)
	if err != nil {
		status = http.StatusInternalServerError
		raw = []byte(`{"error":"the answer could not be encoded"}`)
	}
	raw = s.opts.Scrubber.Bytes(raw)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set(sign.HeaderSignature, sign.ResponseMAC(s.opts.Verifier.Key(), status, method, path, nonce, raw))
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func (s *Server) start(_ context.Context, reply func(int, any), id string, body []byte) {
	var req wire.StartRequest
	if err := wire.Decode(strings.NewReader(string(body)), &req); err != nil {
		reply(http.StatusBadRequest, wire.Refusal{Error: "the request is malformed: " + err.Error()})
		return
	}
	if err := req.Validate(); err != nil {
		reply(http.StatusBadRequest, wire.Refusal{Error: "the request is malformed: " + err.Error()})
		return
	}
	if name := s.opts.Runner.Missing(&req); name != "" {
		reply(http.StatusBadRequest, wire.Refusal{
			Error: "the request names secret " + name + ", which this Effector does not hold — `jr2 up` places a " +
				"secret where an Effect names it (ADR-0068)",
		})
		return
	}

	s.mu.Lock()
	if e, ok := s.effects[id]; ok && e.early && req.Kind != wire.KindCommand {
		// A kept stop runs nothing only for a credentialed command. Another kind's start runs as it
		// is, except a dispatch's: its stop is of its wait, so the run is started and not waited for —
		// the start may be the one that reached the door, and the key answers it (ADR-0071).
		delete(s.effects, id)
		if req.Kind == wire.KindDispatch {
			req.Wait = new(bool)
		}
	}
	if e, ok := s.effects[id]; ok {
		// A second POST with the same id starts nothing: it attaches. A command start after its kept
		// stop attaches to the stop's outcome: it did not run.
		state := s.stateOf(id, e)
		s.mu.Unlock()
		reply(http.StatusOK, state)
		return
	}
	if s.stopping {
		s.mu.Unlock()
		reply(http.StatusServiceUnavailable, wire.Refusal{Error: "stopping", Replica: &s.opts.Replica})
		return
	}
	// Not the request's context: the Effect runs to its outcome whoever is listening, until it
	// settles or a stop cancels it.
	run, stop := context.WithCancelCause(context.Background())
	e := &effect{kind: req.Kind, method: req.Method, host: hostOf(&req), done: make(chan struct{}),
		named: make(chan struct{}), stop: stop}
	// A dispatch names its run before its wait ends: the `running` state carries it from then on,
	// so the Orchestrator's ledger names the callee during the wait (ADR-0071).
	run = wire.WithStarted(run, func(id string) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if e.run != "" || id == "" {
			return
		}
		e.run = id
		close(e.named)
		s.notify()
	})
	s.effects[id] = e
	// Read before the answer, so the Orchestrator writes the commit to the intent row: a restore
	// repeats only that commit.
	e.pinned = s.opts.Runner.Pin(&req)
	state := s.stateOf(id, e)
	s.mu.Unlock()

	s.opts.Log.Printf("jr2.effector action=start effect=%s kind=%s method=%s host=%s", id, e.kind, e.method, e.host)
	go func() {
		out := s.opts.Runner.Run(run, &req)
		stop(nil)
		s.mu.Lock()
		e.output = &out
		e.settledAt = time.Now()
		close(e.done)
		s.notify()
		s.mu.Unlock()
		status := ""
		if out.Response != nil {
			status = " status=" + strconv.Itoa(out.Response.Status)
		}
		s.opts.Log.Printf("jr2.effector action=settle effect=%s outcome=%s%s", id, out.Outcome, status)
	}()
	reply(http.StatusAccepted, state)
}

func (s *Server) poll(ctx context.Context, reply func(int, any), id string) {
	s.mu.Lock()
	e, ok := s.effects[id]
	// A poll that does not yet know the dispatch's run is answered when it is named, not at the
	// hold: one answer per change, so a poll that knows it waits for the outcome.
	var named <-chan struct{}
	if ok && e.run == "" {
		named = e.named
	}
	s.mu.Unlock()
	if !ok {
		// Not here: the Effect is another replica's, or this one restarted.
		reply(http.StatusNotFound, wire.EffectState{Effect: id, Replica: s.opts.Replica, State: wire.StateUnknown})
		return
	}
	hold := time.NewTimer(s.opts.Hold)
	defer hold.Stop()
	select {
	case <-e.done:
	case <-named:
	case <-hold.C:
	case <-ctx.Done():
		return
	}
	s.mu.Lock()
	state := s.stateOf(id, e)
	if e.output != nil {
		e.read = true
		s.notify()
	}
	s.mu.Unlock()
	reply(http.StatusOK, state)
}

// stateOf is one Effect's answer. Called with mu held.
func (s *Server) stateOf(id string, e *effect) wire.EffectState {
	state := wire.EffectState{Effect: id, Replica: s.opts.Replica, State: wire.StateRunning, Pinned: e.pinned,
		Run: e.run}
	if e.output != nil {
		state.State = wire.StateSettled
		state.Output = e.output
	}
	return state
}

// notify wakes whoever waits on a change. Called with mu held.
func (s *Server) notify() {
	close(s.changed)
	s.changed = make(chan struct{})
}

func (s *Server) isStopping() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopping
}

// Sweep drops every outcome settled longer ago than Retain: nobody polled it. A stop kept for an id
// this replica did not hold stays at least twice the signing window: a start signed before it is
// refused by its time past that, so none can run after the stop is dropped.
func (s *Server) Sweep(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, e := range s.effects {
		retain := s.opts.Retain
		if e.early {
			retain = max(retain, 2*sign.Window)
		}
		if e.output != nil && now.Sub(e.settledAt) > retain {
			delete(s.effects, id)
			if !e.read {
				s.opts.Log.Printf("jr2.effector action=drop effect=%s reason=unread", id)
			}
		}
	}
}

// Drain refuses new Effects, then waits until every Effect here has settled and its outcome was
// read — or until ctx ends (the pod's grace period, less a margin).
func (s *Server) Drain(ctx context.Context) {
	s.mu.Lock()
	s.stopping = true
	s.mu.Unlock()
	s.opts.Log.Printf("jr2.effector action=drain")
	for {
		s.mu.Lock()
		waiting := 0
		for _, e := range s.effects {
			if e.output == nil || !e.read {
				waiting++
			}
		}
		changed := s.changed
		s.mu.Unlock()
		if waiting == 0 {
			return
		}
		select {
		case <-changed:
		case <-ctx.Done():
			s.opts.Log.Printf("jr2.effector action=drain-ended waiting=%d", waiting)
			return
		}
	}
}

func hostOf(req *wire.StartRequest) string {
	// The host is the url's literal head: a secret never sits before the path (the constructor
	// refuses one there), so this logs no value. A dispatch's url is its target's origin, one text
	// part (ADR-0071), so its head is that host.
	if req.Kind == wire.KindPush || req.Kind == wire.KindCommand {
		return "-"
	}
	if len(req.URL) == 0 || req.URL[0].Text == nil {
		return "?"
	}
	head := *req.URL[0].Text
	if i := strings.Index(head, "://"); i >= 0 {
		head = head[i+3:]
	}
	if i := strings.IndexAny(head, "/?#"); i >= 0 {
		head = head[:i]
	}
	return head
}
