package mcpkind

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	"unicode/utf8"

	"github.com/snapwich/jr2/effector/internal/httpkind"
	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

const token = "mcp-token-0123456789"

// fake is an MCP server over Streamable HTTP: it answers the handshake, and the request as `answer`
// says. It records what each POST carried.
type fake struct {
	t      *testing.T
	answer func(w http.ResponseWriter, req map[string]any)
	// initStatus, when set, is the HTTP status of the initialize answer.
	initStatus int
	// initAnswer, when set, answers initialize in place of the fake's own answer.
	initAnswer func(w http.ResponseWriter, req map[string]any)
	// initializedStatus, when set, is the HTTP status of the notifications/initialized answer.
	initializedStatus int
	// get, when set, answers a GET (a resume of an event stream).
	get func(w http.ResponseWriter, r *http.Request)

	mu      sync.Mutex
	posts   []http.Header
	methods []string
	deleted bool
}

func (f *fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	if r.Method == http.MethodDelete {
		f.deleted = true
		f.mu.Unlock()
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method == http.MethodGet {
		f.mu.Unlock()
		if f.get == nil {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		f.get(w, r)
		return
	}
	f.posts = append(f.posts, r.Header.Clone())
	f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+token {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	raw, _ := io.ReadAll(r.Body)
	var req map[string]any
	if err := json.Unmarshal(raw, &req); err != nil {
		f.t.Errorf("the client sent a body that is not JSON: %s", raw)
		return
	}
	method, _ := req["method"].(string)
	f.mu.Lock()
	f.methods = append(f.methods, method)
	f.mu.Unlock()
	switch method {
	case "initialize":
		if f.initStatus != 0 {
			w.WriteHeader(f.initStatus)
			return
		}
		// The SDKs refuse an initialize whose clientInfo is not an Implementation, so the fake does too.
		params, _ := req["params"].(map[string]any)
		info, _ := params["clientInfo"].(map[string]any)
		name, _ := info["name"].(string)
		version, _ := info["version"].(string)
		if _, ok := params["capabilities"].(map[string]any); !ok || name == "" || version == "" {
			f.t.Errorf("initialize carried clientInfo %v and capabilities %v", params["clientInfo"],
				params["capabilities"])
			replyError(w, req["id"], -32602, "invalid initialize params")
			return
		}
		if f.initAnswer != nil {
			w.Header().Set("Mcp-Session-Id", "session-1")
			f.initAnswer(w, req)
			return
		}
		if params["protocolVersion"] != ProtocolVersion {
			f.t.Errorf("initialize asked for %v", params["protocolVersion"])
		}
		w.Header().Set("Mcp-Session-Id", "session-1")
		reply(w, req["id"], map[string]any{"protocolVersion": ProtocolVersion, "capabilities": map[string]any{},
			"serverInfo": map[string]any{"name": "fake", "version": "1"}})
	case "notifications/initialized":
		if f.initializedStatus != 0 {
			w.WriteHeader(f.initializedStatus)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	default:
		f.answer(w, req)
	}
}

func reply(w http.ResponseWriter, id any, result any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func replyError(w http.ResponseWriter, id any, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id,
		"error": map[string]any{"code": code, "message": message}})
}

func stream(w http.ResponseWriter, messages ...any) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, m := range messages {
		raw, _ := json.Marshal(m)
		_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", raw)
		w.(http.Flusher).Flush()
	}
}

// setup serves f and gives a runner whose effector.json names it as "acme", with its secret.
func setup(t *testing.T, f *fake) (*Runner, *httptest.Server) {
	t.Helper()
	f.t = t
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	config := &secrets.Config{
		Version:   1,
		Placement: "instance",
		Targets:   []secrets.Target{{Scheme: "http", Host: u.Hostname(), Port: port, Secrets: []string{"acme-token"}}},
		Mcp:       map[string]secrets.McpServer{"acme": {URL: srv.URL + "/mcp", Secret: "acme-token", TimeoutMs: 5000}},
	}
	held := map[string]string{"acme-token": token}
	// The http kind's own client: no proxy, a new connection for each request, no redirect followed.
	return &Runner{Secrets: held, Config: config, Scrubber: scrub.New(held), Client: httpkind.NewClient(nil)}, srv
}

func call(tool string, args string) *wire.StartRequest {
	return &wire.StartRequest{Kind: wire.KindMcp, MaxBody: 65536,
		Mcp: &wire.McpSpec{Server: "acme", Call: &wire.McpCall{Tool: tool, Arguments: json.RawMessage(args)}}}
}

func TestCallJSONAnswerIsReturnedWithTheSessionAndProtocolHeaders(t *testing.T) {
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
		params := req["params"].(map[string]any)
		if params["name"] != "post_message" || params["arguments"].(map[string]any)["text"] != "hi" {
			t.Errorf("tools/call carried %v", params)
		}
		reply(w, req["id"], map[string]any{
			"content":           []any{map[string]any{"type": "text", "text": "posted"}, map[string]any{"type": "image"}},
			"structuredContent": map[string]any{"ts": "1.2", "echo": token},
		})
	}}
	r, _ := setup(t, f)
	out := r.Run(context.Background(), call("post_message", `{"text":"hi"}`))
	if out.Outcome != wire.OutcomeReturned || out.Mcp == nil {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
	if out.Mcp.IsError == nil || *out.Mcp.IsError {
		t.Errorf("isError %v", out.Mcp.IsError)
	}
	if out.Mcp.Text != "posted\n[jr2: the result has content of the type \"image\"]" {
		t.Errorf("text %q", out.Mcp.Text)
	}
	if !strings.Contains(string(out.Mcp.Structured), `"echo":"[secret:acme-token]"`) {
		t.Errorf("structured is not scrubbed: %s", out.Mcp.Structured)
	}
	if got := strings.Join(f.methods, ","); got != "initialize,notifications/initialized,tools/call" {
		t.Errorf("methods %s", got)
	}
	if h := f.posts[0]; h.Get("Mcp-Session-Id") != "" || h.Get("Mcp-Protocol-Version") != "" {
		t.Errorf("initialize carried a session or a version: %v", h)
	}
	for _, h := range f.posts[1:] {
		if h.Get("Mcp-Session-Id") != "session-1" || h.Get("Mcp-Protocol-Version") != ProtocolVersion {
			t.Errorf("a request after initialize lacks its session or its version: %v", h)
		}
	}
	if !f.deleted {
		t.Error("the session was not deleted")
	}
}

func TestEventStreamIsReadToTheAnswerPastANotification(t *testing.T) {
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
		stream(w,
			map[string]any{"jsonrpc": "2.0", "method": "notifications/progress", "params": map[string]any{}},
			map[string]any{"jsonrpc": "2.0", "id": 99, "result": map[string]any{}},
			map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": map[string]any{
				"content": []any{map[string]any{"type": "text", "text": "done"}}, "isError": true}})
	}}
	r, _ := setup(t, f)
	out := r.Run(context.Background(), call("deploy", `{}`))
	if out.Outcome != wire.OutcomeReturned || out.Mcp.Text != "done" || !*out.Mcp.IsError {
		t.Fatalf("outcome %q %+v (%s)", out.Outcome, out.Mcp, out.Reason)
	}
	if out.Mcp.Structured != nil {
		t.Errorf("structured %s", out.Mcp.Structured)
	}
}

func TestA401IsRefused(t *testing.T) {
	f := &fake{answer: func(http.ResponseWriter, map[string]any) { t.Error("the request was sent") }}
	r, _ := setup(t, f)
	r.Secrets["acme-token"] = "another-token-0123456789"
	out := r.Run(context.Background(), call("post", `{}`))
	if out.Outcome != wire.OutcomeRefused || !strings.Contains(out.Reason, "HTTP 401") {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
}

func TestAHandshake5xxIsUnreachable(t *testing.T) {
	f := &fake{initStatus: http.StatusBadGateway, answer: func(http.ResponseWriter, map[string]any) {}}
	r, _ := setup(t, f)
	out := r.Run(context.Background(), call("post", `{}`))
	if out.Outcome != wire.OutcomeUnreachable || !strings.Contains(out.Reason, "nothing was sent") {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
}

func TestJSONRPCErrors(t *testing.T) {
	for _, c := range []struct {
		code    int
		outcome string
	}{
		{-32602, wire.OutcomeRefused},
		{-32601, wire.OutcomeRefused},
		{-32042, wire.OutcomeInputRequired},
		{-32603, wire.OutcomeUnknown},
		{-31999, wire.OutcomeUnknown},
	} {
		t.Run(strconv.Itoa(c.code), func(t *testing.T) {
			f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
				replyError(w, req["id"], c.code, "no "+token)
			}}
			r, _ := setup(t, f)
			out := r.Run(context.Background(), call("post", `{}`))
			if out.Outcome != c.outcome {
				t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
			}
			if strings.Contains(out.Reason, token) || !strings.Contains(out.Reason, "[secret:acme-token]") {
				t.Errorf("the reason is not scrubbed: %s", out.Reason)
			}
		})
	}
}

func TestElicitationIsInputRequired(t *testing.T) {
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
		stream(w, map[string]any{"jsonrpc": "2.0", "id": "e1", "method": "elicitation/create",
			"params": map[string]any{"message": "which channel?"}})
		// The server waits for an answer that never comes.
		time.Sleep(50 * time.Millisecond)
	}}
	r, _ := setup(t, f)
	out := r.Run(context.Background(), call("post", `{}`))
	if out.Outcome != wire.OutcomeInputRequired {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
}

func TestADropMidCallIsUnknown(t *testing.T) {
	for _, sse := range []bool{false, true} {
		t.Run(strconv.FormatBool(sse), func(t *testing.T) {
			f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
				if sse {
					stream(w, map[string]any{"jsonrpc": "2.0", "method": "notifications/progress"})
				}
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Fatal(err)
				}
				_ = conn.Close()
			}}
			r, _ := setup(t, f)
			out := r.Run(context.Background(), call("post", `{}`))
			if out.Outcome != wire.OutcomeUnknown || !strings.Contains(out.Reason, "may have acted") {
				t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
			}
		})
	}
}

func TestTheTimeoutIsUnknown(t *testing.T) {
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) { time.Sleep(300 * time.Millisecond) }}
	r, _ := setup(t, f)
	req := call("slow", `{}`)
	req.TimeoutMs = 100
	out := r.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeUnknown || !strings.Contains(out.Reason, "the timeout passed") {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
}

func TestAServerOrSecretNotInTheConfigIsRefusedWithNothingSent(t *testing.T) {
	f := &fake{answer: func(http.ResponseWriter, map[string]any) {}}
	r, _ := setup(t, f)
	req := call("post", `{}`)
	req.Mcp.Server = "other"
	if out := r.Run(context.Background(), req); out.Outcome != wire.OutcomeRefused ||
		!strings.Contains(out.Reason, "nothing was sent") {
		t.Fatalf("an unknown server: %q (%s)", out.Outcome, out.Reason)
	}
	delete(r.Secrets, "acme-token")
	if out := r.Run(context.Background(), call("post", `{}`)); out.Outcome != wire.OutcomeRefused {
		t.Fatalf("a secret not held: %q (%s)", out.Outcome, out.Reason)
	}
	r.Secrets["acme-token"] = token
	r.Config.Targets = nil
	if out := r.Run(context.Background(), call("post", `{}`)); out.Outcome != wire.OutcomeRefused ||
		!strings.Contains(out.Reason, "not a host") {
		t.Fatalf("a target not named: %q (%s)", out.Outcome, out.Reason)
	}
	if len(f.posts) != 0 {
		t.Errorf("%d requests were sent", len(f.posts))
	}
}

func TestAnUnreachableServerIsUnreachable(t *testing.T) {
	f := &fake{answer: func(http.ResponseWriter, map[string]any) {}}
	r, srv := setup(t, f)
	srv.Close()
	out := r.Run(context.Background(), call("post", `{}`))
	if out.Outcome != wire.OutcomeUnreachable {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
}

func TestTextAndStructuredAreBounded(t *testing.T) {
	long := strings.Repeat("é", 100)
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
		reply(w, req["id"], map[string]any{"content": []any{map[string]any{"type": "text", "text": long}},
			"structuredContent": map[string]any{"long": long}})
	}}
	r, _ := setup(t, f)
	req := call("post", `{}`)
	req.MaxBody = 51
	out := r.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeReturned || !out.Mcp.Truncated {
		t.Fatalf("outcome %q %+v", out.Outcome, out.Mcp)
	}
	if out.Mcp.Text != strings.Repeat("é", 25) {
		t.Errorf("text %q is not cut at a character's boundary", out.Mcp.Text)
	}
	if out.Mcp.Structured != nil {
		t.Errorf("structured past the bound is kept: %s", out.Mcp.Structured)
	}
}

func TestReadAndPrompt(t *testing.T) {
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
		params := req["params"].(map[string]any)
		switch req["method"] {
		case "resources/read":
			if params["uri"] != "file:///notes.md" {
				t.Errorf("uri %v", params["uri"])
			}
			reply(w, req["id"], map[string]any{"contents": []any{
				map[string]any{"uri": "file:///notes.md", "mimeType": "text/markdown", "text": "# Notes"},
				map[string]any{"uri": "file:///logo.png", "mimeType": "image/png", "blob": "aGVsbG8="},
			}})
		case "prompts/get":
			if params["arguments"].(map[string]any)["topic"] != "release" {
				t.Errorf("arguments %v", params["arguments"])
			}
			reply(w, req["id"], map[string]any{"messages": []any{
				map[string]any{"role": "user", "content": map[string]any{"type": "text", "text": "Write the note."}},
			}})
		}
	}}
	r, _ := setup(t, f)
	read := &wire.StartRequest{Kind: wire.KindMcp, MaxBody: 65536,
		Mcp: &wire.McpSpec{Server: "acme", Read: &wire.McpRead{URI: "file:///notes.md"}}}
	out := r.Run(context.Background(), read)
	if out.Outcome != wire.OutcomeReturned || out.Mcp.Text != "# Notes" || out.Mcp.IsError != nil {
		t.Fatalf("read: %q %+v (%s)", out.Outcome, out.Mcp, out.Reason)
	}
	if s := string(out.Mcp.Structured); strings.Contains(s, "aGVsbG8") || !strings.Contains(s, `"size":5`) {
		t.Errorf("read structured %s: a blob is its mimeType and size only", s)
	}
	prompt := &wire.StartRequest{Kind: wire.KindMcp, MaxBody: 65536, Mcp: &wire.McpSpec{Server: "acme",
		Prompt: &wire.McpPrompt{Name: "release", Arguments: map[string]string{"topic": "release"}}}}
	out = r.Run(context.Background(), prompt)
	if out.Outcome != wire.OutcomeReturned || out.Mcp.Text != "Write the note." ||
		!strings.Contains(string(out.Mcp.Structured), `"role":"user"`) {
		t.Fatalf("prompt: %q %+v (%s)", out.Outcome, out.Mcp, out.Reason)
	}
}

func TestARedirectIsRefusedAndNotFollowed(t *testing.T) {
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
		w.Header().Set("Location", "https://elsewhere.example/mcp")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}}
	r, _ := setup(t, f)
	out := r.Run(context.Background(), call("post", `{}`))
	if out.Outcome != wire.OutcomeRefused || !strings.Contains(out.Reason, "HTTP 307") {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
}

func TestALongServerErrorMessageIsCut(t *testing.T) {
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
		replyError(w, req["id"], -32603, strings.Repeat("é", 1<<20))
	}}
	r, _ := setup(t, f)
	out := r.Run(context.Background(), call("post", `{}`))
	if out.Outcome != wire.OutcomeUnknown || len(out.Reason) > maxSaid+200 ||
		!strings.Contains(out.Reason, "[jr2: the text is cut]") || !utf8.ValidString(out.Reason) {
		t.Fatalf("outcome %q, a reason of %d bytes", out.Outcome, len(out.Reason))
	}
}

func TestAStreamClosedForPollingIsResumedWithLastEventID(t *testing.T) {
	var resumedAfter string
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
		w.Header().Set("Content-Type", "text/event-stream")
		// A priming event, then the server closes the stream so that the client polls.
		_, _ = fmt.Fprint(w, "id: ev-1\ndata:\nretry: 10\n\n")
	}}
	f.get = func(w http.ResponseWriter, r *http.Request) {
		resumedAfter = r.Header.Get("Last-Event-ID")
		if r.Header.Get("Mcp-Session-Id") != "session-1" || r.Header.Get("Authorization") != "Bearer "+token {
			t.Errorf("the resume carried %v", r.Header)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprintf(w, "id: ev-2\ndata: %s\n\n",
			`{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"posted"}]}}`)
	}
	r, _ := setup(t, f)
	out := r.Run(context.Background(), call("post", `{}`))
	if out.Outcome != wire.OutcomeReturned || out.Mcp.Text != "posted" {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
	if resumedAfter != "ev-1" {
		t.Errorf("the resume asked after %q", resumedAfter)
	}
	if got := strings.Join(f.methods, ","); got != "initialize,notifications/initialized,tools/call" {
		t.Errorf("the client sent %s: the request was sent again", got)
	}
}

func TestAStreamWithNoEventIDIsNotResumed(t *testing.T) {
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
		stream(w, map[string]any{"jsonrpc": "2.0", "method": "notifications/progress"})
	}}
	f.get = func(http.ResponseWriter, *http.Request) { t.Error("the client resumed a stream with no event id") }
	r, _ := setup(t, f)
	if out := r.Run(context.Background(), call("post", `{}`)); out.Outcome != wire.OutcomeUnknown {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
}

func TestAFailedHandshakeStillDeletesTheSession(t *testing.T) {
	f := &fake{initializedStatus: http.StatusForbidden, answer: func(http.ResponseWriter, map[string]any) {}}
	r, _ := setup(t, f)
	out := r.Run(context.Background(), call("post", `{}`))
	if out.Outcome != wire.OutcomeRefused {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
	if !f.deleted {
		t.Error("the session the server gave was not deleted")
	}
}

func TestTheRequestsOwnDialFailingIsUnreachable(t *testing.T) {
	f := &fake{answer: func(http.ResponseWriter, map[string]any) { t.Error("the tool was called") }}
	r, _ := setup(t, f)
	transport := r.Client.Transport.(*http.Transport).Clone()
	dial := transport.DialContext
	var dials atomic.Int32
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if dials.Add(1) == 3 {
			return nil, errors.New("connection refused")
		}
		return dial(ctx, network, addr)
	}
	r.Client = &http.Client{Transport: transport, CheckRedirect: r.Client.CheckRedirect}
	out := r.Run(context.Background(), call("post", `{}`))
	if out.Outcome != wire.OutcomeUnreachable || !strings.Contains(out.Reason, "nothing was sent") {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
}

func TestA5xxToTheRequestIsUnknown(t *testing.T) {
	f := &fake{answer: func(w http.ResponseWriter, _ map[string]any) { w.WriteHeader(http.StatusBadGateway) }}
	r, _ := setup(t, f)
	if out := r.Run(context.Background(), call("post", `{}`)); out.Outcome != wire.OutcomeUnknown {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
}

func TestTheHandshakeAnsweredWithAnErrorOrAnUnknownRevision(t *testing.T) {
	for _, c := range []struct {
		name    string
		answer  func(w http.ResponseWriter, req map[string]any)
		outcome string
	}{
		{"error", func(w http.ResponseWriter, req map[string]any) {
			replyError(w, req["id"], -32602, "unsupported")
		}, wire.OutcomeRefused},
		{"revision", func(w http.ResponseWriter, req map[string]any) {
			reply(w, req["id"], map[string]any{"protocolVersion": "2099-01-01", "capabilities": map[string]any{}})
		}, wire.OutcomeUnreachable},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := &fake{initAnswer: c.answer, answer: func(http.ResponseWriter, map[string]any) {
				t.Error("the tool was called")
			}}
			r, _ := setup(t, f)
			out := r.Run(context.Background(), call("post", `{}`))
			if out.Outcome != c.outcome || !strings.Contains(out.Reason, "nothing was sent") {
				t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
			}
		})
	}
}

func TestACallResultWithNoContentIsNotMcps(t *testing.T) {
	for _, result := range []any{nil, map[string]any{"isError": false}} {
		f := &fake{answer: func(w http.ResponseWriter, req map[string]any) { reply(w, req["id"], result) }}
		r, _ := setup(t, f)
		if out := r.Run(context.Background(), call("post", `{}`)); out.Outcome != wire.OutcomeUnknown {
			t.Fatalf("%v: outcome %q (%s)", result, out.Outcome, out.Reason)
		}
	}
}

func TestAReadKeepsALargeIntegerAsTheServerWroteIt(t *testing.T) {
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%v,"result":{"contents":[{"uri":"a://b","text":"x",`+
			`"_meta":{"n":9007199254740993}}]}}`, req["id"])
	}}
	r, _ := setup(t, f)
	req := &wire.StartRequest{Kind: wire.KindMcp, MaxBody: 65536,
		Mcp: &wire.McpSpec{Server: "acme", Read: &wire.McpRead{URI: "a://b"}}}
	out := r.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeReturned || !strings.Contains(string(out.Mcp.Structured), "9007199254740993") {
		t.Fatalf("outcome %q (%s): %s", out.Outcome, out.Reason, out.Mcp.Structured)
	}
}

// leaked is a prefix of the token, of 3 bytes or more, that the reason keeps.
func leaked(reason string) string {
	for n := len(token); n >= 3; n-- {
		if strings.Contains(reason, token[:n]) {
			return token[:n]
		}
	}
	return ""
}

func TestASecretAcrossTheCutOfAnErrorMessageIsScrubbedWhole(t *testing.T) {
	for _, at := range []int{maxSaid - 7 - 3, maxSaid - 7 - 10, maxSaid - 7 - len(token) + 1} {
		t.Run(strconv.Itoa(at), func(t *testing.T) {
			f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
				replyError(w, req["id"], -32603, strings.Repeat("x", at)+"Bearer "+token+strings.Repeat("y", 64))
			}}
			r, _ := setup(t, f)
			out := r.Run(context.Background(), call("post", `{}`))
			if out.Outcome != wire.OutcomeUnknown {
				t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
			}
			if p := leaked(out.Reason); p != "" {
				t.Errorf("the reason keeps %q of the token: %s", p, out.Reason[len(out.Reason)-120:])
			}
		})
	}
}

func TestASecretAcrossTheCutOfTheProtocolVersionIsScrubbedWhole(t *testing.T) {
	f := &fake{initAnswer: func(w http.ResponseWriter, req map[string]any) {
		reply(w, req["id"], map[string]any{"protocolVersion": strings.Repeat("v", 60) + token,
			"capabilities": map[string]any{}})
	}, answer: func(http.ResponseWriter, map[string]any) { t.Error("the tool was called") }}
	r, _ := setup(t, f)
	out := r.Run(context.Background(), call("post", `{}`))
	if out.Outcome != wire.OutcomeUnreachable {
		t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
	}
	if p := leaked(out.Reason); p != "" {
		t.Errorf("the reason keeps %q of the token: %s", p, out.Reason)
	}
}

func TestAReadOfAResourceThatDoesNotExistIsRefused(t *testing.T) {
	f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
		replyError(w, req["id"], -32002, "Resource not found")
	}}
	r, _ := setup(t, f)
	read := &wire.StartRequest{Kind: wire.KindMcp, MaxBody: 65536,
		Mcp: &wire.McpSpec{Server: "acme", Read: &wire.McpRead{URI: "file:///gone.md"}}}
	if out := r.Run(context.Background(), read); out.Outcome != wire.OutcomeRefused ||
		!strings.Contains(out.Reason, "-32002") {
		t.Fatalf("read: outcome %q (%s)", out.Outcome, out.Reason)
	}
	// The same code from a tool is the tool's own error: it may have acted.
	if out := r.Run(context.Background(), call("post", `{}`)); out.Outcome != wire.OutcomeUnknown {
		t.Fatalf("call: outcome %q (%s)", out.Outcome, out.Reason)
	}
}

func TestAnEventStreamWhoseLinesEndWithCROrCRLFIsRead(t *testing.T) {
	for name, end := range map[string]string{"CR": "\r", "CRLF": "\r\n"} {
		t.Run(name, func(t *testing.T) {
			f := &fake{answer: func(w http.ResponseWriter, req map[string]any) {
				w.Header().Set("Content-Type", "text/event-stream")
				note, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "notifications/progress"})
				answer, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req["id"], "result": map[string]any{
					"content": []any{map[string]any{"type": "text", "text": "done"}}}})
				_, _ = fmt.Fprintf(w, "event: message%sdata: %s%s%sid: 1%sdata: %s%s%s",
					end, note, end, end, end, answer, end, end)
			}}
			r, _ := setup(t, f)
			out := r.Run(context.Background(), call("post", `{}`))
			if out.Outcome != wire.OutcomeReturned || out.Mcp.Text != "done" {
				t.Fatalf("outcome %q (%s)", out.Outcome, out.Reason)
			}
		})
	}
}
