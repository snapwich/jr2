package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/mackind"
	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/sign"
	"github.com/snapwich/jr2/effector/internal/wire"
)

const hookSecret = "the-github-hook-secret"

// newMacServer is an Instance Effector that holds one Hook secret (ADR-0068).
func newMacServer(t *testing.T, mac MacChecker) *httptest.Server {
	t.Helper()
	s := New(Options{
		Verifier: sign.NewVerifier(key, replicaAddress, startedBefore(), nil),
		Runner:   &fakeRunner{release: make(chan struct{})},
		Mac:      mac,
		Scrubber: scrub.New(map[string]string{"GH_HOOK": hookSecret}),
		Replica:  wire.Replica{Name: "effector-a", Address: replicaAddress},
		Hold:     100 * time.Millisecond,
	})
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return srv
}

const signed = "the bytes the service signed"

func macBody(secret string, signature []byte) string {
	return `{"secret":"` + secret + `","alg":"sha256","bytes":"` + base64.StdEncoding.EncodeToString([]byte(signed)) +
		`","signature":"` + base64.StdEncoding.EncodeToString(signature) + `"}`
}

func hmacOf(secret string) []byte {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(signed))
	return m.Sum(nil)
}

func macAnswer(t *testing.T, a answer) wire.MacAnswer {
	t.Helper()
	var m wire.MacAnswer
	if err := wire.Decode(bytes.NewReader(a.body), &m); err != nil {
		t.Fatalf("%d %s: %v", a.status, a.body, err)
	}
	return m
}

func TestAMacCheckAnswersMatchOrNoMatchAndNothingMore(t *testing.T) {
	srv := newMacServer(t, &mackind.Checker{Secrets: map[string]string{"GH_HOOK": hookSecret}})
	good := call(t, srv.URL, "POST", wire.MacPath, macBody("GH_HOOK", hmacOf(hookSecret)), key)
	if good.status != http.StatusOK || !macAnswer(t, good).Match {
		t.Fatalf("a true signature: %d %s", good.status, good.body)
	}
	if string(good.body) != `{"match":true}` {
		t.Fatalf("the answer carries more than the match: %s", good.body)
	}
	bad := call(t, srv.URL, "POST", wire.MacPath, macBody("GH_HOOK", hmacOf("another")), key)
	if bad.status != http.StatusOK || macAnswer(t, bad).Match || string(bad.body) != `{"match":false}` {
		t.Fatalf("a forged signature: %d %s", bad.status, bad.body)
	}
}

func TestAMacCheckIsVerifiedBeforeItIsRead(t *testing.T) {
	srv := newMacServer(t, &mackind.Checker{Secrets: map[string]string{"GH_HOOK": hookSecret}})
	body := macBody("GH_HOOK", hmacOf(hookSecret))
	cases := map[string]answer{
		"unsigned":    send(t, srv.URL, "POST", wire.MacPath, body, "", "", ""),
		"another key": call(t, srv.URL, "POST", wire.MacPath, body, []byte("not the placement's key")),
	}
	for name, a := range cases {
		if a.status != http.StatusUnauthorized || len(a.body) != 0 {
			t.Errorf("%s: got %d %q", name, a.status, a.body)
		}
	}
}

func TestAMacCheckOfASecretNotHeldIsADefectThatNamesIt(t *testing.T) {
	srv := newMacServer(t, &mackind.Checker{Secrets: map[string]string{"GH_HOOK": hookSecret}})
	a := call(t, srv.URL, "POST", wire.MacPath, macBody("SLACK", hmacOf(hookSecret)), key)
	if a.status != http.StatusBadRequest || !strings.Contains(string(a.body), "secret SLACK") {
		t.Fatalf("got %d %s", a.status, a.body)
	}
	malformed := call(t, srv.URL, "POST", wire.MacPath, `{"secret":"GH_HOOK","alg":"md5","bytes":"","signature":""}`, key)
	if malformed.status != http.StatusBadRequest || !strings.Contains(string(malformed.body), "malformed") {
		t.Fatalf("an unknown alg: %d %s", malformed.status, malformed.body)
	}
	get := call(t, srv.URL, "GET", wire.MacPath, "", key)
	if get.status != http.StatusMethodNotAllowed {
		t.Fatalf("a GET: %d %s", get.status, get.body)
	}
}

// A Sandbox Effector serves no Hook (ADR-0068): with no checker, the route is not served.
func TestAnEffectorWithNoMacCheckerServesNoMacRoute(t *testing.T) {
	srv := newMacServer(t, nil)
	a := call(t, srv.URL, "POST", wire.MacPath, macBody("GH_HOOK", hmacOf(hookSecret)), key)
	if a.status != http.StatusNotFound {
		t.Fatalf("got %d %s", a.status, a.body)
	}
}
