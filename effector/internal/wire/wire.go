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

// The kinds an Effector runs. The Instance Effector runs `http` with no Worktree file; the
// Sandbox Effector runs `push`, `command` and an `http` whose body is a Worktree file (ADR-0067,
// one kind, whose body decides the placement).
const (
	KindHTTP    = "http"
	KindPush    = "push"
	KindCommand = "command"
)

// Outcomes of an http Effect. Every outcome is output (ADR-0067).
const (
	OutcomeResponse    = "response"
	OutcomeUnreachable = "unreachable"
	OutcomeRefused     = "refused"
	OutcomeUnknown     = "unknown"
	// A push's outcomes besides `unknown`.
	OutcomePushed   = "pushed"
	OutcomeRejected = "rejected"
	OutcomeDiverged = "diverged"
	// A command's outcomes besides `unknown`.
	OutcomeExited  = "exited"
	OutcomeTimeout = "timeout"
	OutcomeKilled  = "killed"
)

// A pushed squash's `squashed`: the one commit it published is signed, or not.
const (
	SquashedSigned   = "signed"
	SquashedUnsigned = "unsigned"
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

// Body is the request body: JSON, text, or a Worktree file. At most one field is set; absent, no
// body.
type Body struct {
	JSON json.RawMessage `json:"json,omitempty"`
	Text *string         `json:"text,omitempty"`
	File *FileRef        `json:"file,omitempty"`
}

// FileRef is a file of a Worktree: the Worktree, relative to the work root (`/work`), and the
// file, relative to the Worktree. Both are opened beneath, with no symlink (package beneath).
type FileRef struct {
	Worktree    string `json:"worktree"`
	Path        string `json:"path"`
	ContentType string `json:"contentType,omitempty"`
}

// RepoRef is where one Repo Slot's repositories are in this pod (ADR-0004, ADR-0051): the
// Agent's common git dir and its Worktree, relative to the work root, and the node cache's key,
// under the Repo caches' mount.
type RepoRef struct {
	GitDir   string `json:"gitDir"`
	Worktree string `json:"worktree"`
	Cache    string `json:"cache"`
}

// Pair is one push's published commit and the Agent's commit it was made from: what the
// ledger's last push row holds, and the `pair` fallback reads.
type Pair struct {
	Published string `json:"published"`
	Source    string `json:"source"`
}

// PushSpec is a push's part of a start: the Workspace's branch to the Repo Slot's Binding.
type PushSpec struct {
	Repo   RepoRef `json:"repo"`
	URL    string  `json:"url"`
	Branch string  `json:"branch"`
	// Credential names the `git.credentials` entry whose push credential this spends, by its
	// match; absent, the Effector takes the entry of its config the url falls under — the longest
	// match, as ADR-0051's fence. The config holds the files; the url must fall under the entry.
	Credential string  `json:"credential,omitempty"`
	Pin        string  `json:"pin,omitempty"`
	Sign       bool    `json:"sign,omitempty"`
	Squash     *string `json:"squash,omitempty"`
	Force      bool    `json:"force,omitempty"`
	Last       *Pair   `json:"last,omitempty"`
}

// EnvRef is one variable of a credentialed command's env: a secret's value, or its file's path.
type EnvRef struct {
	Secret string `json:"secret"`
	Path   bool   `json:"path,omitempty"`
}

// CommandSpec is a credentialed command's part of a start (ADR-0067): argv, run against the
// pinned commit checked out into the Effect's own scratch, with only the env the author named.
type CommandSpec struct {
	Repo   RepoRef           `json:"repo"`
	Branch string            `json:"branch"`
	Pin    string            `json:"pin,omitempty"`
	Argv   []string          `json:"argv"`
	Env    map[string]EnvRef `json:"env"`
	Tail   int               `json:"tail"`
}

// StartRequest is the body of `POST /effects/<id>`.
type StartRequest struct {
	Kind      string          `json:"kind"`
	Method    string          `json:"method,omitempty"`
	URL       Text            `json:"url,omitempty"`
	Path      []string        `json:"path,omitempty"`
	Headers   map[string]Text `json:"headers,omitempty"`
	Auth      *Auth           `json:"auth,omitempty"`
	Body      *Body           `json:"body,omitempty"`
	Push      *PushSpec       `json:"push,omitempty"`
	Command   *CommandSpec    `json:"command,omitempty"`
	TimeoutMs int64           `json:"timeoutMs"`
	MaxBody   int             `json:"maxBody,omitempty"`
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
	// Pinned is the commit a push or a credentialed command runs against, read when it started
	// (the Agent's branch tip, or the pin): the Orchestrator writes it to the ledger's intent row.
	Pinned string  `json:"pinned,omitempty"`
	Output *Output `json:"output,omitempty"`
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

// PushResult is a push's outcome beside its name: `pushed` (published, source, and what the remote
// held before), `rejected` (the stage, git's words in detail), `diverged` (the published commit
// and the Agent's tip that could not be paired).
type PushResult struct {
	Published string `json:"published,omitempty"`
	Source    string `json:"source,omitempty"`
	Previous  string `json:"previous,omitempty"`
	// Via says how the new commits were found after a signed push: ancestry, pair, or cherry.
	Via string `json:"via,omitempty"`
	// Unchanged: the remote already held the published commit; nothing was sent.
	Unchanged bool `json:"unchanged,omitempty"`
	// Squashed says the published commit is one squashed commit, and whether it is signed
	// (SquashedSigned, SquashedUnsigned); "" for signed copies of the Agent's commits, or its own.
	Squashed string `json:"squashed,omitempty"`
	// Bundle is the published commits that are not the Agent's own, base64, for the sync step
	// (ADR-0067): commit objects only.
	Bundle string `json:"bundle,omitempty"`
	Stage  string `json:"stage,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// CommandResult is a command's outcome beside its name: how it ended and its stream's tail.
type CommandResult struct {
	Code   *int   `json:"code,omitempty"`
	Signal string `json:"signal,omitempty"`
	Tail   string `json:"tail"`
	// Dirty: the Worktree held edits that were not committed when the command started; it ran
	// against the commit, without them.
	Dirty bool `json:"dirty,omitempty"`
}

// Output is an Effect's outcome. Every outcome is output (ADR-0067). `response` carries a
// Response; a push's outcomes a PushResult; a command's a CommandResult; every other outcome a
// reason.
type Output struct {
	Outcome  string
	Response *Response
	Reason   string
	Push     *PushResult
	Command  *CommandResult
}

type responseJSON struct {
	Outcome string `json:"outcome"`
	Response
}

type reasonJSON struct {
	Outcome string `json:"outcome"`
	Reason  string `json:"reason"`
}

type pushedJSON struct {
	Outcome   string `json:"outcome"`
	Published string `json:"published"`
	Source    string `json:"source"`
	Previous  string `json:"previous,omitempty"`
	Via       string `json:"via,omitempty"`
	Unchanged bool   `json:"unchanged,omitempty"`
	Squashed  string `json:"squashed,omitempty"`
	Bundle    string `json:"bundle,omitempty"`
}

type rejectedJSON struct {
	Outcome string `json:"outcome"`
	Stage   string `json:"stage"`
	Reason  string `json:"reason"`
	Detail  string `json:"detail,omitempty"`
}

type divergedJSON struct {
	Outcome   string `json:"outcome"`
	Reason    string `json:"reason"`
	Published string `json:"published"`
	Source    string `json:"source"`
}

type exitedJSON struct {
	Outcome string `json:"outcome"`
	Code    int    `json:"code"`
	Tail    string `json:"tail"`
	Dirty   bool   `json:"dirty,omitempty"`
}

type timeoutJSON struct {
	Outcome string `json:"outcome"`
	Tail    string `json:"tail"`
	Dirty   bool   `json:"dirty,omitempty"`
}

type killedJSON struct {
	Outcome string `json:"outcome"`
	Signal  string `json:"signal"`
	Tail    string `json:"tail"`
	Dirty   bool   `json:"dirty,omitempty"`
}

// MarshalJSON writes one flat object per outcome.
func (o Output) MarshalJSON() ([]byte, error) {
	p, c := o.Push, o.Command
	if p == nil {
		p = &PushResult{}
	}
	if c == nil {
		c = &CommandResult{}
	}
	switch o.Outcome {
	case OutcomeResponse:
		if o.Response == nil {
			return nil, errors.New("wire: a response outcome without its response")
		}
		return json.Marshal(responseJSON{Outcome: o.Outcome, Response: *o.Response})
	case OutcomePushed:
		return json.Marshal(pushedJSON{Outcome: o.Outcome, Published: p.Published, Source: p.Source,
			Previous: p.Previous, Via: p.Via, Unchanged: p.Unchanged, Squashed: p.Squashed, Bundle: p.Bundle})
	case OutcomeRejected:
		return json.Marshal(rejectedJSON{Outcome: o.Outcome, Stage: p.Stage, Reason: o.Reason, Detail: p.Detail})
	case OutcomeDiverged:
		return json.Marshal(divergedJSON{Outcome: o.Outcome, Reason: o.Reason, Published: p.Published,
			Source: p.Source})
	case OutcomeExited:
		code := 0
		if c.Code != nil {
			code = *c.Code
		}
		return json.Marshal(exitedJSON{Outcome: o.Outcome, Code: code, Tail: c.Tail, Dirty: c.Dirty})
	case OutcomeTimeout:
		return json.Marshal(timeoutJSON{Outcome: o.Outcome, Tail: c.Tail, Dirty: c.Dirty})
	case OutcomeKilled:
		return json.Marshal(killedJSON{Outcome: o.Outcome, Signal: c.Signal, Tail: c.Tail, Dirty: c.Dirty})
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
	case OutcomePushed:
		var r pushedJSON
		if err := strict(raw, &r); err != nil {
			return err
		}
		*o = Output{Outcome: r.Outcome, Push: &PushResult{Published: r.Published, Source: r.Source,
			Previous: r.Previous, Via: r.Via, Unchanged: r.Unchanged, Squashed: r.Squashed, Bundle: r.Bundle}}
	case OutcomeRejected:
		var r rejectedJSON
		if err := strict(raw, &r); err != nil {
			return err
		}
		*o = Output{Outcome: r.Outcome, Reason: r.Reason, Push: &PushResult{Stage: r.Stage, Detail: r.Detail}}
	case OutcomeDiverged:
		var r divergedJSON
		if err := strict(raw, &r); err != nil {
			return err
		}
		*o = Output{Outcome: r.Outcome, Reason: r.Reason, Push: &PushResult{Published: r.Published, Source: r.Source}}
	case OutcomeExited:
		var r exitedJSON
		if err := strict(raw, &r); err != nil {
			return err
		}
		*o = Output{Outcome: r.Outcome, Command: &CommandResult{Code: &r.Code, Tail: r.Tail, Dirty: r.Dirty}}
	case OutcomeTimeout:
		var r timeoutJSON
		if err := strict(raw, &r); err != nil {
			return err
		}
		*o = Output{Outcome: r.Outcome, Command: &CommandResult{Tail: r.Tail, Dirty: r.Dirty}}
	case OutcomeKilled:
		var r killedJSON
		if err := strict(raw, &r); err != nil {
			return err
		}
		*o = Output{Outcome: r.Outcome, Command: &CommandResult{Signal: r.Signal, Tail: r.Tail, Dirty: r.Dirty}}
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
	if r.TimeoutMs <= 0 {
		return errors.New("timeoutMs is not positive")
	}
	switch r.Kind {
	case KindHTTP:
		if r.Push != nil || r.Command != nil {
			return fmt.Errorf("a %s start carries a push or a command", r.Kind)
		}
		return r.validateHTTP()
	case KindPush:
		if r.Push == nil || r.Command != nil || r.httpSet() {
			return errors.New("a push start carries exactly its push part")
		}
		return r.Push.validate()
	case KindCommand:
		if r.Command == nil || r.Push != nil || r.httpSet() {
			return errors.New("a command start carries exactly its command part")
		}
		return r.Command.validate()
	}
	return fmt.Errorf("kind %q is not one an Effector runs", r.Kind)
}

func (r *StartRequest) httpSet() bool {
	return r.Method != "" || r.URL != nil || r.Path != nil || r.Headers != nil || r.Auth != nil ||
		r.Body != nil || r.MaxBody != 0
}

var gitRef = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

// ValidBranch says whether name is a branch jr2 pushes or reads as data.
func ValidBranch(name string) bool {
	return gitRef.MatchString(name) && !strings.Contains(name, "..") && !strings.HasPrefix(name, "/") &&
		!strings.HasPrefix(name, "-") && !strings.HasSuffix(name, "/") && !strings.HasSuffix(name, ".lock")
}

var fullSha = regexp.MustCompile(`^[0-9a-f]{40}$`)

// relative says whether p is a path relative to a root, with no `..` component.
func relative(p string) bool {
	return p != "" && !strings.HasPrefix(p, "/") && !slices.Contains(strings.Split(p, "/"), "..") &&
		!strings.ContainsRune(p, 0)
}

func (r *RepoRef) validate() error {
	for _, p := range []string{r.GitDir, r.Worktree} {
		if !relative(p) {
			return fmt.Errorf("repo path %q is not relative to the work root", p)
		}
	}
	if !ValidSecretName(r.Cache) {
		return fmt.Errorf("repo cache %q is not a cache key", r.Cache)
	}
	return nil
}

func (p *PushSpec) validate() error {
	if err := p.Repo.validate(); err != nil {
		return err
	}
	if p.URL == "" || strings.HasPrefix(p.URL, "-") {
		return errors.New("push.url is empty or begins with -")
	}
	if !ValidBranch(p.Branch) {
		return fmt.Errorf("push.branch %q is not a branch name", p.Branch)
	}
	if p.Pin != "" && !fullSha.MatchString(p.Pin) {
		return fmt.Errorf("push.pin %q is not a full commit id", p.Pin)
	}
	if p.Squash != nil && strings.TrimSpace(*p.Squash) == "" {
		return errors.New("push.squash is an empty message")
	}
	if p.Last != nil && (!fullSha.MatchString(p.Last.Published) || !fullSha.MatchString(p.Last.Source)) {
		return errors.New("push.last is not two full commit ids")
	}
	return nil
}

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func (c *CommandSpec) validate() error {
	if err := c.Repo.validate(); err != nil {
		return err
	}
	if !ValidBranch(c.Branch) {
		return fmt.Errorf("command.branch %q is not a branch name", c.Branch)
	}
	if c.Pin != "" && !fullSha.MatchString(c.Pin) {
		return fmt.Errorf("command.pin %q is not a full commit id", c.Pin)
	}
	if len(c.Argv) == 0 || c.Argv[0] == "" {
		return errors.New("command.argv is empty")
	}
	if len(c.Env) == 0 {
		return errors.New("command.env names no secret: a command with none runs in the Harness container")
	}
	for name, ref := range c.Env {
		if !envName.MatchString(name) || name == "PATH" || name == "HOME" || name == "TMPDIR" {
			return fmt.Errorf("command.env %q is not a variable the author may set", name)
		}
		if !ValidSecretName(ref.Secret) {
			return fmt.Errorf("command.env.%s names %q, which is no secret name", name, ref.Secret)
		}
	}
	if c.Tail <= 0 {
		return errors.New("command.tail is not positive")
	}
	return nil
}

func (r *StartRequest) validateHTTP() error {
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
	if r.Body != nil {
		set := 0
		for _, b := range []bool{r.Body.JSON != nil, r.Body.Text != nil, r.Body.File != nil} {
			if b {
				set++
			}
		}
		if set > 1 {
			return errors.New("body sets more than one of json, text, file")
		}
		if f := r.Body.File; f != nil && !relative(f.Worktree) {
			return fmt.Errorf("body.file.worktree %q is not relative to the work root", f.Worktree)
		}
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

// Secrets lists every secret the request names, in order, once each. A push names its
// credential's files through the Effector's config, not here.
func (r *StartRequest) Secrets() []string {
	var names []string
	seen := map[string]bool{}
	if r.Command != nil {
		for _, name := range slices.Sorted(maps.Keys(r.Command.Env)) {
			if s := r.Command.Env[name].Secret; !seen[s] {
				seen[s] = true
				names = append(names, s)
			}
		}
	}
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
