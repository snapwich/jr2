package httpkind

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

const token = "bearer-token/with+chars=="

var held = map[string]string{"jira": token, "pw": "basic-password-value", "tg": "123456:telegram-bot-token"}

func runner(t *testing.T, srv *httptest.Server, names ...string) *Runner {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	roots := x509.NewCertPool()
	if srv.Certificate() != nil {
		roots.AddCert(srv.Certificate())
	}
	return &Runner{
		Secrets:  held,
		Config:   &secrets.Config{Version: 1, Placement: "instance", Targets: []secrets.Target{{Scheme: u.Scheme, Host: u.Hostname(), Port: port, Secrets: names}}},
		Scrubber: scrub.New(held),
		Roots:    roots,
	}
}

func text(s string) wire.TextPart   { return wire.TextPart{Text: &s} }
func secret(s string) wire.TextPart { return wire.TextPart{Secret: &s} }

func request(base string) *wire.StartRequest {
	return &wire.StartRequest{Kind: "http", Method: "GET", URL: wire.Text{text(base)}, TimeoutMs: 5000, MaxBody: 65536}
}

// The echo server of the B3 proof: it returns every header it got and the url, in each encoding.
func echo() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var b strings.Builder
		for name, values := range r.Header {
			for _, v := range values {
				fmt.Fprintf(&b, "%s: %s\n", name, v)
				fmt.Fprintf(&b, "b64 %s\n", base64.StdEncoding.EncodeToString([]byte(v)))
				fmt.Fprintf(&b, "pct %s\n", url.QueryEscape(v))
			}
		}
		fmt.Fprintf(&b, "url %s\nraw %s\n", r.URL.String(), r.RequestURI)
		fmt.Fprintf(&b, "url-b64 %s\nurl-b64url %s\nurl-pct %s\n", base64.StdEncoding.EncodeToString([]byte(r.RequestURI)),
			base64.RawURLEncoding.EncodeToString([]byte(r.RequestURI)), url.QueryEscape(r.RequestURI))
		body, _ := io.ReadAll(r.Body)
		fmt.Fprintf(&b, "body %s\n", body)
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("X-Echo-Auth", r.Header.Get("Authorization"))
		_, _ = io.WriteString(w, b.String())
	}
}

func TestABearerRequestAndItsEchoComeBackScrubbed(t *testing.T) {
	srv := httptest.NewTLSServer(echo())
	defer srv.Close()
	req := request(srv.URL + "/rest/api")
	req.Method = "POST"
	req.Path = []string{"issue", "PROJ-1", "comment"}
	req.Auth = &wire.Auth{Bearer: &wire.SecretRef{Secret: "jira"}}
	req.Body = &wire.Body{JSON: json.RawMessage(`{"body":"hello"}`)}
	out := runner(t, srv, "jira").Run(context.Background(), req)
	if out.Outcome != wire.OutcomeResponse || out.Response.Status != 200 {
		t.Fatalf("got %+v", out)
	}
	body := *out.Response.Body
	for _, leak := range scrub.Forms(token) {
		if strings.Contains(body, leak) || strings.Contains(out.Response.Headers["x-echo-auth"], leak) {
			t.Fatalf("a form of the secret came back: %q in %q", leak, body)
		}
	}
	// The whole header it built is one form (B3.2): it is replaced whole.
	if !strings.Contains(body, "Authorization: [secret:jira]") || out.Response.Headers["x-echo-auth"] != "[secret:jira]" {
		t.Fatalf("the Authorization header is not named: %q / %q", body, out.Response.Headers["x-echo-auth"])
	}
	if !strings.Contains(body, "url /rest/api/issue/PROJ-1/comment") || !strings.Contains(body, `body {"body":"hello"}`) {
		t.Fatalf("the request is not what the definition built: %q", body)
	}
}

func TestBasicAuthAndASecretInTheUrlPathComeBackScrubbed(t *testing.T) {
	srv := httptest.NewServer(echo())
	defer srv.Close()
	req := request("")
	req.URL = wire.Text{text(srv.URL + "/bot"), secret("tg"), text("/sendMessage")}
	req.Auth = &wire.Auth{Basic: &wire.Basic{User: wire.Text{text("bot")}, Password: wire.Text{secret("pw")}}}
	out := runner(t, srv, "tg", "pw").Run(context.Background(), req)
	if out.Outcome != wire.OutcomeResponse {
		t.Fatalf("got %+v", out)
	}
	body := *out.Response.Body
	pair := base64.StdEncoding.EncodeToString([]byte("bot:basic-password-value"))
	path := "/bot" + url.PathEscape(held["tg"]) + "/sendMessage"
	leaks := append(append(scrub.Forms(held["tg"]), scrub.Forms(held["pw"])...), pair, url.QueryEscape("Basic "+pair),
		base64.StdEncoding.EncodeToString([]byte("Basic "+pair)), base64.StdEncoding.EncodeToString([]byte(path)),
		base64.RawURLEncoding.EncodeToString([]byte(path)))
	for _, leak := range leaks {
		if strings.Contains(body, leak) {
			t.Fatalf("%q came back in %q", leak, body)
		}
	}
	if !strings.Contains(body, "Authorization: [secret:pw]") || !strings.Contains(body, "url [secret:tg]\nraw [secret:tg]\nurl-b64 [secret:tg]") {
		t.Fatalf("got %q", body)
	}
}

func TestAPathSegmentIsEncodedAndADotSegmentIsRefusedWithNoSend(t *testing.T) {
	var sends atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		_, _ = io.WriteString(w, r.URL.EscapedPath())
	}))
	defer srv.Close()
	r := runner(t, srv)
	req := request(srv.URL + "/base/")
	req.Path = []string{"a/b?c", "d e", "%2e%2e"}
	out := r.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeResponse || *out.Response.Body != "/base/a%2Fb%3Fc/d%20e/%252e%252e" {
		t.Fatalf("got %+v %q", out, *out.Response.Body)
	}
	for _, bad := range []string{"", ".", ".."} {
		req := request(srv.URL)
		req.Path = []string{"ok", bad}
		before := sends.Load()
		out := r.Run(context.Background(), req)
		if out.Outcome != wire.OutcomeRefused || !strings.Contains(out.Reason, "nothing was sent") {
			t.Fatalf("segment %q: got %+v", bad, out)
		}
		if sends.Load() != before {
			t.Fatalf("segment %q was sent", bad)
		}
	}
}

func TestAHostTheDefinitionDidNotFixIsRefusedWithNoSend(t *testing.T) {
	var sends atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { sends.Add(1) }))
	defer srv.Close()
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { sends.Add(1) }))
	defer other.Close()
	r := runner(t, srv, "jira")
	req := request(other.URL)
	req.Auth = &wire.Auth{Bearer: &wire.SecretRef{Secret: "jira"}}
	if out := r.Run(context.Background(), req); out.Outcome != wire.OutcomeRefused {
		t.Fatalf("got %+v", out)
	}
	// The configured host, with a secret no Effect sends there.
	req = request(srv.URL)
	req.Auth = &wire.Auth{Bearer: &wire.SecretRef{Secret: "pw"}}
	if out := r.Run(context.Background(), req); out.Outcome != wire.OutcomeRefused {
		t.Fatalf("got %+v", out)
	}
	if sends.Load() != 0 {
		t.Fatalf("%d requests were sent", sends.Load())
	}
}

func TestARedirectIsTheResponseAndIsNotFollowed(t *testing.T) {
	var followed atomic.Bool
	away := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { followed.Store(true) }))
	defer away.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, away.URL, http.StatusFound)
	}))
	defer srv.Close()
	out := runner(t, srv).Run(context.Background(), request(srv.URL))
	if out.Outcome != wire.OutcomeResponse || out.Response.Status != 302 || followed.Load() {
		t.Fatalf("got %+v, followed %v", out, followed.Load())
	}
}

func TestANonTextBodyIsItsSizeAndTypeOnly(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write([]byte(token + "\x00\x01\x02"))
	}))
	defer srv.Close()
	out := runner(t, srv).Run(context.Background(), request(srv.URL))
	if out.Response.Body != nil || out.Response.Size != int64(len(token)+3) || out.Response.ContentType != "application/octet-stream" {
		t.Fatalf("got %+v", out.Response)
	}
}

func TestATextBodyIsBoundedAndScrubbedAcrossTheCut(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, strings.Repeat("x", 10)+token+strings.Repeat("y", 100))
	}))
	defer srv.Close()
	req := request(srv.URL)
	req.MaxBody = 14
	out := runner(t, srv).Run(context.Background(), req)
	if *out.Response.Body != "xxxxxxxxxx[sec" || !out.Response.Truncated || out.Response.Size != int64(110+len(token)) {
		t.Fatalf("got %+v %q", out.Response, *out.Response.Body)
	}
}

func TestNothingListeningIsUnreachable(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	_ = l.Close()
	srv := &httptest.Server{URL: "http://" + addr}
	out := runner(t, srv).Run(context.Background(), request("http://"+addr))
	if out.Outcome != wire.OutcomeUnreachable {
		t.Fatalf("got %+v", out)
	}
}

func TestNoAnswerWithinTheTimeoutIsUnknown(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	defer srv.Close()
	defer close(release)
	req := request(srv.URL)
	req.TimeoutMs = 100
	start := time.Now()
	out := runner(t, srv).Run(context.Background(), req)
	if out.Outcome != wire.OutcomeUnknown || !strings.Contains(out.Reason, "the timeout passed") || time.Since(start) > 3*time.Second {
		t.Fatalf("got %+v", out)
	}
}

func TestAnUntrustedCertificateIsUnreachable(t *testing.T) {
	srv := httptest.NewTLSServer(echo())
	defer srv.Close()
	r := runner(t, srv)
	r.Roots = x509.NewCertPool()
	if out := r.Run(context.Background(), request(srv.URL)); out.Outcome != wire.OutcomeUnreachable {
		t.Fatalf("got %+v", out)
	}
}

func TestMissingNamesASecretTheEffectorDoesNotHold(t *testing.T) {
	r := &Runner{Secrets: held}
	req := request("https://x.example.com")
	req.Auth = &wire.Auth{Bearer: &wire.SecretRef{Secret: "absent"}}
	if got := r.Missing(req); got != "absent" {
		t.Fatalf("got %q", got)
	}
	req.Auth = &wire.Auth{Bearer: &wire.SecretRef{Secret: "jira"}}
	if got := r.Missing(req); got != "" {
		t.Fatalf("got %q", got)
	}
}
