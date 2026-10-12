// Package sign is the Effector's authentication (ADR-0068): signed requests and signed
// responses, and no bearer. The key is the placement's, `HMAC(signing key, "effector:" +
// placement)`, which the Orchestrator derives and the Effector reads from a file in its own mount.
//
// A request carries an HMAC over its method, the address it is sent to (the replica's
// `POD_IP:port`), its path, a time, a nonce and the sha-256 of its body. The address, the time and
// the nonce make a replay detectable: a request signed for another replica, a request signed
// before this process started, a request outside the time window, or one with a nonce seen inside
// it, is refused. So a captured start sent again to another replica, or to this replica after its
// process restarted, starts nothing. A response carries an HMAC over its status, the
// request's method, path and nonce, and the sha-256 of its body — so an answer is bound to the one
// request it answers, and a process that took the Effector's port can forge neither.
package sign

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"
	"sync"
	"time"
)

// The headers a signed message carries.
const (
	HeaderTime      = "X-Jr2-Time"
	HeaderNonce     = "X-Jr2-Nonce"
	HeaderSignature = "X-Jr2-Signature"
)

// Window is how far a request's time may be from the Effector's clock, either way.
const Window = 5 * time.Minute

// RequestMAC is the signature of one request: base64url (no padding) of HMAC-SHA256 over
// "jr2-effector-request\n" + method + "\n" + address + "\n" + path + "\n" + time + "\n" + nonce +
// "\n" + hex(sha256(body)), where address is the `host:port` the request is sent to.
func RequestMAC(key []byte, method, address, path, at, nonce string, body []byte) string {
	return mac(key, "jr2-effector-request", method, address, path, at, nonce, bodyDigest(body))
}

// ResponseMAC is the signature of one response: HMAC-SHA256 over
// "jr2-effector-response\n" + status + "\n" + method + "\n" + path + "\n" + nonce + "\n" + hex(sha256(body)),
// where method, path and nonce are the request's.
func ResponseMAC(key []byte, status int, method, path, nonce string, body []byte) string {
	return mac(key, "jr2-effector-response", strconv.Itoa(status), method, path, nonce, bodyDigest(body))
}

func bodyDigest(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func mac(key []byte, parts ...string) string {
	m := hmac.New(sha256.New, key)
	for i, p := range parts {
		if i > 0 {
			m.Write([]byte{'\n'})
		}
		m.Write([]byte(p))
	}
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// ErrRefused is every verification failure. It says nothing about which check failed: a caller
// that is refused learns nothing.
var ErrRefused = errors.New("refused")

// Verifier checks requests against one key, for one replica's address and one process, and
// remembers the nonces it has seen.
type Verifier struct {
	key     []byte
	address string
	started time.Time
	now     func() time.Time
	// since is how long this process has run, on the monotonic clock: a step of the wall clock
	// does not move it.
	since func() time.Duration

	mu   sync.Mutex
	seen map[string]time.Time
}

// NewVerifier verifies with key the requests sent to address (this replica's `host:port`) and
// signed at or after started (when this process started); now is the clock (time.Now when nil).
// started carries the monotonic clock's reading when it is time.Now's: how long the process has
// run is read from it, never from the wall clock.
func NewVerifier(key []byte, address string, started time.Time, now func() time.Time) *Verifier {
	if now == nil {
		now = time.Now
	}
	origin := started
	since := func() time.Duration { return now().Sub(origin) }
	// To the millisecond, as a request's time is written.
	started = time.UnixMilli(started.UnixMilli())
	return &Verifier{key: key, address: address, started: started, now: now, since: since,
		seen: map[string]time.Time{}}
}

// startedNow is when this process started, on the wall clock as it reads now: the wall time it
// started at, or — when the wall clock stepped back since — now less how long it has run. A step
// back is a host's clock sync (NTP, a VM's clock correction); without it, every request signed in
// the step's length after it would read as signed before the process started, and be refused.
// The cost, which ADR-0068 names: a request signed in the step's length BEFORE the start is taken
// too, if it is inside the window and its nonce is unseen — a request carries only a wall time.
func (v *Verifier) startedNow(now time.Time) time.Time {
	if moved := time.UnixMilli(now.Add(-v.since()).UnixMilli()); moved.Before(v.started) {
		return moved
	}
	return v.started
}

// Key is the key the verifier holds, for signing the answers.
func (v *Verifier) Key() []byte { return v.key }

// Verify checks one request. It refuses a missing or wrong signature (a request signed for another
// address is one), a time before this process started or outside the window, and a nonce already
// seen inside it.
func (v *Verifier) Verify(method, path, at, nonce, signature string, body []byte) error {
	if at == "" || nonce == "" || signature == "" || len(nonce) < 16 || len(nonce) > 128 {
		return ErrRefused
	}
	want := RequestMAC(v.key, method, v.address, path, at, nonce, body)
	if !hmac.Equal([]byte(want), []byte(signature)) {
		return ErrRefused
	}
	ms, err := strconv.ParseInt(at, 10, 64)
	if err != nil {
		return ErrRefused
	}
	now := v.now()
	sent := time.UnixMilli(ms)
	v.mu.Lock()
	defer v.mu.Unlock()
	for n, until := range v.seen {
		if now.After(until) {
			delete(v.seen, n)
		}
	}
	// The nonces of the process before this one are gone: a request signed before this process
	// started (read by startedNow) is refused, so a restart forgets no replay signed earlier than
	// the start less any step back of the wall clock since it (startedNow's cost).
	if sent.Before(v.startedNow(now)) || sent.Before(now.Add(-Window)) || sent.After(now.Add(Window)) {
		return ErrRefused
	}
	if _, replay := v.seen[nonce]; replay {
		return ErrRefused
	}
	// Kept until the request's time leaves the window: past that the time check refuses it.
	v.seen[nonce] = sent.Add(Window)
	return nil
}
