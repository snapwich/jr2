// Package mcpkind runs the `mcp` kind (ADR-0067, ADR-0079): one request to a remote MCP server, in
// one session of its own, over Streamable HTTP at protocol 2025-11-25. The start names the server;
// its url and the name of its secret come from effector.json, which `jr2 up` wrote from the `mcp`
// block of jr2.config.ts. The secret goes as `Authorization: Bearer <value>`.
//
// The session is the handshake (`initialize`, then `notifications/initialized`, with the
// `Mcp-Session-Id` the server gave), one request (`tools/call`, `resources/read` or `prompts/get`),
// and a DELETE of the session. An answer is `application/json`, or `text/event-stream`, which is
// read until the message that answers the request's id. The client declares no capability, so a
// server that asks for input gets none.
//
// Every outcome is output (ADR-0067):
//
//   - `returned`: the server answered the request. A tool's own error is `returned` with isError.
//   - `refused`: the request did not run. The server or its secret is not in effector.json (nothing
//     was sent); the server answered a 3xx or a 4xx (a 401 or a 403 included) at any step; it
//     answered the handshake with an error; or it answered the request with -32700, -32600, -32601
//     or -32602 (a request it could not read, an unknown method, an unknown tool, bad arguments), or
//     a read with -32002 (the resource does not exist).
//   - `unreachable`: nothing of the request was sent: the name did not resolve, the connection or
//     TLS failed, or the handshake failed otherwise (a 5xx, the timeout, an answer that is not
//     MCP's, a revision the client does not speak).
//   - `input-required`: the server answered with -32042 (the tool did not run), or it sent
//     `elicitation/create` while the request ran (the tool may have begun). jr2 does not send the
//     request again.
//   - `unknown`: the request was sent and no answer came (the timeout, a reset, a stream that ended
//     first and that a resume from its last event id did not give again), or the server answered
//     with a 5xx or another error, after which the tool may have acted.
//
// A reason keeps at most maxSaid bytes of a server's error message, which is scrubbed before it is
// cut, so that a secret that straddles the cut is replaced whole. `text` and `structured` are
// scrubbed, then each bounded to the start's maxBody: past it, `text`
// is cut and `structured` is dropped (a cut JSON value would not parse), and `truncated` is set.
package mcpkind

import (
	"bufio"
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/snapwich/jr2/effector/internal/httpkind"
	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// ProtocolVersion is the MCP revision the Effector speaks (ADR-0079), the same as the Harness's.
const ProtocolVersion = "2025-11-25"

// DefaultTimeout bounds one Effect when neither the start nor effector.json sets a timeout.
const DefaultTimeout = 60 * time.Second

// maxAnswer is the most bytes of one answer the client reads. A longer answer is not read to its
// end: the Effect settles `unknown`, since the tool ran and its result could not be read.
const maxAnswer = 16 << 20

// The JSON-RPC errors after which the request did not run: a message the server could not parse,
// an invalid request, an unknown method, invalid params (an unknown tool, bad arguments).
var notRun = map[int]bool{-32700: true, -32600: true, -32601: true, -32602: true}

// resourceNotFound is MCP's error for a read of a uri that does not exist. A read does not act, so
// this error is `refused`.
const resourceNotFound = -32002

// versions are the protocol revisions the client can speak. A server that answers initialize with
// another revision gets no request.
var versions = map[string]bool{ProtocolVersion: true, "2025-06-18": true, "2025-03-26": true}

// maxSaid is the most bytes of a server's error message that a reason keeps (ADR-0079). The message
// is the server's words, not its result, so it is not bounded by maxBody.
const maxSaid = 1 << 10

// maxRetry bounds the wait the server's `retry:` asks for before a resume.
const maxRetry = 5 * time.Second

// maxResumes is the most times in a row that the client opens the event stream again, with
// Last-Event-ID, and gets no new event. A resume that brings a new event id starts the count again,
// so a server that closes the stream so that its client polls is read to its answer, within the
// Effect's timeout.
const maxResumes = 5

// minRetry is the least wait before a resume, so that a server that gives no `retry:` (or 0) is not
// polled in a tight loop.
const minRetry = 100 * time.Millisecond

// urlElicitationRequired is the error a server answers when it needs the user to open a url first.
const urlElicitationRequired = -32042

// Runner runs mcp Effects for one Effector: the Instance Effector's.
type Runner struct {
	Secrets  map[string]string
	Config   *secrets.Config
	Scrubber *scrub.Scrubber
	// Roots is the trust: the system roots plus the instance's caBundle (ADR-0020).
	Roots *x509.CertPool
	// Client is the http client; nil is the http kind's (httpkind.NewClient). Tests set it.
	Client *http.Client
}

// Run sends the request in a session of its own and answers its outcome, scrubbed and bounded.
func (r *Runner) Run(ctx context.Context, req *wire.StartRequest) wire.Output {
	built := map[string]string{}
	out := r.run(ctx, req, built)
	s := r.Scrubber.With(built)
	out.Reason = s.String(out.Reason)
	if out.Mcp != nil {
		bound(out.Mcp, s, req.MaxBody)
	}
	return out
}

// bound scrubs the result's text and structured value, then cuts the text at maxBody bytes, at a
// character's boundary, and drops a structured value longer than maxBody.
func bound(m *wire.McpResult, s *scrub.Scrubber, maxBody int) {
	m.Text = s.String(m.Text)
	if len(m.Text) > maxBody {
		end := maxBody
		for end > 0 && !utf8.RuneStart(m.Text[end]) {
			end--
		}
		m.Text = m.Text[:end]
		m.Truncated = true
	}
	if m.Structured != nil {
		m.Structured = s.JSON(m.Structured)
		if len(m.Structured) > maxBody {
			m.Structured = nil
			m.Truncated = true
		}
	}
}

func refused(reason string) wire.Output {
	return wire.Output{Outcome: wire.OutcomeRefused, Reason: reason}
}

func (r *Runner) client() *http.Client {
	if r.Client != nil {
		return r.Client
	}
	return httpkind.NewClient(r.Roots)
}

func (r *Runner) run(ctx context.Context, req *wire.StartRequest, built map[string]string) wire.Output {
	m := req.Mcp
	server, ok := r.Config.Mcp[m.Server]
	if !ok {
		return refused(fmt.Sprintf("the MCP server %q is not one an Effect placed here names; nothing was sent",
			m.Server))
	}
	target, err := url.Parse(server.URL)
	if err != nil || (target.Scheme != "https" && target.Scheme != "http") || target.Host == "" {
		return refused(fmt.Sprintf("the url of the MCP server %q is not an http(s) url; nothing was sent", m.Server))
	}
	var names []string
	bearer := ""
	if server.Secret != "" {
		value, held := r.Secrets[server.Secret]
		if !held {
			return refused(fmt.Sprintf("this Effector does not hold %s, the secret of the MCP server %q; nothing "+
				"was sent", server.Secret, m.Server))
		}
		names = []string{server.Secret}
		bearer = "Bearer " + value
		built[bearer] = server.Secret
	}
	port := 443
	if target.Scheme == "http" {
		port = 80
	}
	if p := target.Port(); p != "" {
		if port, err = strconv.Atoi(p); err != nil {
			return refused("the url's port is not a number; nothing was sent")
		}
	}
	// The second fence: the origin and the secret are a target an Effect placed here names.
	if !r.Config.Allows(target.Scheme, target.Hostname(), port, names) {
		return refused(fmt.Sprintf("%s://%s is not a host an Effect placed here names with these secrets; nothing "+
			"was sent", target.Scheme, target.Host))
	}

	timeout := time.Duration(req.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = time.Duration(server.TimeoutMs) * time.Millisecond
	}
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	s := &session{client: r.client(), url: target.String(), bearer: bearer, server: m.Server,
		scrub: r.Scrubber.With(built)}
	// The session is deleted however the handshake ends, once initialize gave its id.
	defer s.end()
	if out, ok := s.handshake(ctx); !ok {
		return out
	}

	method, params := requestOf(m)
	answer, out, ok := s.request(ctx, method, params)
	if !ok {
		return out
	}
	return resultOf(m, answer)
}

// named is the params of a request that names a tool or a prompt: tools/call and prompts/get.
type named struct {
	Name      string `json:"name"`
	Arguments any    `json:"arguments"`
}

// requestOf is the method and the params of the one request a start names.
func requestOf(m *wire.McpSpec) (string, any) {
	switch {
	case m.Call != nil:
		return "tools/call", named{Name: m.Call.Tool, Arguments: m.Call.Arguments}
	case m.Read != nil:
		return "resources/read", map[string]any{"uri": m.Read.URI}
	default:
		return "prompts/get", named{Name: m.Prompt.Name, Arguments: m.Prompt.Arguments}
	}
}

// session is one MCP session: its url, its bearer, and what the handshake gave.
type session struct {
	client  *http.Client
	url     string
	bearer  string
	server  string
	id      string // Mcp-Session-Id, when the server gave one
	version string // the protocol version the server answered with
	// scrub replaces each secret in the server's words before they are cut (ADR-0068).
	scrub *scrub.Scrubber
}

// rpcError is a JSON-RPC error object.
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// said is the error's code and its message, scrubbed, then cut at maxSaid bytes.
func (s *session) said(e *rpcError) string {
	return fmt.Sprintf("%d %s", e.Code, s.cut(e.Message, maxSaid))
}

// cut is the server's text, scrubbed, then cut at n bytes. A secret that straddles the cut is
// replaced whole before the cut, so no part of it stays.
func (s *session) cut(text string, n int) string {
	return cut(s.scrub.String(text), n)
}

// cut is the server's text, cut at n bytes at a character's boundary, with jr2's marker.
func cut(text string, n int) string {
	if len(text) <= n {
		return text
	}
	end := n
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end] + " [jr2: the text is cut]"
}

// message is one JSON-RPC message from the server: a response (id, result or error), a request
// (id, method) or a notification (method).
type message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

// implementation is MCP's Implementation: the clientInfo of initialize. The SDKs refuse an
// initialize whose clientInfo does not have `name` and `version`.
type implementation struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// handshake is `initialize`, then `notifications/initialized`. Nothing of the request is sent
// yet, so a failure here is `refused` (the server answered no) or `unreachable` (it did not).
func (s *session) handshake(ctx context.Context) (wire.Output, bool) {
	params := map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      implementation{Name: "jr2-effector", Version: "1"},
	}
	answer, failure := s.exchange(ctx, 1, "initialize", params)
	if failure != nil {
		switch {
		case failure.status >= 300 && failure.status < 500:
			return refused(failure.text("the handshake") + "; nothing was sent"), false
		case failure.rpc != nil:
			return refused(fmt.Sprintf("the server refused the handshake: %s; nothing was sent",
				s.said(failure.rpc))), false
		}
		return wire.Output{Outcome: wire.OutcomeUnreachable,
			Reason: failure.text("the handshake") + "; nothing was sent"}, false
	}
	var result struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if err := json.Unmarshal(answer.Result, &result); err != nil || result.ProtocolVersion == "" {
		return wire.Output{Outcome: wire.OutcomeUnreachable,
			Reason: "the server's answer to initialize is not MCP's: it names no protocolVersion; nothing was sent"}, false
	}
	if !versions[result.ProtocolVersion] {
		return wire.Output{Outcome: wire.OutcomeUnreachable,
			Reason: fmt.Sprintf("the server speaks the MCP revision %q, which the Effector does not; nothing was sent",
				s.cut(result.ProtocolVersion, 64))}, false
	}
	s.version = result.ProtocolVersion
	status, err := s.notify(ctx, "notifications/initialized")
	switch {
	case err != nil:
		return wire.Output{Outcome: wire.OutcomeUnreachable,
			Reason: "the handshake failed: " + why(err) + "; nothing was sent"}, false
	case status >= 300 && status < 500:
		return refused(fmt.Sprintf("the server answered the handshake with HTTP %d; nothing was sent", status)), false
	case status >= 500:
		return wire.Output{Outcome: wire.OutcomeUnreachable,
			Reason: fmt.Sprintf("the server answered the handshake with HTTP %d; nothing was sent", status)}, false
	}
	return wire.Output{}, true
}

// request sends the one request and reads its answer. A failure is the request's outcome.
func (s *session) request(ctx context.Context, method string, params any) (*message, wire.Output, bool) {
	answer, failure := s.exchange(ctx, 2, method, params)
	if failure == nil {
		return answer, wire.Output{}, true
	}
	switch {
	case failure.elicit:
		return nil, wire.Output{Outcome: wire.OutcomeInputRequired,
			Reason: "the server asked for input (elicitation/create) while the request ran, which jr2 does not " +
				"give; the tool may have begun"}, false
	case failure.rpc != nil && failure.rpc.Code == urlElicitationRequired:
		return nil, wire.Output{Outcome: wire.OutcomeInputRequired,
			Reason: fmt.Sprintf("the server asked for input (%s), which jr2 does not give; the tool did not run",
				s.said(failure.rpc))}, false
	case failure.rpc != nil && (notRun[failure.rpc.Code] ||
		(method == "resources/read" && failure.rpc.Code == resourceNotFound)):
		return nil, refused("the server refused the request: " + s.said(failure.rpc)), false
	case failure.rpc != nil:
		return nil, wire.Output{Outcome: wire.OutcomeUnknown,
			Reason: fmt.Sprintf("the server answered with an error: %s; it may have acted", s.said(failure.rpc))}, false
	case failure.status >= 300 && failure.status < 500:
		return nil, refused(failure.text("the request")), false
	case !failure.connected:
		return nil, wire.Output{Outcome: wire.OutcomeUnreachable,
			Reason: failure.text("the request") + "; nothing was sent"}, false
	}
	return nil, wire.Output{Outcome: wire.OutcomeUnknown,
		Reason: failure.text("the request") + "; the server may have acted, and no answer came"}, false
}

// failure is why one exchange did not give a result: an HTTP status that is not 2xx, a JSON-RPC
// error, a request for input, or a transport error (connected says whether a connection was made).
type failure struct {
	status    int
	rpc       *rpcError
	elicit    bool
	err       error
	connected bool
	ended     bool // the event stream ended before the answer
}

func (f *failure) text(step string) string {
	switch {
	case f.status != 0:
		return fmt.Sprintf("the server answered %s with HTTP %d", step, f.status)
	case f.err != nil:
		return fmt.Sprintf("%s failed: %s", step, why(f.err))
	}
	return step + " failed"
}

// exchange posts one JSON-RPC request and reads the response with its id, from a JSON answer or an
// event stream.
func (s *session) exchange(ctx context.Context, id int, method string, params any) (*message, *failure) {
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err != nil {
		return nil, &failure{err: err}
	}
	resp, connected, err := s.post(ctx, body, id > 1)
	if err != nil {
		return nil, &failure{err: err, connected: connected}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, &failure{status: resp.StatusCode, connected: true}
	}
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" && s.id == "" {
		s.id = sid
	}
	media, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	want := strconv.Itoa(id)
	var answer *message
	var f *failure
	if media == "text/event-stream" {
		answer, f = s.stream(ctx, resp.Body, want)
	} else {
		answer, f = readJSON(resp.Body, want)
	}
	if f != nil {
		f.connected = true
		return nil, f
	}
	if answer.Error != nil {
		return nil, &failure{rpc: answer.Error, connected: true}
	}
	return answer, nil
}

// readJSON reads one JSON-RPC message, which must answer the id.
func readJSON(body io.Reader, id string) (*message, *failure) {
	raw, err := io.ReadAll(io.LimitReader(body, maxAnswer+1))
	if err != nil {
		return nil, &failure{err: err}
	}
	if len(raw) > maxAnswer {
		return nil, &failure{err: fmt.Errorf("the answer is longer than %d bytes", maxAnswer)}
	}
	var m message
	if err := json.Unmarshal(raw, &m); err != nil || string(bytes.TrimSpace(m.ID)) != id {
		return nil, &failure{err: errors.New("the answer is not a JSON-RPC response to the request")}
	}
	return &m, nil
}

// stream reads the request's event stream until the answer. When the stream ends before the
// answer after the server gave an event id, the client opens it again with a GET and Last-Event-ID,
// after the server's retry, within the Effect's timeout. It stops after maxResumes resumes in a row
// that bring no new event id. The server then sends what follows that event; the request is not
// sent again.
func (s *session) stream(ctx context.Context, body io.Reader, id string) (*message, *failure) {
	read := &streamRead{id: id}
	answer, f := read.from(body)
	for idle := 0; f != nil && f.ended && read.lastID != "" && idle < maxResumes; {
		select {
		case <-ctx.Done():
			return nil, &failure{err: ctx.Err()}
		case <-time.After(max(read.retry, minRetry)):
		}
		before := read.lastID
		resp, err := s.resume(ctx, read.lastID)
		if err != nil {
			return nil, &failure{err: err}
		}
		media, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
		if resp.StatusCode < 200 || resp.StatusCode >= 300 || media != "text/event-stream" {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
			_ = resp.Body.Close()
			return nil, &failure{err: fmt.Errorf("the event stream ended before the answer, and the server "+
				"answered its resume with HTTP %d", resp.StatusCode)}
		}
		answer, f = read.from(resp.Body)
		_ = resp.Body.Close()
		if read.lastID == before {
			idle++
		} else {
			idle = 0
		}
	}
	return answer, f
}

// resume opens the session's event stream again after the event lastID.
func (s *session) resume(ctx context.Context, lastID string) (*http.Response, error) {
	hreq, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return nil, err
	}
	s.headers(hreq.Header, true)
	hreq.Header.Set("Accept", "text/event-stream")
	hreq.Header.Set("Last-Event-ID", lastID)
	return s.client.Do(hreq)
}

// streamRead is the state of one request's event stream across its resumes: the id it waits for,
// the bytes read, the last event id and the retry the server gave.
type streamRead struct {
	id     string
	read   int
	lastID string
	retry  time.Duration
}

// from reads server-sent events until the message that answers the id. A notification is passed
// over. A request for input stops the read: the client declared no capability for it. A line ends
// with CRLF, LF or a lone CR, as the SSE grammar allows.
func (r *streamRead) from(body io.Reader) (*message, *failure) {
	lines := bufio.NewScanner(io.LimitReader(body, int64(maxAnswer+1-r.read)))
	lines.Buffer(make([]byte, 0, 64<<10), maxAnswer+1)
	lines.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		advance, token := sseLine(data, atEOF)
		r.read += advance
		return advance, token, nil
	})
	var data strings.Builder
	eventID := ""
	// dispatch ends the event: it answers the message that ends the read, or nil.
	dispatch := func() (*message, *failure) {
		if eventID != "" {
			r.lastID = eventID
		}
		eventID = ""
		if data.Len() == 0 {
			return nil, nil
		}
		var m message
		err := json.Unmarshal([]byte(data.String()), &m)
		data.Reset()
		if err == nil {
			switch {
			case m.Method == "elicitation/create":
				return nil, &failure{elicit: true}
			case m.Method == "" && string(bytes.TrimSpace(m.ID)) == r.id:
				return &m, nil
			}
		}
		return nil, nil
	}
	for lines.Scan() {
		if r.read > maxAnswer {
			return nil, &failure{err: fmt.Errorf("the event stream is longer than %d bytes", maxAnswer)}
		}
		line := lines.Text()
		switch {
		case strings.HasPrefix(line, "data:"):
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			data.WriteByte('\n')
		case strings.HasPrefix(line, "id:"):
			eventID = strings.TrimPrefix(strings.TrimPrefix(line, "id:"), " ")
		case strings.HasPrefix(line, "retry:"):
			if ms, perr := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "retry:"))); perr == nil &&
				ms >= 0 {
				r.retry = min(time.Duration(ms)*time.Millisecond, maxRetry)
			}
		case line == "":
			if m, f := dispatch(); m != nil || f != nil {
				return m, f
			}
		}
	}
	if err := lines.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) || r.read > maxAnswer {
			return nil, &failure{err: fmt.Errorf("the event stream is longer than %d bytes", maxAnswer)}
		}
		return nil, &failure{err: err}
	}
	if r.read > maxAnswer {
		return nil, &failure{err: fmt.Errorf("the event stream is longer than %d bytes", maxAnswer)}
	}
	// An event that the stream's end cut before its blank line is read too: its message is whole.
	if m, f := dispatch(); m != nil || f != nil {
		return m, f
	}
	return nil, &failure{err: errors.New("the event stream ended before the answer"), ended: true}
}

// sseLine is a bufio.SplitFunc for the lines of an event stream: a line ends with CRLF, LF or a
// lone CR. A CR at the end of data waits for the next byte, which can be its LF.
func sseLine(data []byte, atEOF bool) (int, []byte) {
	i := bytes.IndexAny(data, "\r\n")
	switch {
	case i < 0:
		if atEOF && len(data) > 0 {
			return len(data), data
		}
		return 0, nil
	case data[i] == '\n':
		return i + 1, data[:i]
	case i+1 < len(data):
		if data[i+1] == '\n' {
			return i + 2, data[:i]
		}
		return i + 1, data[:i]
	case atEOF:
		return i + 1, data[:i]
	}
	return 0, nil
}

// notify posts one JSON-RPC notification, and answers the status.
func (s *session) notify(ctx context.Context, method string) (int, error) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method})
	resp, _, err := s.post(ctx, body, true)
	if err != nil {
		return 0, err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	return resp.StatusCode, nil
}

// post sends one message. After the handshake's first answer it carries the session id and the
// protocol version, as the protocol requires of every request after `initialize`.
func (s *session) post(ctx context.Context, body []byte, initialized bool) (*http.Response, bool, error) {
	var connected atomic.Bool
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		GotConn: func(httptrace.GotConnInfo) { connected.Store(true) },
	})
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return nil, false, err
	}
	s.headers(hreq.Header, initialized)
	hreq.Header.Set("Content-Type", "application/json")
	hreq.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := s.client.Do(hreq)
	return resp, connected.Load(), err
}

func (s *session) headers(h http.Header, initialized bool) {
	if s.bearer != "" {
		h.Set("Authorization", s.bearer)
	}
	if initialized {
		if s.id != "" {
			h.Set("Mcp-Session-Id", s.id)
		}
		if s.version != "" {
			h.Set("Mcp-Protocol-Version", s.version)
		}
	}
}

// end deletes the session, when the server gave one: the server may free it. It is bounded, and
// its outcome changes nothing.
func (s *session) end() {
	if s.id == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	hreq, err := http.NewRequestWithContext(ctx, http.MethodDelete, s.url, nil)
	if err != nil {
		return
	}
	s.headers(hreq.Header, true)
	if resp, err := s.client.Do(hreq); err == nil {
		_ = resp.Body.Close()
	}
}

// resultOf reads the answer's result as the start's request gives it: a tool's content, a
// resource's contents, a prompt's messages.
func resultOf(m *wire.McpSpec, answer *message) wire.Output {
	notMcp := wire.Output{Outcome: wire.OutcomeUnknown,
		Reason: "the server's answer is not the result MCP gives for the request; it may have acted"}
	switch {
	case m.Call != nil:
		var r struct {
			Content           *[]json.RawMessage `json:"content"`
			StructuredContent json.RawMessage    `json:"structuredContent"`
			IsError           bool               `json:"isError"`
		}
		// A CallToolResult has content; a null result or one with no content is not MCP's.
		if json.Unmarshal(answer.Result, &r) != nil || r.Content == nil {
			return notMcp
		}
		isError := r.IsError
		out := &wire.McpResult{IsError: &isError, Text: textOf(*r.Content)}
		if len(r.StructuredContent) > 0 && string(r.StructuredContent) != "null" {
			out.Structured = r.StructuredContent
		}
		return wire.Output{Outcome: wire.OutcomeReturned, Mcp: out}
	case m.Read != nil:
		var r struct {
			Contents []map[string]any `json:"contents"`
		}
		// UseNumber keeps a large integer (in _meta, say) as the server wrote it.
		decoder := json.NewDecoder(bytes.NewReader(answer.Result))
		decoder.UseNumber()
		if decoder.Decode(&r) != nil || r.Contents == nil {
			return notMcp
		}
		var texts []string
		for _, c := range r.Contents {
			if t, ok := c["text"].(string); ok {
				texts = append(texts, t)
			}
			// A blob is given only as its mimeType and its size (ADR-0079): its bytes are not text.
			if b, ok := c["blob"].(string); ok {
				delete(c, "blob")
				c["size"] = base64.StdEncoding.DecodedLen(len(b)) - strings.Count(b, "=")
			}
		}
		structured, _ := json.Marshal(r.Contents)
		return wire.Output{Outcome: wire.OutcomeReturned,
			Mcp: &wire.McpResult{Text: strings.Join(texts, "\n"), Structured: structured}}
	default:
		var r struct {
			Messages []struct {
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		var raw struct {
			Messages json.RawMessage `json:"messages"`
		}
		if json.Unmarshal(answer.Result, &r) != nil || json.Unmarshal(answer.Result, &raw) != nil ||
			r.Messages == nil {
			return notMcp
		}
		contents := make([]json.RawMessage, 0, len(r.Messages))
		for _, msg := range r.Messages {
			contents = append(contents, msg.Content)
		}
		return wire.Output{Outcome: wire.OutcomeReturned,
			Mcp: &wire.McpResult{Text: textOf(contents), Structured: raw.Messages}}
	}
}

// textOf joins the text of content blocks, one line each. A block that is not text is one line of
// jr2's text that names its type.
func textOf(blocks []json.RawMessage) string {
	lines := make([]string, 0, len(blocks))
	for _, raw := range blocks {
		var b struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &b) != nil {
			continue
		}
		if b.Type == "text" {
			lines = append(lines, b.Text)
			continue
		}
		lines = append(lines, fmt.Sprintf("[jr2: the result has content of the type %q]", b.Type))
	}
	return strings.Join(lines, "\n")
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
