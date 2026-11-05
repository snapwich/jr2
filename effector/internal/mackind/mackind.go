// Package mackind is the Instance Effector's `mac` check (ADR-0068, ADR-0078): the Hook's door
// sends the bytes that a service signed, the signature, the secret's name and the algorithm. The
// check computes the HMAC of the bytes with that secret and compares it with the signature in
// constant time. Its answer is "match" or "no match" and nothing more: no HMAC, no digest and no
// form of the secret leaves. It reads no header and no timestamp: the door makes every check that
// needs no secret. It knows no Hook kind and no service.
package mackind

import (
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // GitHub's legacy signature and other services sign with HMAC-SHA1.
	"crypto/sha256"
	"crypto/sha512"
	"hash"

	"github.com/snapwich/jr2/effector/internal/wire"
)

// Checker holds the secrets that a `mac` check can name: every secret placed in this Effector.
// `jr2 up` places a Hook's secret in the Instance Effector alone (ADR-0068).
type Checker struct {
	Secrets map[string]string
}

// Missing names the secret req names when this Effector does not hold it, or "". A missing secret
// is a defect of jr2 or of the config: `jr2 up` places the secret where a Hook names it.
func (c *Checker) Missing(req *wire.MacRequest) string {
	if _, ok := c.Secrets[req.Secret]; ok {
		return ""
	}
	return req.Secret
}

// Check says whether the HMAC of req's bytes with the named secret is req's signature. The compare
// takes the same time for every signature of the algorithm's length (hmac.Equal); a signature of
// another length is "no match". It needs a validated request and a secret that Missing found.
func (c *Checker) Check(req *wire.MacRequest) bool {
	secret, ok := c.Secrets[req.Secret]
	if !ok {
		return false
	}
	var h func() hash.Hash
	switch req.Alg {
	case wire.MacSHA256:
		h = sha256.New
	case wire.MacSHA1:
		h = sha1.New
	case wire.MacSHA512:
		h = sha512.New
	default:
		return false
	}
	m := hmac.New(h, []byte(secret))
	m.Write(req.Bytes)
	return hmac.Equal(m.Sum(nil), req.Signature)
}
