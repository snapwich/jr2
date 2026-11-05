package mackind

import (
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // the test checks the sha1 algorithm a Hook kind can name.
	"crypto/sha256"
	"crypto/sha512"
	"hash"
	"testing"

	"github.com/snapwich/jr2/effector/internal/wire"
)

const secret = "hook-secret-value"

func sum(h func() hash.Hash, key, msg string) []byte {
	m := hmac.New(h, []byte(key))
	m.Write([]byte(msg))
	return m.Sum(nil)
}

func TestTheHMACOfTheBytesWithTheSecretMatchesForEachAlgorithm(t *testing.T) {
	c := &Checker{Secrets: map[string]string{"GH_HOOK": secret}}
	for alg, h := range map[string]func() hash.Hash{wire.MacSHA256: sha256.New, wire.MacSHA1: sha1.New,
		wire.MacSHA512: sha512.New} {
		req := &wire.MacRequest{Secret: "GH_HOOK", Alg: alg, Bytes: []byte("v0:1:{}"), Signature: sum(h, secret, "v0:1:{}")}
		if !c.Check(req) {
			t.Fatalf("%s: a true signature does not match", alg)
		}
	}
}

func TestAnotherSecretOtherBytesOrAnotherLengthIsNoMatch(t *testing.T) {
	c := &Checker{Secrets: map[string]string{"GH_HOOK": secret, "OTHER": "another-secret-value"}}
	good := sum(sha256.New, secret, "body")
	cases := map[string]*wire.MacRequest{
		"other secret": {Secret: "OTHER", Alg: wire.MacSHA256, Bytes: []byte("body"), Signature: good},
		"other bytes":  {Secret: "GH_HOOK", Alg: wire.MacSHA256, Bytes: []byte("body!"), Signature: good},
		"other alg":    {Secret: "GH_HOOK", Alg: wire.MacSHA512, Bytes: []byte("body"), Signature: good},
		"short":        {Secret: "GH_HOOK", Alg: wire.MacSHA256, Bytes: []byte("body"), Signature: good[:16]},
		"empty":        {Secret: "GH_HOOK", Alg: wire.MacSHA256, Bytes: []byte("body")},
		"not held":     {Secret: "NONE", Alg: wire.MacSHA256, Bytes: []byte("body"), Signature: good},
	}
	for name, req := range cases {
		if c.Check(req) {
			t.Fatalf("%s: matched", name)
		}
	}
}

func TestMissingNamesASecretThisEffectorDoesNotHold(t *testing.T) {
	c := &Checker{Secrets: map[string]string{"GH_HOOK": secret}}
	if got := c.Missing(&wire.MacRequest{Secret: "GH_HOOK"}); got != "" {
		t.Fatalf("held: %q", got)
	}
	if got := c.Missing(&wire.MacRequest{Secret: "NONE"}); got != "NONE" {
		t.Fatalf("not held: %q", got)
	}
}
