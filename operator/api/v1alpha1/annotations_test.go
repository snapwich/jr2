/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package v1alpha1

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

const testOID = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393"

func lfsValue(at, base string, objects ...string) string {
	b, err := json.Marshal(map[string]any{"at": at, "base": base, "objects": objects})
	if err != nil {
		panic(err)
	}
	return string(b)
}

// TestLFSAnnotationFitsTheName pins that the longest Repo key (49 characters)
// keeps the annotation's name part inside the 63-character limit.
func TestLFSAnnotationFitsTheName(t *testing.T) {
	key := strings.Repeat("k", 49)
	name := strings.TrimPrefix(LFSAnnotation(key), "jr2.dev/")
	if len(name) > 63 {
		t.Fatalf("name part %q has %d characters, more than 63", name, len(name))
	}
	if !strings.HasPrefix(LFSAnnotation(key), LFSAnnotationPrefix) {
		t.Fatalf("LFSAnnotation must start with the prefix, got %q", LFSAnnotation(key))
	}
}

func TestParseLFSAsk(t *testing.T) {
	at := "2026-11-07T12:00:00.123Z"
	ask, err := ParseLFSAsk(lfsValue(at, "main", testOID+" 12", strings.Repeat("0", 64)+" 0"))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if ask.AtRaw != at || !ask.At.Equal(time.Date(2026, 11, 7, 12, 0, 0, 123e6, time.UTC)) {
		t.Fatalf("at: got %q %v", ask.AtRaw, ask.At)
	}
	if ask.Base != "main" {
		t.Fatalf("base: got %q", ask.Base)
	}
	want := []LFSObject{{OID: testOID, Size: 12}, {OID: strings.Repeat("0", 64), Size: 0}}
	if fmt.Sprint(ask.Objects) != fmt.Sprint(want) {
		t.Fatalf("objects: got %v, want %v", ask.Objects, want)
	}

	if ask, err := ParseLFSAsk(lfsValue(at, "", testOID+" 1")); err != nil || ask.Base != "" {
		t.Fatalf("an empty base is allowed, got %+v %v", ask, err)
	}

	full := make([]string, MaxLFSObjects)
	for i := range full {
		full[i] = testOID + " 1"
	}
	if _, err := ParseLFSAsk(lfsValue(at, "", full...)); err != nil {
		t.Fatalf("%d objects is allowed, got %v", MaxLFSObjects, err)
	}
}

func TestParseLFSAskRefusesABadShape(t *testing.T) {
	at := "2026-11-07T12:00:00.123Z"
	over := make([]string, MaxLFSObjects+1)
	for i := range over {
		over[i] = testOID + " 1"
	}
	cases := map[string]string{
		"not json":         "{",
		"bad at":           lfsValue("yesterday", "", testOID+" 1"),
		"no objects":       lfsValue(at, ""),
		"too many objects": lfsValue(at, "", over...),
		"short oid":        lfsValue(at, "", testOID[:63]+" 1"),
		"upper-case oid":   lfsValue(at, "", strings.ToUpper(testOID)+" 1"),
		"non-hex oid":      lfsValue(at, "", strings.Repeat("g", 64)+" 1"),
		"no size":          lfsValue(at, "", testOID),
		"empty size":       lfsValue(at, "", testOID+" "),
		"negative size":    lfsValue(at, "", testOID+" -1"),
		"plus size":        lfsValue(at, "", testOID+" +1"),
		"two spaces":       lfsValue(at, "", testOID+"  1"),
		"size overflow":    lfsValue(at, "", testOID+" 99999999999999999999"),
		"option base":      lfsValue(at, "-c", testOID+" 1"),
		"newline base":     lfsValue(at, "a\nb", testOID+" 1"),
		"nul base":         lfsValue(at, "a\x00b", testOID+" 1"),
		"long base":        lfsValue(at, strings.Repeat("b", 256), testOID+" 1"),
	}
	for name, raw := range cases {
		if ask, err := ParseLFSAsk(raw); err == nil {
			t.Errorf("%s: want a refusal, got %+v", name, ask)
		}
	}
}
