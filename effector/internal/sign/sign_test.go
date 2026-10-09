package sign

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

var key = []byte("0123456789abcdef0123456789abcdef")

// addr is the replica the verifier is: the address a request is signed for.
const addr = "10.244.0.17:8082"

func TestVerifyAcceptsASignedRequestOnce(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	v := NewVerifier(key, addr, now, func() time.Time { return now })
	at := strconv.FormatInt(now.UnixMilli(), 10)
	nonce := "nonce-0123456789abcdef"
	body := []byte(`{"kind":"http"}`)
	sig := RequestMAC(key, "POST", addr, "/effects/e1", at, nonce, body)
	if err := v.Verify("POST", "/effects/e1", at, nonce, sig, body); err != nil {
		t.Fatalf("a signed request is refused: %v", err)
	}
	if err := v.Verify("POST", "/effects/e1", at, nonce, sig, body); err == nil {
		t.Fatal("the same request sent again (a replay) is accepted")
	}
}

func TestVerifyRefusesWhatIsNotSignedByTheKey(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	at := strconv.FormatInt(now.UnixMilli(), 10)
	nonce := "nonce-0123456789abcdef"
	body := []byte(`{}`)
	good := RequestMAC(key, "POST", addr, "/effects/e1", at, nonce, body)
	cases := map[string]func(v *Verifier) error{
		"unsigned": func(v *Verifier) error { return v.Verify("POST", "/effects/e1", at, nonce, "", body) },
		"other key": func(v *Verifier) error {
			return v.Verify("POST", "/effects/e1", at, nonce, RequestMAC([]byte("another key"), "POST", addr, "/effects/e1", at, nonce, body), body)
		},
		"other method": func(v *Verifier) error { return v.Verify("GET", "/effects/e1", at, nonce, good, body) },
		"other path":   func(v *Verifier) error { return v.Verify("POST", "/effects/e2", at, nonce, good, body) },
		"other body":   func(v *Verifier) error { return v.Verify("POST", "/effects/e1", at, nonce, good, []byte(`{"x":1}`)) },
		"no time":      func(v *Verifier) error { return v.Verify("POST", "/effects/e1", "", nonce, good, body) },
		"no nonce":     func(v *Verifier) error { return v.Verify("POST", "/effects/e1", at, "", good, body) },
		"stale": func(v *Verifier) error {
			old := strconv.FormatInt(now.Add(-Window-time.Second).UnixMilli(), 10)
			return v.Verify("POST", "/effects/e1", old, nonce, RequestMAC(key, "POST", addr, "/effects/e1", old, nonce, body), body)
		},
		"future": func(v *Verifier) error {
			later := strconv.FormatInt(now.Add(Window+time.Second).UnixMilli(), 10)
			return v.Verify("POST", "/effects/e1", later, nonce, RequestMAC(key, "POST", addr, "/effects/e1", later, nonce, body), body)
		},
		// Another replica's start, sent here: the address is signed, so it is not this replica's.
		"another replica": func(v *Verifier) error {
			return v.Verify("POST", "/effects/e1", at, nonce, RequestMAC(key, "POST", "10.244.0.18:8082", "/effects/e1", at, nonce, body), body)
		},
	}
	for name, try := range cases {
		t.Run(name, func(t *testing.T) {
			// Started an hour ago: each case is refused by its own check, not by the start.
			v := NewVerifier(key, addr, now.Add(-time.Hour), func() time.Time { return now })
			if err := try(v); err != ErrRefused {
				t.Fatalf("want ErrRefused, got %v", err)
			}
		})
	}
}

func TestANonceIsForgottenOnlyAfterItsWindow(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	v := NewVerifier(key, addr, now, func() time.Time { return now })
	at := strconv.FormatInt(now.UnixMilli(), 10)
	nonce := "nonce-0123456789abcdef"
	sig := RequestMAC(key, "GET", addr, "/effects/e1", at, nonce, nil)
	if err := v.Verify("GET", "/effects/e1", at, nonce, sig, nil); err != nil {
		t.Fatal(err)
	}
	now = now.Add(Window + time.Second)
	if err := v.Verify("GET", "/effects/e1", at, nonce, sig, nil); err == nil {
		t.Fatal("a replay past the window is accepted")
	}
	if len(v.seen) != 0 {
		t.Fatalf("a nonce past its window is still kept: %d", len(v.seen))
	}
}

// A process does not know the nonces the process before it saw, so a request signed before this
// process started is refused: a captured start sent to a restarted replica starts nothing.
func TestARequestSignedBeforeTheProcessStartedIsRefused(t *testing.T) {
	started := time.UnixMilli(1_700_000_000_000)
	now := started.Add(time.Second)
	v := NewVerifier(key, addr, started, func() time.Time { return now })
	body := []byte(`{"kind":"http"}`)
	before := strconv.FormatInt(started.Add(-time.Millisecond).UnixMilli(), 10)
	sig := RequestMAC(key, "POST", addr, "/effects/e1", before, "nonce-before-the-start", body)
	if err := v.Verify("POST", "/effects/e1", before, "nonce-before-the-start", sig, body); err != ErrRefused {
		t.Fatalf("a request signed before the process started is not refused: %v", err)
	}
	at := strconv.FormatInt(started.UnixMilli(), 10)
	sig = RequestMAC(key, "POST", addr, "/effects/e1", at, "nonce-at-the-start-00", body)
	if err := v.Verify("POST", "/effects/e1", at, "nonce-at-the-start-00", sig, body); err != nil {
		t.Fatalf("a request signed as the process started is refused: %v", err)
	}
}

// The golden signatures (ADR-0068): the TypeScript client signs and verifies the same fixtures.
func TestTheGoldenSignatures(t *testing.T) {
	var req struct {
		Key, Method, Address, Path, Time, Nonce, Body, Signature string
	}
	read(t, "signature.request.json", &req)
	k, _ := base64.StdEncoding.DecodeString(req.Key)
	if got := RequestMAC(k, req.Method, req.Address, req.Path, req.Time, req.Nonce, []byte(req.Body)); got != req.Signature {
		t.Fatalf("request signature: got %s, the fixture says %s", got, req.Signature)
	}
	var res struct {
		Key, Method, Path, Nonce, Body, Signature string
		Status                                    int
	}
	read(t, "signature.response.json", &res)
	k, _ = base64.StdEncoding.DecodeString(res.Key)
	if got := ResponseMAC(k, res.Status, res.Method, res.Path, res.Nonce, []byte(res.Body)); got != res.Signature {
		t.Fatalf("response signature: got %s, the fixture says %s", got, res.Signature)
	}
}

func read(t *testing.T, name string, v any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "wire", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatal(err)
	}
}
