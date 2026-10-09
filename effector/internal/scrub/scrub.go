// Package scrub takes secret values out of what the Effector returns (ADR-0068, B3). It runs
// last, before an answer is signed, over every string that leaves: an http body, its headers,
// error text.
//
// It matches every secret the Effector holds — not only the ones the current Effect names — in
// three kinds of form: the exact value; its usual encodings (base64 in both alphabets, with and
// without padding, percent-encoding, JSON-escaped); and what the Effector itself built from it for
// one Effect (the Authorization header it sent, base64(user:password), the url with the secret in
// its path). Each match becomes `[secret:<name>]`.
//
// Not a goal, and the ADR says so: a transformed secret (a hash, a truncation, an encoding not
// listed here), a partial echo, a side channel. The claim is that an Effector does not return a
// secret it holds in the forms it sent or in common encodings.
package scrub

import (
	"bytes"
	"cmp"
	"encoding/base64"
	"net/url"
	"slices"
	"strings"
	"unicode/utf16"
)

// MinLength is the shortest Effect secret `jr2 up` and the Effector accept (B3.5): a shorter one
// would match ordinary text, and every match of it would be scrubbed.
const MinLength = 8

type form struct {
	value string
	name  string
}

// Scrubber holds the forms it replaces, longest first.
type Scrubber struct {
	forms []form
}

// New builds a scrubber for every secret the Effector holds, by name.
func New(secrets map[string]string) *Scrubber {
	s := &Scrubber{}
	for name, value := range secrets {
		s.add(name, value)
	}
	return s
}

// With returns a scrubber that also matches what one Effect built: `built` maps each built string
// (an Authorization header value, base64(user:password), a url) to the secret it carries.
func (s *Scrubber) With(built map[string]string) *Scrubber {
	out := &Scrubber{forms: slices.Clone(s.forms)}
	for value, name := range built {
		out.add(name, value)
	}
	return out
}

// add registers value and its encodings under name.
func (s *Scrubber) add(name, value string) {
	if value == "" {
		return
	}
	for _, f := range Forms(value) {
		if len(f) == 0 || slices.ContainsFunc(s.forms, func(x form) bool { return x.value == f }) {
			continue
		}
		s.forms = append(s.forms, form{value: f, name: name})
	}
	// Longest first, so a form that contains another is replaced whole.
	slices.SortStableFunc(s.forms, func(a, b form) int { return cmp.Compare(len(b.value), len(a.value)) })
}

// Forms lists one value's forms: exact; base64 (standard and url-safe, padded and not);
// percent-encoded as the common encoders spell it; and JSON-escaped as the common encoders spell
// it. An encoding has more than one spelling: which characters an encoder leaves as they are, and
// whether its hex is upper or lower case. A server echoes a secret in its own encoder's spelling,
// so each common spelling is a form.
func Forms(value string) []string {
	raw := []byte(value)
	forms := make([]string, 0, 7+2*len(percentSpellings)+jsonAll)
	forms = append(forms,
		value,
		base64.StdEncoding.EncodeToString(raw),
		base64.RawStdEncoding.EncodeToString(raw),
		base64.URLEncoding.EncodeToString(raw),
		base64.RawURLEncoding.EncodeToString(raw),
		url.QueryEscape(value),
		url.PathEscape(value),
	)
	for _, p := range percentSpellings {
		for _, hex := range []string{upperHex, lowerHex} {
			forms = append(forms, percentEncoded(value, p.keep, p.spacePlus, hex))
		}
	}
	for opts := range jsonAll {
		forms = append(forms, jsonEscaped(value, opts))
	}
	slices.Sort(forms)
	return slices.Compact(forms)
}

const (
	upperHex = "0123456789ABCDEF"
	lowerHex = "0123456789abcdef"
)

// percentSpellings are the sets of bytes the common percent-encoders leave as they are. Go's
// QueryEscape and PathEscape are listed in Forms itself.
var percentSpellings = []struct {
	keep      string
	spacePlus bool
}{
	{keep: ""},                   // RFC 3986 unreserved only (Python quote(safe=""), most libraries)
	{keep: "/"},                  // Python quote's default
	{keep: "!'()*"},              // JavaScript encodeURIComponent
	{keep: "!'()*;,/?:@&=+$#"},   // JavaScript encodeURI
	{keep: "*", spacePlus: true}, // application/x-www-form-urlencoded (URLSearchParams)
	{keep: "!$&'()*+,;=:@/"},     // a path's characters (RFC 3986 pchar and "/")
}

// percentEncoded encodes every byte but the unreserved ones and those in keep, in hex.
func percentEncoded(value, keep string, spacePlus bool, hex string) string {
	var b strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9',
			c == '-', c == '.', c == '_', c == '~' && !spacePlus:
			b.WriteByte(c)
		case c == ' ' && spacePlus:
			b.WriteByte('+')
		case strings.IndexByte(keep, c) >= 0:
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		}
	}
	return b.String()
}

// JSON spellings: each bit is one choice a common JSON encoder makes differently.
const (
	jsonSlash   = 1 << iota // `/` as `\/` (PHP's json_encode)
	jsonHTML                // `<`, `>`, `&` as <, >, & (Go's encoding/json)
	jsonASCII               // every non-ASCII rune as \uXXXX (Python's json.dumps)
	jsonUpper               // \u hex in upper case
	jsonShort               // \b and \f rather than \u0008 and \u000c (JavaScript's JSON.stringify)
	jsonLineSep             // U+2028 and U+2029 as   and   (Go's encoding/json)
	jsonAll     = 1 << iota
)

// jsonEscaped is the value as it sits inside a JSON string, without the quotes, in one spelling.
func jsonEscaped(value string, opts int) string {
	hex := lowerHex
	if opts&jsonUpper != 0 {
		hex = upperHex
	}
	var b strings.Builder
	u := func(r rune) {
		b.WriteString(`\u`)
		for shift := 12; shift >= 0; shift -= 4 {
			b.WriteByte(hex[(r>>shift)&15])
		}
	}
	for _, r := range value {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r == '\b' && opts&jsonShort != 0:
			b.WriteString(`\b`)
		case r == '\f' && opts&jsonShort != 0:
			b.WriteString(`\f`)
		case r < 0x20:
			u(r)
		case r == '/' && opts&jsonSlash != 0:
			b.WriteString(`\/`)
		case (r == '<' || r == '>' || r == '&') && opts&jsonHTML != 0:
			u(r)
		case (r == ' ' || r == ' ') && (opts&jsonLineSep != 0 || opts&jsonASCII != 0):
			u(r)
		case r > 0x7f && opts&jsonASCII != 0:
			if r > 0xffff {
				r1, r2 := utf16.EncodeRune(r)
				u(r1)
				u(r2)
			} else {
				u(r)
			}
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// Replacement is what a match of name becomes.
func Replacement(name string) string { return "[secret:" + name + "]" }

// String scrubs one string.
func (s *Scrubber) String(in string) string {
	for _, f := range s.forms {
		if strings.Contains(in, f.value) {
			in = strings.ReplaceAll(in, f.value, Replacement(f.name))
		}
	}
	return in
}

// Bytes scrubs one byte slice.
func (s *Scrubber) Bytes(in []byte) []byte {
	for _, f := range s.forms {
		v := []byte(f.value)
		if bytes.Contains(in, v) {
			in = bytes.ReplaceAll(in, v, []byte(Replacement(f.name)))
		}
	}
	return in
}

// Longest is the length of the longest form: a stream holds back one byte fewer than this.
func (s *Scrubber) Longest() int {
	if len(s.forms) == 0 {
		return 0
	}
	return len(s.forms[0].value)
}

// Stream scrubs a stream that arrives in chunks. A form split over two chunks is still matched:
// it keeps back the last `Longest()-1` bytes of what it has seen until the next chunk or Flush.
type Stream struct {
	s       *Scrubber
	pending []byte
}

// Stream starts a stream scrubber.
func (s *Scrubber) Stream() *Stream { return &Stream{s: s} }

// Write takes one chunk and returns what may leave now, scrubbed.
func (st *Stream) Write(chunk []byte) []byte {
	buf := st.s.Bytes(append(st.pending, chunk...))
	keep := max(st.s.Longest()-1, 0)
	if len(buf) <= keep {
		st.pending = buf
		return nil
	}
	out := buf[:len(buf)-keep]
	st.pending = slices.Clone(buf[len(buf)-keep:])
	return out
}

// Flush returns what is held back, scrubbed. The stream is then empty.
func (st *Stream) Flush() []byte {
	out := st.s.Bytes(st.pending)
	st.pending = nil
	return out
}
