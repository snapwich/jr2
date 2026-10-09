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

func TestVerifyAcceptsASignedRequestOnce(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	v := NewVerifier(key, func() time.Time { return now })
	at := strconv.FormatInt(now.UnixMilli(), 10)
	nonce := "nonce-0123456789abcdef"
	body := []byte(`{"kind":"http"}`)
	sig := RequestMAC(key, "POST", "/effects/e1", at, nonce, body)
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
	good := RequestMAC(key, "POST", "/effects/e1", at, nonce, body)
	cases := map[string]func(v *Verifier) error{
		"unsigned": func(v *Verifier) error { return v.Verify("POST", "/effects/e1", at, nonce, "", body) },
		"other key": func(v *Verifier) error {
			return v.Verify("POST", "/effects/e1", at, nonce, RequestMAC([]byte("another key"), "POST", "/effects/e1", at, nonce, body), body)
		},
		"other method": func(v *Verifier) error { return v.Verify("GET", "/effects/e1", at, nonce, good, body) },
		"other path":   func(v *Verifier) error { return v.Verify("POST", "/effects/e2", at, nonce, good, body) },
		"other body":   func(v *Verifier) error { return v.Verify("POST", "/effects/e1", at, nonce, good, []byte(`{"x":1}`)) },
		"no time":      func(v *Verifier) error { return v.Verify("POST", "/effects/e1", "", nonce, good, body) },
		"no nonce":     func(v *Verifier) error { return v.Verify("POST", "/effects/e1", at, "", good, body) },
		"stale": func(v *Verifier) error {
			old := strconv.FormatInt(now.Add(-Window-time.Second).UnixMilli(), 10)
			return v.Verify("POST", "/effects/e1", old, nonce, RequestMAC(key, "POST", "/effects/e1", old, nonce, body), body)
		},
		"future": func(v *Verifier) error {
			later := strconv.FormatInt(now.Add(Window+time.Second).UnixMilli(), 10)
			return v.Verify("POST", "/effects/e1", later, nonce, RequestMAC(key, "POST", "/effects/e1", later, nonce, body), body)
		},
	}
	for name, try := range cases {
		t.Run(name, func(t *testing.T) {
			v := NewVerifier(key, func() time.Time { return now })
			if err := try(v); err != ErrRefused {
				t.Fatalf("want ErrRefused, got %v", err)
			}
		})
	}
}

func TestANonceIsForgottenOnlyAfterItsWindow(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	v := NewVerifier(key, func() time.Time { return now })
	at := strconv.FormatInt(now.UnixMilli(), 10)
	nonce := "nonce-0123456789abcdef"
	sig := RequestMAC(key, "GET", "/effects/e1", at, nonce, nil)
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

// The golden signatures (ADR-0068): the TypeScript client signs and verifies the same fixtures.
func TestTheGoldenSignatures(t *testing.T) {
	var req struct {
		Key, Method, Path, Time, Nonce, Body, Signature string
	}
	read(t, "signature.request.json", &req)
	k, _ := base64.StdEncoding.DecodeString(req.Key)
	if got := RequestMAC(k, req.Method, req.Path, req.Time, req.Nonce, []byte(req.Body)); got != req.Signature {
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
