package scrub

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

// A value with every character class an encoding changes: '/', '+', '=', a quote, a backslash,
// a space, '&', '<'.
const jira = `tok/en+val="ue\ & <x>`

func scrubber() *Scrubber {
	return New(map[string]string{"jira": jira, "other": "0th3r-s3cr3t-v4lue"})
}

func TestEachFormIsScrubbed(t *testing.T) {
	s := scrubber()
	raw := []byte(jira)
	forms := map[string]string{
		"exact":                jira,
		"base64":               base64.StdEncoding.EncodeToString(raw),
		"base64 no padding":    base64.RawStdEncoding.EncodeToString(raw),
		"base64url":            base64.URLEncoding.EncodeToString(raw),
		"base64url no padding": base64.RawURLEncoding.EncodeToString(raw),
		"percent (query)":      url.QueryEscape(jira),
		"percent (path)":       url.PathEscape(jira),
		"json-escaped":         `tok/en+val=\"ue\\ & <x>`,
	}
	for name, f := range forms {
		t.Run(name, func(t *testing.T) {
			got := s.String("before " + f + " after")
			if got != "before [secret:jira] after" {
				t.Fatalf("got %q", got)
			}
		})
	}
}

// A server echoes a secret in its own encoder's spelling. Each spelling below is what a common
// encoder writes for the value; each one is a form the scrubber removes. Each spelling is written
// out with its escapes, and none of them is the value itself.
func TestEachCommonEncodersSpellingIsScrubbed(t *testing.T) {
	const value = "s3cr3t/Tok+en=v&x!'(\u00e9)<q>"
	goJSON, err := json.Marshal(value) // Go's default: <, >, & as \u003c, \u003e, \u0026
	if err != nil {
		t.Fatal(err)
	}
	s := New(map[string]string{"tok": value, "k": "ab!cd+ef/gh&ij"})
	spellings := map[string]string{
		"JSON, Go encoding/json default":     strings.Trim(string(goJSON), `"`),
		"JSON, PHP json_encode (\\/)":        "s3cr3t\\/Tok+en=v&x!'(\u00e9)<q>",
		"JSON, Python json.dumps (\\u00e9)":  `s3cr3t/Tok+en=v&x!'(\u00e9)<q>`,
		"JSON, upper-case \\u hex":           `s3cr3t/Tok+en=v&x!'(\u00E9)<q>`,
		"JSON, \\/ and HTML-escaped":         "s3cr3t\\/Tok+en=v\\u0026x!'(\u00e9)\\u003cq\\u003e",
		"JSON, HTML-escaped, upper-case hex": "s3cr3t/Tok+en=v\\u0026x!'(\u00e9)\\u003Cq\\u003E",
		"percent, encodeURIComponent":        `s3cr3t%2FTok%2Ben%3Dv%26x!'(%C3%A9)%3Cq%3E`,
		"percent, encodeURIComponent, lower": `s3cr3t%2fTok%2ben%3dv%26x!'(%c3%a9)%3cq%3e`,
		"percent, encodeURI":                 `s3cr3t/Tok+en=v&x!'(%C3%A9)%3Cq%3E`,
		"percent, unreserved only":           `s3cr3t%2FTok%2Ben%3Dv%26x%21%27%28%C3%A9%29%3Cq%3E`,
		"percent, unreserved only, lower":    `s3cr3t%2fTok%2ben%3dv%26x%21%27%28%c3%a9%29%3cq%3e`,
		"percent, Python quote (keeps /)":    `s3cr3t/Tok%2Ben%3Dv%26x%21%27%28%C3%A9%29%3Cq%3E`,
		"percent, form (URLSearchParams)":    `s3cr3t%2FTok%2Ben%3Dv%26x%21%27%28%C3%A9%29%3Cq%3E`,
		"percent, the verifier's value":      `ab!cd%2Bef%2Fgh%26ij`,
		"percent, its value in lower hex":    `ab%21cd%2bef%2fgh%26ij`,
		"JSON, its value with \\/":           "ab!cd+ef\\/gh&ij",
		"JSON, its value HTML-escaped":       "ab!cd+ef/gh\\u0026ij",
	}
	for name, f := range spellings {
		t.Run(name, func(t *testing.T) {
			if f == value || f == "ab!cd+ef/gh&ij" {
				t.Fatalf("the spelling %q is the value itself, so it tests no encoding", f)
			}
			got := s.String("before " + f + " after")
			if got != "before [secret:tok] after" && got != "before [secret:k] after" {
				t.Fatalf("%q came back as %q", f, got)
			}
		})
	}
}

// The JSON escapes a common encoder writes for control characters, the line separators and a rune
// outside the Basic Multilingual Plane: each spelling is a form the scrubber removes.
func TestEachJSONEscapeOfAControlOrSeparatorIsScrubbed(t *testing.T) {
	const value = "ctl\b\f|\u2028|\u2029|\U0001F600-end"
	goJSON, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	s := New(map[string]string{"ctl": value})
	spellings := map[string]string{
		"Go encoding/json (U+2028 and U+2029 escaped)":       strings.Trim(string(goJSON), `"`),
		"JavaScript JSON.stringify (\\b, \\f; U+2028 as is)": "ctl\\b\\f|\u2028|\u2029|\U0001F600-end",
		"\\u0008 and \\u000c, U+2028 escaped":                "ctl\\u0008\\u000c|\\u2028|\\u2029|\U0001F600-end",
		"Python json.dumps (every non-ASCII rune escaped)":   "ctl\\b\\f|\\u2028|\\u2029|\\ud83d\\ude00-end",
		"Python json.dumps, upper-case hex":                  "ctl\\b\\f|\\u2028|\\u2029|\\uD83D\\uDE00-end",
	}
	for name, f := range spellings {
		t.Run(name, func(t *testing.T) {
			if f == value {
				t.Fatalf("the spelling %q is the value itself, so it tests no encoding", f)
			}
			if got := s.String("before " + f + " after"); got != "before [secret:ctl] after" {
				t.Fatalf("%q came back as %q", f, got)
			}
		})
	}
}

func TestASecretTheEffectDoesNotNameIsScrubbedToo(t *testing.T) {
	if got := scrubber().String("x 0th3r-s3cr3t-v4lue y"); got != "x [secret:other] y" {
		t.Fatalf("got %q", got)
	}
}

func TestWhatTheEffectorBuiltIsScrubbed(t *testing.T) {
	basic := base64.StdEncoding.EncodeToString([]byte("bot:" + jira))
	u := "https://api.example.com/bot" + url.PathEscape(jira) + "/send"
	s := scrubber().With(map[string]string{
		basic:            "jira",
		"Basic " + basic: "jira",
		u:                "jira",
	})
	cases := map[string]string{
		"the Authorization header it sent":    "Authorization: Basic " + basic,
		"base64(user:password)":               basic,
		"the url with the secret in its path": "GET " + u + " failed",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			got := s.String(in)
			if strings.Contains(got, basic) || strings.Contains(got, url.PathEscape(jira)) || !strings.Contains(got, "[secret:jira]") {
				t.Fatalf("got %q", got)
			}
		})
	}
	// The built form is the Effect's; the base scrubber is unchanged.
	base := scrubber()
	before := len(base.forms)
	base.With(map[string]string{u: "jira"})
	if len(base.forms) != before {
		t.Fatal("With changed the scrubber it was called on")
	}
}

func TestAValueSplitOverTwoChunksIsScrubbed(t *testing.T) {
	s := scrubber()
	text := "head " + jira + " middle " + base64.StdEncoding.EncodeToString([]byte(jira)) + " tail"
	for cut := 1; cut < len(text); cut++ {
		st := s.Stream()
		out := string(st.Write([]byte(text[:cut]))) + string(st.Write([]byte(text[cut:]))) + string(st.Flush())
		if out != "head [secret:jira] middle [secret:jira] tail" {
			t.Fatalf("cut at %d: got %q", cut, out)
		}
	}
}

func TestAStreamOfOneByteChunks(t *testing.T) {
	st := scrubber().Stream()
	var out strings.Builder
	for _, b := range []byte("a" + jira + "b") {
		out.Write(st.Write([]byte{b}))
	}
	out.Write(st.Flush())
	if out.String() != "a[secret:jira]b" {
		t.Fatalf("got %q", out.String())
	}
}

var base64Encodings = []*base64.Encoding{
	base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding,
}

// A server that base64-encodes a longer string that holds the secret — a dump of the request's
// headers, `a` + the Authorization header — puts the secret at any byte offset mod 3. At each of
// the three offsets, in both alphabets, with any bytes before and after it, the secret is
// scrubbed: no run of the answer decodes to the value.
func TestBase64OfALongerStringIsScrubbedAtEachOffset(t *testing.T) {
	const tok = "Tok3n+Secret/Value=Abc!xyz"
	s := New(map[string]string{"tok": tok})
	for _, enc := range base64Encodings {
		for _, before := range []string{"", "a", "ab", "abc", `{"authorization":"Bearer `} {
			for _, after := range []string{"", "!", "?>", `","x":"y"}`} {
				encoded := enc.EncodeToString([]byte(before + tok + after))
				got := s.String(encoded)
				if !strings.Contains(got, "[secret:tok]") {
					t.Fatalf("before %q, after %q: %q came back as %q", before, after, encoded, got)
				}
				for run := range strings.SplitSeq(got, "[secret:tok]") {
					for _, dec := range base64Encodings {
						if b, err := dec.DecodeString(run); err == nil && strings.Contains(string(b), tok) {
							t.Fatalf("before %q, after %q: a run of %q decodes to the value", before, after, got)
						}
					}
				}
			}
		}
	}
}

// The verifier's case: base64("a" + the Authorization header the Effector built), and base64 of a
// JSON dump of the request's headers, which holds base64(user:password) at an offset.
func TestBase64OfWhatTheEffectorBuiltAtAnOffsetIsScrubbed(t *testing.T) {
	const tok = "Tok3n+Secret/Value=Abc!xyz"
	const pw = "pw-Secret_Value9"
	basic := "Basic " + base64.StdEncoding.EncodeToString([]byte("bot:"+pw))
	s := New(map[string]string{"tok": tok, "pw": pw}).With(map[string]string{"Bearer " + tok: "tok", basic: "pw"})
	for _, plain := range []string{
		"aBearer " + tok,
		`{"accept":"*/*","authorization":"` + basic + `","x":"y"}`,
	} {
		encoded := base64.StdEncoding.EncodeToString([]byte(plain))
		got := s.String(encoded)
		if !strings.Contains(got, "[secret:") {
			t.Fatalf("%q came back as %q", encoded, got)
		}
	}
}

func TestNothingHeldScrubsNothing(t *testing.T) {
	st := New(nil).Stream()
	if got := string(st.Write([]byte("plain"))) + string(st.Flush()); got != "plain" {
		t.Fatalf("got %q", got)
	}
}
