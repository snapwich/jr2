package scrub

import (
	"encoding/base64"
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
	if scrubber().String(basic) != basic {
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

func TestNothingHeldScrubsNothing(t *testing.T) {
	st := New(nil).Stream()
	if got := string(st.Write([]byte("plain"))) + string(st.Flush()); got != "plain" {
		t.Fatalf("got %q", got)
	}
}
