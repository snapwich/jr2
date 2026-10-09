// Package httpkind runs the `http` kind (ADR-0068): one request, built in the Effector from the
// definition's parts and the secrets it holds, to a host the definition fixed.
//
// Every outcome is output (ADR-0067): `response` (a status came back), `unreachable` (nothing
// was sent: the name did not resolve, the connection or TLS failed), `refused` (the Effector
// refused it before anything was sent — a path segment that is `.`, `..` or empty, a host no
// Effect placed here names), and `unknown` (it may have been sent, and no answer came). A defect
// of jr2 or config — a secret this Effector does not hold — is no outcome: the server refuses
// the request before it starts.
package httpkind

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"maps"
	"mime"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// Runner runs http Effects for one Effector.
type Runner struct {
	Secrets  map[string]string
	Config   *secrets.Config
	Scrubber *scrub.Scrubber
	// Roots is the trust: the system roots plus the instance's caBundle (ADR-0020).
	Roots *x509.CertPool
}

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

// Run sends one request and answers its outcome, scrubbed.
func (r *Runner) Run(ctx context.Context, req *wire.StartRequest) wire.Output {
	built := map[string]string{}
	out := r.run(ctx, req, built)
	s := r.Scrubber.With(built)
	if out.Response != nil {
		for k, v := range out.Response.Headers {
			out.Response.Headers[k] = s.String(v)
		}
		out.Response.ContentType = s.String(out.Response.ContentType)
	}
	out.Reason = s.String(out.Reason)
	return out
}

func refused(reason string) wire.Output {
	return wire.Output{Outcome: wire.OutcomeRefused, Reason: reason + "; nothing was sent"}
}

func (r *Runner) run(ctx context.Context, req *wire.StartRequest, built map[string]string) wire.Output {
	target, err := r.target(req, built)
	if err != nil {
		return refused(err.Error())
	}

	header := http.Header{}
	for _, name := range slices.Sorted(maps.Keys(req.Headers)) {
		header.Set(name, r.fill(req.Headers[name]))
	}
	if req.Auth != nil {
		value, carries := r.authorization(req.Auth, built)
		header.Set("Authorization", value)
		built[value] = carries
	}
	var body io.Reader
	if req.Body != nil {
		switch {
		case req.Body.JSON != nil:
			body = bytes.NewReader(req.Body.JSON)
			if header.Get("Content-Type") == "" {
				header.Set("Content-Type", "application/json")
			}
		case req.Body.Text != nil:
			body = strings.NewReader(*req.Body.Text)
			if header.Get("Content-Type") == "" {
				header.Set("Content-Type", "text/plain; charset=utf-8")
			}
		}
	}

	ctx, cancel := context.WithTimeout(ctx, time.Duration(req.TimeoutMs)*time.Millisecond)
	defer cancel()
	var connected atomic.Bool
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
		GotConn: func(httptrace.GotConnInfo) { connected.Store(true) },
	})
	hreq, err := http.NewRequestWithContext(ctx, req.Method, target.String(), body)
	if err != nil {
		return refused(fmt.Sprintf("the request could not be built: %v", err))
	}
	hreq.Header = header
	resp, err := r.client().Do(hreq)
	if err != nil {
		if !connected.Load() {
			return wire.Output{Outcome: wire.OutcomeUnreachable, Reason: why(err) + "; nothing was sent"}
		}
		return wire.Output{
			Outcome: wire.OutcomeUnknown,
			Reason:  why(err) + "; the request may have reached the host, and no answer came",
		}
	}
	defer func() { _ = resp.Body.Close() }()
	return wire.Output{Outcome: wire.OutcomeResponse, Response: r.response(resp, req.MaxBody, built)}
}

// target builds the url: the definition's, its secrets filled (percent-encoded), each path
// segment encoded and appended. The host must be one an Effect placed here names (B5.2).
func (r *Runner) target(req *wire.StartRequest, built map[string]string) (*url.URL, error) {
	var raw strings.Builder
	var first string
	for _, part := range req.URL {
		if part.Text != nil {
			raw.WriteString(*part.Text)
			continue
		}
		if first == "" {
			first = *part.Secret
		}
		raw.WriteString(url.PathEscape(r.Secrets[*part.Secret]))
	}
	base, err := url.Parse(raw.String())
	if err != nil || (base.Scheme != "https" && base.Scheme != "http") || base.Host == "" {
		return nil, errors.New("the url is not an http(s) url with a host")
	}
	if base.User != nil {
		return nil, errors.New("the url carries userinfo")
	}
	var path strings.Builder
	path.WriteString(strings.TrimSuffix(base.EscapedPath(), "/"))
	for i, seg := range req.Path {
		if seg == "" || seg == "." || seg == ".." {
			return nil, fmt.Errorf("path segment %d is %q, which a path may not hold", i, seg)
		}
		path.WriteString("/" + url.PathEscape(seg))
	}
	full := base.Scheme + "://" + base.Host + path.String()
	if base.RawQuery != "" {
		full += "?" + base.RawQuery
	}
	u, err := url.Parse(full)
	if err != nil {
		return nil, fmt.Errorf("the url could not be built: %v", err)
	}
	port := 443
	if u.Scheme == "http" {
		port = 80
	}
	if p := u.Port(); p != "" {
		port, err = strconv.Atoi(p)
		if err != nil {
			return nil, errors.New("the url's port is not a number")
		}
	}
	if !r.Config.Allows(u.Scheme, u.Hostname(), port, req.Secrets()) {
		return nil, fmt.Errorf("%s://%s is not a host an Effect placed here names with these secrets", u.Scheme, u.Host)
	}
	if first != "" {
		built[u.String()] = first
		built[full] = first
		// What a server sees of it: the path and query alone — and every encoding of that.
		built[u.RequestURI()] = first
	}
	return u, nil
}

func (r *Runner) fill(t wire.Text) string {
	var b strings.Builder
	for _, part := range t {
		if part.Text != nil {
			b.WriteString(*part.Text)
		} else {
			b.WriteString(r.Secrets[*part.Secret])
		}
	}
	return b.String()
}

// authorization is the header value, and the secret it carries (what a match of it is named).
func (r *Runner) authorization(a *wire.Auth, built map[string]string) (string, string) {
	switch {
	case a.Bearer != nil:
		return "Bearer " + r.Secrets[a.Bearer.Secret], a.Bearer.Secret
	case a.Basic != nil:
		name := firstSecret(a.Basic.Password, firstSecret(a.Basic.User, ""))
		pair := []byte(r.fill(a.Basic.User) + ":" + r.fill(a.Basic.Password))
		encodings := []*base64.Encoding{
			base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding,
		}
		for _, enc := range encodings {
			built[enc.EncodeToString(pair)] = name
		}
		return "Basic " + base64.StdEncoding.EncodeToString(pair), name
	default:
		return r.fill(a.Text), firstSecret(a.Text, "")
	}
}

func firstSecret(t wire.Text, fallback string) string {
	for _, part := range t {
		if part.Secret != nil {
			return *part.Secret
		}
	}
	return fallback
}

func (r *Runner) client() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			// No proxy from the environment: the Effector calls the host the definition fixed.
			Proxy:               nil,
			DialContext:         (&net.Dialer{Timeout: 30 * time.Second}).DialContext,
			TLSClientConfig:     &tls.Config{RootCAs: r.Roots, MinVersion: tls.VersionTLS12},
			TLSHandshakeTimeout: 30 * time.Second,
			DisableKeepAlives:   true,
		},
		// A redirect is returned as the response, never followed: following it would send the
		// request — and its Authorization — to a host the definition did not fix.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// response reads the answer: every header, and the body when it is text — scrubbed as it streams
// and bounded to maxBody bytes. A body that is not text is never returned: its size and its
// content type are (B3.6).
func (r *Runner) response(resp *http.Response, maxBody int, built map[string]string) *wire.Response {
	headers := map[string]string{}
	for name, values := range resp.Header {
		headers[strings.ToLower(name)] = strings.Join(values, ", ")
	}
	out := &wire.Response{Status: resp.StatusCode, Headers: headers, ContentType: resp.Header.Get("Content-Type")}
	reader := bufio.NewReaderSize(resp.Body, 512)
	peek, _ := reader.Peek(512)
	if !isText(out.ContentType, peek) {
		n, _ := io.Copy(io.Discard, reader)
		out.Size = n
		return out
	}
	stream := r.Scrubber.With(built).Stream()
	var body []byte
	chunk := make([]byte, 32*1024)
	var err error
	for {
		var n int
		n, err = reader.Read(chunk)
		out.Size += int64(n)
		if n > 0 && len(body) <= maxBody {
			body = append(body, stream.Write(chunk[:n])...)
		}
		if err != nil {
			break
		}
	}
	if len(body) <= maxBody {
		body = append(body, stream.Flush()...)
	}
	if len(body) > maxBody {
		body = body[:maxBody]
		out.Truncated = true
	}
	if err != nil && !errors.Is(err, io.EOF) {
		// The body stopped before its end (the timeout, a reset): what came is returned, marked.
		out.Truncated = true
	}
	text := strings.ToValidUTF8(string(body), string(utf8.RuneError))
	out.Body = &text
	return out
}

// isText says whether a body is text: a text/* type, JSON, XML, a form, JavaScript; with no
// Content-Type, what the first bytes sniff as.
func isText(contentType string, peek []byte) bool {
	if contentType == "" {
		if len(peek) == 0 {
			return true
		}
		contentType = http.DetectContentType(peek)
	}
	media, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	switch {
	case strings.HasPrefix(media, "text/"),
		media == "application/json", strings.HasSuffix(media, "+json"),
		media == "application/xml", strings.HasSuffix(media, "+xml"),
		media == "application/x-www-form-urlencoded",
		media == "application/javascript", media == "application/x-ndjson":
		return true
	}
	return false
}

// why is an error in words, without Go's request line (the url is scrubbed anyway).
func why(err error) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "the timeout passed"
	}
	return err.Error()
}
