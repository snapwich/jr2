package wire

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The golden fixtures (ADR-0068) live in effector/testdata/wire, one file per request shape
// and per outcome. Go decodes each request and encodes each response; the TypeScript tests in
// @jr2/orchestrator do the reverse over the same files.
const fixtures = "../../testdata/wire"

func fixtureNames(t *testing.T, prefix string) []string {
	t.Helper()
	names, err := filepath.Glob(filepath.Join(fixtures, prefix+"*.json"))
	if err != nil || len(names) == 0 {
		t.Fatalf("no %s fixtures: %v", prefix, err)
	}
	return names
}

func sameJSON(t *testing.T, name string, got, want []byte) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("%s:\n got %s\nwant %s", name, got, want)
	}
}

func TestEveryRequestFixtureDecodesAndValidates(t *testing.T) {
	for _, path := range fixtureNames(t, "request.") {
		raw, _ := os.ReadFile(path)
		var req StartRequest
		if err := Decode(bytes.NewReader(raw), &req); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if err := req.Validate(); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		again, err := Encode(req)
		if err != nil {
			t.Fatal(err)
		}
		sameJSON(t, path, again, raw)
	}
}

func TestEveryResponseFixtureIsWhatGoEncodes(t *testing.T) {
	for _, path := range fixtureNames(t, "response.") {
		raw, _ := os.ReadFile(path)
		var v any
		if strings.Contains(path, "refusal") {
			v = &Refusal{}
		} else {
			v = &EffectState{}
		}
		if err := Decode(bytes.NewReader(raw), v); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		again, err := Encode(v)
		if err != nil {
			t.Fatal(err)
		}
		sameJSON(t, path, again, raw)
	}
}

func TestEveryRejectFixtureIsRefused(t *testing.T) {
	for _, path := range fixtureNames(t, "reject.") {
		raw, _ := os.ReadFile(path)
		if strings.Contains(path, "reject.request") {
			var req StartRequest
			err := Decode(bytes.NewReader(raw), &req)
			if err == nil {
				err = req.Validate()
			}
			if err == nil {
				t.Fatalf("%s is accepted", path)
			}
			continue
		}
		var s EffectState
		if err := Decode(bytes.NewReader(raw), &s); err == nil {
			t.Fatalf("%s is accepted", path)
		}
	}
}

func TestSecretsListsEachNameOnce(t *testing.T) {
	raw, _ := os.ReadFile(filepath.Join(fixtures, "request.auth-text-and-secret-header.json"))
	var req StartRequest
	if err := Decode(bytes.NewReader(raw), &req); err != nil {
		t.Fatal(err)
	}
	if got := req.Secrets(); !reflect.DeepEqual(got, []string{"api-key"}) {
		t.Fatalf("got %v", got)
	}
}

func TestEncodeDoesNotEscapeHTML(t *testing.T) {
	out, _ := Encode(map[string]string{"a": "<&>"})
	if string(out) != `{"a":"<&>"}` {
		t.Fatalf("got %s", out)
	}
}

// A dispatch `refused` (ADR-0071) carries the door's status and report; an http one a reason. The
// decode tells them apart by which field is present, and each encodes back as it came.
func TestADispatchRefusedIsToldFromAnHTTPRefused(t *testing.T) {
	for name, want := range map[string]bool{
		"response.settled-dispatch-refused.json": true,
		"response.settled-refused.json":          false,
	} {
		raw, _ := os.ReadFile(filepath.Join(fixtures, name))
		var s EffectState
		if err := Decode(bytes.NewReader(raw), &s); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got := s.Output.Report != nil; got != want || s.Output.Outcome != OutcomeRefused {
			t.Fatalf("%s: got %+v", name, s.Output)
		}
		if want && (s.Output.HTTPStatus != 400 || s.Output.Reason != "") {
			t.Fatalf("%s: got %+v", name, s.Output)
		}
	}
	for _, bad := range []string{
		`{"outcome":"refused","status":400,"report":["a"],"reason":"b"}`,
		`{"outcome":"refused","status":400,"report":null}`,
		`{"outcome":"started"}` + "x",
		`{"outcome":"settled","run":"r","status":"done","extra":1}`,
		// Each field DispatchOutputShape requires: absent, Go would read its zero value.
		`{"outcome":"started"}`,
		`{"outcome":"started","run":null}`,
		`{"outcome":"settled"}`,
		`{"outcome":"settled","run":"r"}`,
		`{"outcome":"settled","status":"done"}`,
		`{"outcome":"refused","report":["a"]}`,
	} {
		var o Output
		if err := o.UnmarshalJSON([]byte(bad)); err == nil {
			t.Fatalf("%s is accepted as %+v", bad, o)
		}
	}
}

func dispatchFixture(t *testing.T) StartRequest {
	t.Helper()
	raw, _ := os.ReadFile(filepath.Join(fixtures, "request.dispatch-start.json"))
	var req StartRequest
	if err := Decode(bytes.NewReader(raw), &req); err != nil {
		t.Fatal(err)
	}
	return req
}

func TestADispatchNamesItsBearerAsItsOneSecret(t *testing.T) {
	req := dispatchFixture(t)
	if got := req.Secrets(); !reflect.DeepEqual(got, []string{"ops-instance"}) {
		t.Fatalf("got %v", got)
	}
}

func TestADispatchStartIsValidatedAsTheTSShapeIs(t *testing.T) {
	text := func(s string) Text { return Text{{Text: &s}} }
	name := "x"
	cases := map[string]func(*StartRequest){
		"a bad name":          func(r *StartRequest) { r.Workflow = "Review" },
		"three segments":      func(r *StartRequest) { r.Workflow = "a/b/c" },
		"a path":              func(r *StartRequest) { r.URL = text("https://ops.example.com/") },
		"a query":             func(r *StartRequest) { r.URL = text("https://ops.example.com?x=1") },
		"userinfo":            func(r *StartRequest) { r.URL = text("https://u@ops.example.com") },
		"not http":            func(r *StartRequest) { r.URL = text("ftp://ops.example.com") },
		"a secret in the url": func(r *StartRequest) { r.URL = Text{{Secret: &name}} },
		"two parts":           func(r *StartRequest) { r.URL = append(text("https://a"), text(".b")...) },
		"no auth":             func(r *StartRequest) { r.Auth = nil },
		"a text auth":         func(r *StartRequest) { r.Auth = &Auth{Text: text("Bearer x")} },
		"input not an object": func(r *StartRequest) { r.Input = json.RawMessage(`[1]`) },
		"input null":          func(r *StartRequest) { r.Input = json.RawMessage(`null`) },
		"no input":            func(r *StartRequest) { r.Input = nil },
		"no dispatchedBy":     func(r *StartRequest) { r.DispatchedBy = nil },
		"no instance":         func(r *StartRequest) { r.DispatchedBy.Instance = "" },
		"no run":              func(r *StartRequest) { r.DispatchedBy.Run = "" },
		"no slot":             func(r *StartRequest) { r.DispatchedBy.Slot = "" },
		"no effect":           func(r *StartRequest) { r.DispatchedBy.Effect = "" },
		"an effect not an id": func(r *StartRequest) { r.DispatchedBy.Effect = "a/b" },
		"a depth of 0":        func(r *StartRequest) { r.DispatchedBy.Depth = 0 },
		"no wait":             func(r *StartRequest) { r.Wait = nil },
		"a method":            func(r *StartRequest) { r.Method = "POST" },
		"a maxBody":           func(r *StartRequest) { r.MaxBody = 1 },
		"no timeout":          func(r *StartRequest) { r.TimeoutMs = 0 },
	}
	for why, mutate := range cases {
		req := dispatchFixture(t)
		mutate(&req)
		if err := req.Validate(); err == nil {
			t.Fatalf("a dispatch with %s is accepted", why)
		}
	}
	// A dispatch's fields on another kind are refused too.
	raw, _ := os.ReadFile(filepath.Join(fixtures, "request.get-minimal.json"))
	var http StartRequest
	if err := Decode(bytes.NewReader(raw), &http); err != nil {
		t.Fatal(err)
	}
	http.Workflow = "review"
	if err := http.Validate(); err == nil {
		t.Fatal("an http start with a workflow is accepted")
	}
}
