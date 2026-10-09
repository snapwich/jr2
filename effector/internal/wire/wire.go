// Package wire holds the Effector's wire types (ADR-0068), written by hand. The TypeScript side
// (`@jr2/orchestrator`, effector-wire.ts) writes the same shapes with zod, and the golden fixtures
// in effector/testdata/wire keep the two equal: Go decodes each request fixture and encodes each
// response fixture; TypeScript encodes the requests and decodes the responses. There is no code
// generator. A decode refuses an unknown field.
package wire

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"regexp"
	"slices"
	"strings"
)

// KindHTTP is the one kind the Instance Effector runs.
const KindHTTP = "http"

// Outcomes of an http Effect. Every outcome is output (ADR-0067).
const (
	OutcomeResponse    = "response"
	OutcomeUnreachable = "unreachable"
	OutcomeRefused     = "refused"
	OutcomeUnknown     = "unknown"
)

// States of one Effect as a replica answers for it.
const (
	StateRunning = "running"
	StateSettled = "settled"
	StateUnknown = "unknown"
)

// Methods an http Effect may send.
var methods = map[string]bool{
	"GET": true, "HEAD": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true, "OPTIONS": true,
}

// Headers the Effector sets itself, which a definition may not.
var framing = map[string]bool{
	"host": true, "content-length": true, "transfer-encoding": true, "connection": true,
	"upgrade": true, "te": true, "trailer": true, "keep-alive": true,
}

// TextPart is one part of a Text: literal text, or the value of a secret the Effector holds.
// Exactly one field is set.
type TextPart struct {
	Text   *string `json:"text,omitempty"`
	Secret *string `json:"secret,omitempty"`
}

// Text is a string the Effector builds: the `text` template of the definition, where a secret is
// a part and never a value on the wire.
type Text []TextPart

// SecretRef names one secret.
type SecretRef struct {
	Secret string `json:"secret"`
}

// Basic is `basic(user, password)`.
type Basic struct {
	User     Text `json:"user"`
	Password Text `json:"password"`
}

// Auth is the Authorization header the Effector builds. Exactly one field is set.
type Auth struct {
	Bearer *SecretRef `json:"bearer,omitempty"`
	Basic  *Basic     `json:"basic,omitempty"`
	Text   Text       `json:"text,omitempty"`
}

// Body is the request body: JSON, or text. At most one field is set; absent, no body.
type Body struct {
	JSON json.RawMessage `json:"json,omitempty"`
	Text *string         `json:"text,omitempty"`
}

// StartRequest is the body of `POST /effects/<id>`.
type StartRequest struct {
	Kind      string          `json:"kind"`
	Method    string          `json:"method"`
	URL       Text            `json:"url"`
	Path      []string        `json:"path,omitempty"`
	Headers   map[string]Text `json:"headers,omitempty"`
	Auth      *Auth           `json:"auth,omitempty"`
	Body      *Body           `json:"body,omitempty"`
	TimeoutMs int64           `json:"timeoutMs"`
	MaxBody   int             `json:"maxBody"`
}

// Replica names the pod that holds an Effect, and where to poll it.
type Replica struct {
	Name    string `json:"name"`
	Address string `json:"address"`
}

// EffectState is every answer of `POST` and `GET /effects/<id>`.
type EffectState struct {
	Effect  string  `json:"effect"`
	Replica Replica `json:"replica"`
	State   string  `json:"state"`
	Output  *Output `json:"output,omitempty"`
}

// Refusal is the body of an answer that started nothing: a malformed request (400), or a replica
// that is stopping (503).
type Refusal struct {
	Error   string   `json:"error"`
	Replica *Replica `json:"replica,omitempty"`
}

// Response is the `response` outcome: the status, the headers, and the body when it is text.
type Response struct {
	Status      int               `json:"status"`
	Headers     map[string]string `json:"headers"`
	ContentType string            `json:"contentType"`
	Size        int64             `json:"size"`
	Body        *string           `json:"body,omitempty"`
	Truncated   bool              `json:"truncated,omitempty"`
}

// Output is an http Effect's outcome. `response` carries a Response; every other outcome a reason.
type Output struct {
	Outcome  string
	Response *Response
	Reason   string
}

type responseJSON struct {
	Outcome string `json:"outcome"`
	Response
}

type reasonJSON struct {
	Outcome string `json:"outcome"`
	Reason  string `json:"reason"`
}

// MarshalJSON writes one flat object per outcome.
func (o Output) MarshalJSON() ([]byte, error) {
	if o.Outcome == OutcomeResponse {
		if o.Response == nil {
			return nil, errors.New("wire: a response outcome without its response")
		}
		return json.Marshal(responseJSON{Outcome: o.Outcome, Response: *o.Response})
	}
	return json.Marshal(reasonJSON{Outcome: o.Outcome, Reason: o.Reason})
}

// UnmarshalJSON reads one flat object, strictly.
func (o *Output) UnmarshalJSON(raw []byte) error {
	var head struct {
		Outcome string `json:"outcome"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return err
	}
	switch head.Outcome {
	case OutcomeResponse:
		var r responseJSON
		if err := strict(raw, &r); err != nil {
			return err
		}
		*o = Output{Outcome: OutcomeResponse, Response: &r.Response}
	case OutcomeUnreachable, OutcomeRefused, OutcomeUnknown:
		var r reasonJSON
		if err := strict(raw, &r); err != nil {
			return err
		}
		*o = Output{Outcome: r.Outcome, Reason: r.Reason}
	default:
		return fmt.Errorf("wire: unknown outcome %q", head.Outcome)
	}
	return nil
}

// Decode reads one JSON value into v, refusing an unknown field and trailing data.
func Decode(r io.Reader, v any) error {
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("wire: trailing data after the JSON value")
	}
	if _, err := dec.Token(); err != io.EOF {
		return errors.New("wire: trailing data after the JSON value")
	}
	return nil
}

func strict(raw []byte, v any) error { return Decode(bytes.NewReader(raw), v) }

// Encode writes v as JSON without HTML escaping, so a string is the bytes the scrubber matched.
func Encode(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

var (
	effectID   = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	secretName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,253}$`)
	headerName = regexp.MustCompile("^[a-z0-9!#$%&'*+.^_`|~-]+$")
)

// ValidEffectID says whether id may name an Effect.
func ValidEffectID(id string) bool { return effectID.MatchString(id) && id != "." && id != ".." }

// ValidSecretName says whether name may name a secret (a file under the secrets mount).
func ValidSecretName(name string) bool {
	return secretName.MatchString(name) && !strings.HasPrefix(name, ".")
}

// Validate checks what a decode cannot: the kind, the method, the one-of fields, the names.
// What the Agent can cause (a path segment, a host the url names) is not checked here: that is
// output, never a refused request (ADR-0068).
func (r *StartRequest) Validate() error {
	if r.Kind != KindHTTP {
		return fmt.Errorf("kind %q is not one this Effector runs", r.Kind)
	}
	if !methods[r.Method] {
		return fmt.Errorf("method %q is not one an http Effect may send", r.Method)
	}
	if len(r.URL) == 0 {
		return errors.New("url is empty")
	}
	if err := r.URL.validate("url"); err != nil {
		return err
	}
	for name, value := range r.Headers {
		if !headerName.MatchString(name) {
			return fmt.Errorf("header %q is not a lowercase header name", name)
		}
		if framing[name] || strings.HasPrefix(name, "proxy-") {
			return fmt.Errorf("header %q frames or routes the request; the Effector sets it", name)
		}
		if err := value.validate("headers." + name); err != nil {
			return err
		}
	}
	if r.Auth != nil {
		if err := r.Auth.validate(); err != nil {
			return err
		}
	}
	if r.Body != nil && r.Body.JSON != nil && r.Body.Text != nil {
		return errors.New("body has both json and text")
	}
	if r.TimeoutMs <= 0 {
		return errors.New("timeoutMs is not positive")
	}
	if r.MaxBody <= 0 {
		return errors.New("maxBody is not positive")
	}
	return nil
}

func (a *Auth) validate() error {
	set := 0
	if a.Bearer != nil {
		set++
		if !ValidSecretName(a.Bearer.Secret) {
			return fmt.Errorf("auth.bearer names %q, which is no secret name", a.Bearer.Secret)
		}
	}
	if a.Basic != nil {
		set++
		if err := a.Basic.User.validate("auth.basic.user"); err != nil {
			return err
		}
		if err := a.Basic.Password.validate("auth.basic.password"); err != nil {
			return err
		}
	}
	if a.Text != nil {
		set++
		if err := a.Text.validate("auth.text"); err != nil {
			return err
		}
	}
	if set != 1 {
		return errors.New("auth sets not exactly one of bearer, basic, text")
	}
	return nil
}

func (t Text) validate(at string) error {
	for i, part := range t {
		if (part.Text == nil) == (part.Secret == nil) {
			return fmt.Errorf("%s[%d] is not exactly one of text, secret", at, i)
		}
		if part.Secret != nil && !ValidSecretName(*part.Secret) {
			return fmt.Errorf("%s[%d] names %q, which is no secret name", at, i, *part.Secret)
		}
	}
	return nil
}

// Secrets lists every secret the request names, in order, once each.
func (r *StartRequest) Secrets() []string {
	var names []string
	seen := map[string]bool{}
	add := func(t Text) {
		for _, part := range t {
			if part.Secret != nil && !seen[*part.Secret] {
				seen[*part.Secret] = true
				names = append(names, *part.Secret)
			}
		}
	}
	add(r.URL)
	for _, name := range slices.Sorted(maps.Keys(r.Headers)) {
		add(r.Headers[name])
	}
	if r.Auth != nil {
		if r.Auth.Bearer != nil {
			add(Text{{Secret: &r.Auth.Bearer.Secret}})
		}
		if r.Auth.Basic != nil {
			add(r.Auth.Basic.User)
			add(r.Auth.Basic.Password)
		}
		add(r.Auth.Text)
	}
	return names
}
