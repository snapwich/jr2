// Package dispatchkind runs the `dispatch` kind (ADR-0071) in the Instance Effector: a run of a
// Workflow started on another Orchestrator through its door, `POST <url>/workflows/<name>/runs`,
// with the target's Instance token, which this Effector holds as an Effect secret and the author
// never sees. With `wait`, it then polls `GET <url>/runs/<id>` until that run ends or the
// Effect's timeout passes.
//
// The caller's ledger row id rides every start in the `jr2-dispatched-by` header, so a start sent
// again (an Effector rollout, a lost answer) gets the run the first one started (ADR-0071): the
// TS driver treats every dispatch as idempotent, and this runner holds no state of its own.
//
// Every outcome is output (ADR-0067): `started`; `settled` with the run's status and its
// Machine's output; `refused` with the door's status and report (or status 0, when the Effector
// refused it before anything was sent); `unreachable` (nothing was sent); `unknown` (the start
// may have reached the door, and no answer came in the whole bound, though it was sent again under
// its key; or a poll failed after the start, or no poll read the run at the wait's bound). A
// wait settles `live` only for a run its last poll read live. A stop (DELETE, its state exited)
// ends the wait and never touches the run. A secret this
// Effector does not hold is no outcome: the server refuses the request before it starts.
package dispatchkind

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf16"

	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// Header carries the caller's DispatchedBy to the door (ADR-0071): out of band, never a body
// field the callee's door would have to reserve. registration.ts's DISPATCHED_BY_HEADER.
const Header = "jr2-dispatched-by"

// DefaultPoll is how often a wait reads the run (ADR-0071, the brief's D-G).
const DefaultPoll = 5 * time.Second

// maxAnswer is the most bytes of a start's answer the runner reads, and of a polled run's output:
// a poll reads only the run's `status` and `output` out of what `GET /runs/<id>` serves, so a run
// whose context is large is still read (ADR-0071).
const maxAnswer = 4 << 20

// maxPoll is the most bytes of one poll's answer the runner reads: its context and the rest are
// read past, never kept, and this bounds a door that does not end its answer.
const maxPoll = 256 << 20

// lastPoll is the most of the bound a wait keeps back for its last poll: at the bound, the wait
// reads the run once more, so it settles `live` only for a run it saw live (ADR-0071).
const lastPoll = 2 * time.Second

// Runner runs dispatch Effects for one Effector.
type Runner struct {
	Secrets  map[string]string
	Config   *secrets.Config
	Scrubber *scrub.Scrubber
	// Roots is the trust: the system roots plus the instance's caBundle (ADR-0020).
	Roots *x509.CertPool
	// Poll is how often a wait reads the run; zero is DefaultPoll.
	Poll time.Duration
	// Retry is the first pause before a start whose answer was lost is sent again under its key;
	// it doubles to MaxRetry. Zero is DefaultRetry.
	Retry time.Duration
}

// DefaultRetry and MaxRetry bound the pauses between the sends of one start (ADR-0071).
const (
	DefaultRetry = 500 * time.Millisecond
	MaxRetry     = 5 * time.Second
)

// Missing names the first secret req names that the Effector does not hold — a defect, refused
// before the Effect starts.
func (r *Runner) Missing(req *wire.StartRequest) string {
	for _, name := range req.Secrets() {
		if _, ok := r.Secrets[name]; !ok {
			return name
		}
	}
	return ""
}

// Run starts the run, waits for it when the start says so, and answers the outcome, scrubbed:
// every string of it, the callee's output included, since a callee could echo the token back.
func (r *Runner) Run(ctx context.Context, req *wire.StartRequest) wire.Output {
	built := map[string]string{}
	out := r.run(ctx, req, built)
	s := r.Scrubber.With(built)
	out.Reason = s.String(out.Reason)
	out.Run = s.String(out.Run)
	out.Status = s.String(out.Status)
	for i, line := range out.Report {
		out.Report[i] = s.String(line)
	}
	if out.Result != nil {
		out.Result = scrubJSON(s, out.Result)
	}
	return out
}

// refused is a start the Effector or the door refused: nothing was started.
func refused(status int, report ...string) wire.Output {
	return wire.Output{Outcome: wire.OutcomeRefused, HTTPStatus: status, Report: report}
}

func unknown(reason string) wire.Output {
	return wire.Output{Outcome: wire.OutcomeUnknown, Reason: reason}
}

func (r *Runner) run(ctx context.Context, req *wire.StartRequest, built map[string]string) wire.Output {
	base, err := r.origin(req)
	if err != nil {
		return refused(0, err.Error()+"; nothing was sent")
	}
	name := req.Auth.Bearer.Secret
	auth := "Bearer " + r.Secrets[name]
	built[auth] = name
	by, err := wire.Encode(req.DispatchedBy)
	if err != nil {
		return refused(0, fmt.Sprintf("dispatchedBy could not be encoded: %v; nothing was sent", err))
	}
	by = ascii(by)

	// One timeout bounds the whole Effect: the start alone, or the start and the wait.
	ctx, cancel := context.WithTimeout(ctx, time.Duration(req.TimeoutMs)*time.Millisecond)
	defer cancel()
	run, out, ok := r.start(ctx, base, req, auth, string(by))
	if !ok {
		if stopped(ctx) {
			return unknown("the dispatch was stopped while its start was sent: its state exited; a run may have started")
		}
		return out
	}
	if req.Wait == nil || !*req.Wait {
		return wire.Output{Outcome: wire.OutcomeStarted, Run: run}
	}
	// The run is named before the wait: the Orchestrator's ledger names it while the wait runs.
	wire.Started(ctx, run)
	return r.wait(ctx, base, run, auth)
}

// origin is the target's origin, checked against what `jr2 up` placed here: the token may go to
// that host alone.
func (r *Runner) origin(req *wire.StartRequest) (string, error) {
	if len(req.URL) != 1 || req.URL[0].Text == nil {
		return "", errors.New("the url is not one text part")
	}
	u, err := url.Parse(*req.URL[0].Text)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("the url is not an origin: http(s)://host[:port]")
	}
	port := 443
	if u.Scheme == "http" {
		port = 80
	}
	if p := u.Port(); p != "" {
		if port, err = strconv.Atoi(p); err != nil {
			return "", errors.New("the url's port is not a number")
		}
	}
	if !r.Config.Allows(u.Scheme, u.Hostname(), port, req.Secrets()) {
		return "", fmt.Errorf("%s://%s is not a host an Effect placed here names with this token", u.Scheme, u.Host)
	}
	return u.Scheme + "://" + u.Host, nil
}

// sent is what one send of a start came to.
type sent int

const (
	answered sent = iota // the door named the run
	ended                // an outcome that ends the Effect: a refusal, or nothing could be sent
	notSent              // no connection: nothing reached the door
	noAnswer             // connected, and no run came back: a run may have started
)

// start sends the start, and sends it again under its key while its answer is lost — no answer, a
// 5xx, or a 2xx with no run id — until the timeout passes: the key makes the door answer a repeat
// with the run it started (ADR-0071), so the outcome is `unknown` only when no answer came in the
// whole bound. A start that never connected, the first time, is `unreachable`: nothing was started.
// It answers the run id, or the outcome that ends the Effect.
func (r *Runner) start(ctx context.Context, base string, req *wire.StartRequest, auth, by string) (
	string, wire.Output, bool) {
	pause := r.Retry
	if pause <= 0 {
		pause = DefaultRetry
	}
	var lost *wire.Output
	for sends := 1; ; sends++ {
		run, out, what := r.send(ctx, base, req, auth, by)
		switch what {
		case answered:
			return run, wire.Output{}, true
		case ended:
			return "", out, false
		case notSent:
			if lost == nil {
				return "", out, false
			}
		case noAnswer:
			lost = &out
		}
		select {
		case <-ctx.Done():
			out := *lost
			out.Reason += fmt.Sprintf(" (sent %d times under its key)", sends)
			return "", out, false
		case <-time.After(pause):
		}
		pause = min(pause*2, MaxRetry)
	}
}

// send sends the start once.
func (r *Runner) send(ctx context.Context, base string, req *wire.StartRequest, auth, by string) (
	string, wire.Output, sent) {
	// A slashed name (a named Chart) is one percent-encoded segment: the door reads
	// `/workflows/<wrapper>%2F<name>/runs` as `/workflows/<wrapper>/charts/<name>/runs`.
	target := base + "/workflows/" + url.PathEscape(req.Workflow) + "/runs"
	var connected atomic.Bool
	traced := httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		GotConn: func(httptrace.GotConnInfo) { connected.Store(true) },
	})
	hreq, err := http.NewRequestWithContext(traced, http.MethodPost, target, bytes.NewReader(req.Input))
	if err != nil {
		return "", refused(0, fmt.Sprintf("the start could not be built: %v; nothing was sent", err)), ended
	}
	hreq.Header.Set("Authorization", auth)
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set(Header, by)
	resp, err := r.client().Do(hreq)
	if err != nil {
		if !connected.Load() {
			return "", wire.Output{Outcome: wire.OutcomeUnreachable, Reason: why(err) + "; nothing was started"},
				notSent
		}
		return "", unknown(why(err) + "; the start may have reached the Orchestrator, and no answer came"), noAnswer
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := read(resp.Body)
	var answer struct {
		RunID  string          `json:"runId"`
		Error  string          `json:"error"`
		Report json.RawMessage `json:"report"`
	}
	parsed := readErr == nil && json.Unmarshal(body, &answer) == nil
	code := resp.StatusCode
	switch {
	case code == http.StatusCreated || code == http.StatusOK:
		if !parsed || answer.RunID == "" {
			return "", unknown(fmt.Sprintf("the door answered %d with no run id; a run may have started", code)),
				noAnswer
		}
		return answer.RunID, wire.Output{}, answered
	case code >= 500 || code < 300:
		return "", unknown(fmt.Sprintf("the door answered %d%s; a run may have started", code,
			detail(parsed, answer.Error))), noAnswer
	}
	// A refusal of the door (400 input, 404 name, 409 unrunnable Chart, 422 Chart; also a token it
	// does not take): output, so the report can reach a model through the Chain (ADR-0071).
	return "", refused(code, report(code, parsed, answer.Error, answer.Report)...), ended
}

// report is a door refusal's lines: its `report`, else its `error`, else its status.
func report(code int, parsed bool, msg string, raw json.RawMessage) []string {
	var lines []string
	if parsed && raw != nil && json.Unmarshal(raw, &lines) == nil && len(lines) > 0 {
		return lines
	}
	if parsed && msg != "" {
		return []string{msg}
	}
	return []string{fmt.Sprintf("the door answered %d %s", code, http.StatusText(code))}
}

func detail(parsed bool, msg string) string {
	if parsed && msg != "" {
		return ": " + msg
	}
	return ""
}

// wait polls the run at once, then every Poll, until its status is not live or the timeout
// passes. At the bound it reads the run once more, on the reserve it kept for that: the status the
// run had when the Effect stopped waiting is `live` only when that last poll read it live
// (ADR-0071). When the last poll did not answer, the status is not known, and the outcome is
// `unknown`, naming the poll and the run.
func (r *Runner) wait(ctx context.Context, base, run, auth string) wire.Output {
	every := r.Poll
	if every <= 0 {
		every = DefaultPoll
	}
	reserve := time.Duration(0)
	if deadline, ok := ctx.Deadline(); ok {
		reserve = min(lastPoll, time.Until(deadline)/2)
	}
	polling, cancel := context.WithCancel(ctx)
	if deadline, ok := ctx.Deadline(); ok {
		polling, cancel = context.WithDeadline(ctx, deadline.Add(-reserve))
	}
	defer cancel()
	// last is why the latest poll did not read the run, or "" when it read it live.
	last := "was not sent: the bound passed first"
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		p := r.poll(polling, base, run, auth)
		if p.out != nil {
			return *p.out
		}
		if p.done {
			return wire.Output{Outcome: wire.OutcomeSettled, Run: run, Status: p.status, Result: p.result}
		}
		last = p.failed
		select {
		case <-polling.Done():
		case <-tick.C:
			continue
		}
		break
	}
	if stopped(ctx) {
		return stoppedWait(run)
	}
	if ctx.Err() == nil {
		p := r.poll(ctx, base, run, auth)
		if p.out != nil {
			return *p.out
		}
		if p.done {
			return wire.Output{Outcome: wire.OutcomeSettled, Run: run, Status: p.status, Result: p.result}
		}
		if stopped(ctx) {
			return stoppedWait(run)
		}
		last = p.failed
	}
	if last == "" {
		return wire.Output{Outcome: wire.OutcomeSettled, Run: run, Status: "live"}
	}
	return unknown(fmt.Sprintf("the wait for run %s ended at its timeout, and the last poll of it %s; the run was "+
		"started and its status is not known", run, last))
}

// stopped says whether ctx ended because its Effect was stopped (its state exited), not at its bound.
func stopped(ctx context.Context) bool {
	return ctx.Err() != nil && !errors.Is(ctx.Err(), context.DeadlineExceeded)
}

func stoppedWait(run string) wire.Output {
	return unknown(fmt.Sprintf("the wait for run %s was stopped: its state exited; the run was started and goes on",
		run))
}

// polled is what one poll came to: the run's status and output once it is no longer live; an
// outcome that ends the Effect; or, to poll again, why the poll did not read the run ("" when it
// read it live).
type polled struct {
	status string
	result json.RawMessage
	done   bool
	out    *wire.Output
	failed string
}

// poll reads the run once. A poll that does not connect, or a 5xx, is an Orchestrator restarting,
// which the wait outlives (ADR-0071); so is one the bound or a stop cuts, which the wait reads as
// a failed poll. Any other answer that is not the run is `unknown`, naming the poll.
func (r *Runner) poll(ctx context.Context, base, run, auth string) polled {
	hreq, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/runs/"+url.PathEscape(run), nil)
	if err != nil {
		out := unknown(fmt.Sprintf("the poll of run %s could not be built: %v; the run was started", run, err))
		return polled{out: &out}
	}
	hreq.Header.Set("Authorization", auth)
	resp, err := r.client().Do(hreq)
	if err != nil {
		return polled{failed: "got no answer: " + why(err)}
	}
	defer func() { _ = resp.Body.Close() }()
	answer, readErr := readRun(resp.Body)
	if resp.StatusCode >= 500 {
		return polled{failed: fmt.Sprintf("answered %d%s", resp.StatusCode, detail(readErr == nil, answer.Error))}
	}
	if readErr != nil && ctx.Err() != nil {
		return polled{failed: "got no whole answer: the timeout passed"}
	}
	if resp.StatusCode != http.StatusOK || readErr != nil || answer.Status == "" {
		why := detail(readErr == nil, answer.Error)
		if readErr != nil {
			why = ": " + readErr.Error()
		}
		out := unknown(fmt.Sprintf("the poll of run %s answered %d%s; the run was started", run, resp.StatusCode, why))
		return polled{out: &out}
	}
	if live(answer.Status) {
		return polled{}
	}
	return polled{status: answer.Status, result: answer.Output, done: true}
}

// runAnswer is what a poll keeps of `GET /runs/<id>`'s answer.
type runAnswer struct {
	Status string
	Output json.RawMessage
	Error  string
}

// readRun reads a run's status, its output and an error out of a door's answer, a token at a time:
// every other field (the run's context, its children, its gates) is read past and never kept, so
// only the output is bounded by maxAnswer.
func readRun(body io.Reader) (runAnswer, error) {
	var a runAnswer
	dec := json.NewDecoder(io.LimitReader(body, maxPoll))
	tok, err := dec.Token()
	if err != nil {
		return a, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return a, errors.New("the answer is not a JSON object")
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return a, err
		}
		switch key, _ := tok.(string); key {
		case "status":
			err = dec.Decode(&a.Status)
		case "output":
			a.Output = nil
			if err = dec.Decode(&a.Output); err == nil && len(a.Output) > maxAnswer {
				err = fmt.Errorf("the run's output is more than %d bytes", maxAnswer)
			}
		case "error":
			var v any
			if err = dec.Decode(&v); err == nil {
				a.Error, _ = v.(string)
			}
		default:
			err = skip(dec)
		}
		if err != nil {
			return a, err
		}
	}
	if _, err := dec.Token(); err != nil {
		return a, err
	}
	return a, nil
}

// skip reads past one JSON value.
func skip(dec *json.Decoder) error {
	depth := 0
	for {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		if d, ok := tok.(json.Delim); ok {
			if d == '{' || d == '[' {
				depth++
			} else {
				depth--
			}
		}
		if depth == 0 {
			return nil
		}
	}
}

// live says whether a served status is a run still going: the Machine's own `active`, which
// `GET /runs/<id>` serves for a live row, or the store's `live` (run-host.ts settledStatus).
func live(status string) bool { return status == "active" || status == "live" }

// ascii writes every rune of a JSON text above 0x7F as a \uXXXX escape (a pair of them past
// 0xFFFF). A header carries it, and Node reads a header's bytes as latin1, so raw UTF-8 would reach
// the door garbled: a slot "révision" would be read as one that does not exist. Outside a string a
// JSON text holds ASCII alone, so the escapes land inside strings, where they mean the same rune.
func ascii(raw []byte) []byte {
	var b strings.Builder
	for _, r := range string(raw) {
		switch {
		case r < 0x80:
			b.WriteRune(r)
		case r > 0xFFFF:
			hi, lo := utf16.EncodeRune(r)
			fmt.Fprintf(&b, "\\u%04x\\u%04x", hi, lo)
		default:
			fmt.Fprintf(&b, "\\u%04x", r)
		}
	}
	return []byte(b.String())
}

// read reads an answer up to maxAnswer bytes.
func read(body io.Reader) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(body, maxAnswer+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxAnswer {
		return nil, fmt.Errorf("the answer is more than %d bytes", maxAnswer)
	}
	return raw, nil
}

func (r *Runner) client() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			// No proxy from the environment: the Effector calls the host the target fixed.
			Proxy:               nil,
			DialContext:         (&net.Dialer{Timeout: 30 * time.Second}).DialContext,
			TLSClientConfig:     &tls.Config{RootCAs: r.Roots, MinVersion: tls.VersionTLS12},
			TLSHandshakeTimeout: 30 * time.Second,
			DisableKeepAlives:   true,
		},
		// A redirect is the door's answer, never followed: following it would send the token to a
		// host the target did not fix.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// scrubJSON scrubs every string of a JSON value, each object key included, and writes it again.
// A match is replaced inside the decoded string, so the replacement can never break the JSON.
func scrubJSON(s *scrub.Scrubber, raw json.RawMessage) json.RawMessage {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		// Not JSON (it came from a decode, so this is not reached): it leaves as a scrubbed string.
		out, _ := wire.Encode(s.String(string(raw)))
		return out
	}
	out, err := wire.Encode(scrubValue(s, v))
	if err != nil {
		out, _ = wire.Encode(s.String(string(raw)))
	}
	return out
}

func scrubValue(s *scrub.Scrubber, v any) any {
	switch x := v.(type) {
	case string:
		return s.String(x)
	case []any:
		for i := range x {
			x[i] = scrubValue(s, x[i])
		}
		return x
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			key := s.String(k)
			if prev, ok := out[key]; ok {
				// Two keys that scrub to one keep both values.
				out[key] = []any{prev, scrubValue(s, val)}
				continue
			}
			out[key] = scrubValue(s, val)
		}
		return out
	}
	return v
}

// why is an error in words, without Go's request line.
func why(err error) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "the timeout passed"
	}
	return strings.TrimSpace(err.Error())
}
