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

// The golden fixtures (ADR-0068, B1) live in effector/testdata/wire, one file per request shape
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
