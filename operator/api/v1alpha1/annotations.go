/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package v1alpha1

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// AskedAnnotationPrefix is the prefix of the ask (ADR-0053): one annotation
// per Repo key, its value an RFC3339 instant, written on the Sandbox by the
// Orchestrator when something inside the pod asks for a fetch. The operator
// copies every one of them onto the pod, because the cache agent reads demand
// off pods alone; the agent then takes the later of the pod's creation and
// its ask for a key as what that node was asked for.
//
// It is a mark, not a queue: however many fetches are in flight before one
// lands, the remote is fetched once, and a fetch that started before the ask
// does not satisfy it.
const AskedAnnotationPrefix = "jr2.dev/asked-"

// AskedAnnotation is the ask annotation for one Repo cache key.
func AskedAnnotation(key string) string { return AskedAnnotationPrefix + key }

// AskedAt is an ask raised to the next whole second — the bar a fetch must
// clear to answer it.
//
// The mark carries milliseconds, so two asks in one second stay distinguishable
// to a human reading the CR, but everything that answers one is kept at the
// second: the agent stamps `lastAttempt`/`lastFetched` with the attempt's START
// (ADR-0053), and a metav1.Time survives a round trip at the second. Rounding
// the ask DOWN would count a fetch that began up to a second BEFORE the ask as
// answering it — the one thing the coalescer must never do, because that fetch
// cannot hold the commit the caller is asking about. Rounding UP cannot: a
// stamp of `ceil(ask)` belongs to a fetch that began at or after the ask. The
// cost runs the safe way and is bounded by one second — a fetch that began in
// the ask's own second could not be counted, so the node waits for the top of
// the next second before it fetches for the ask, and fetches once.
//
// An instant already ON a second is its own ceiling: nothing is asked for that
// has not happened yet.
func AskedAt(t time.Time) time.Time {
	truncated := t.Truncate(time.Second)
	if truncated.Equal(t) {
		return t
	}
	return truncated.Add(time.Second)
}

// LFSAnnotationPrefix is the prefix of the LFS ask (ADR-0053): one annotation
// per Repo key, written on the Sandbox by the Orchestrator when something in
// the pod asks the node's cache for Git LFS objects by oid. The operator copies
// it onto the pod, as it copies the asked- ones, and the cache agent reads it
// there. An LFS ask causes no git fetch.
//
// A Repo key has at most 49 characters, so the name part of the annotation
// ("lfs-" and the key) has at most 53 characters. The limit is 63.
const LFSAnnotationPrefix = "jr2.dev/lfs-"

// LFSAnnotation is the LFS ask annotation for one Repo cache key.
func LFSAnnotation(key string) string { return LFSAnnotationPrefix + key }

// MaxLFSObjects is the most objects one LFS ask names (ADR-0053). The asker
// splits a longer list into several asks.
const MaxLFSObjects = 256

// maxLFSBase is the longest Binding base name an LFS ask can carry, in bytes
// of UTF-8 (`len`), as the Orchestrator counts it.
const maxLFSBase = 255

// LFSObject is one Git LFS object that an ask names: its oid (64 lowercase
// hex characters, the SHA-256 of the content) and its size in bytes.
// +kubebuilder:object:generate=false
type LFSObject struct {
	OID  string
	Size int64
}

// LFSAsk is the parsed value of a `jr2.dev/lfs-<key>` annotation (ADR-0053).
// The operator and the cache agent use the same parser.
// +kubebuilder:object:generate=false
type LFSAsk struct {
	// At is the instant of the ask. The Orchestrator makes it strictly
	// increase for each seat.
	At time.Time
	// AtRaw is At as the annotation writes it. The cache agent copies it as
	// is into its answer, and the Orchestrator compares the two as instants.
	AtRaw string
	// Base is the Binding's base name. The cache agent reads `.lfsconfig` at
	// this commit. It can be empty.
	Base string
	// Objects holds 1 to MaxLFSObjects objects.
	Objects []LFSObject
}

// lfsAskJSON is the shape of the annotation value:
// {"at":"<RFC3339>","base":"<base>","objects":["<oid> <size>", ...]}.
// +kubebuilder:object:generate=false
type lfsAskJSON struct {
	At      string   `json:"at"`
	Base    string   `json:"base"`
	Objects []string `json:"objects"`
}

// ParseLFSAsk parses the value of a `jr2.dev/lfs-<key>` annotation. It refuses
// a value of a bad shape: an `at` that is not RFC3339, a base that a git
// command could read as an option or that has a NUL or a newline, no objects
// or more than MaxLFSObjects, an oid that is not 64 lowercase hex characters,
// or a size that is not a non-negative integer.
func ParseLFSAsk(raw string) (LFSAsk, error) {
	var v lfsAskJSON
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return LFSAsk{}, fmt.Errorf("lfs ask: %w", err)
	}
	at, err := time.Parse(time.RFC3339Nano, v.At)
	if err != nil {
		return LFSAsk{}, fmt.Errorf("lfs ask: at: %w", err)
	}
	if len(v.Base) > maxLFSBase || strings.HasPrefix(v.Base, "-") || strings.ContainsAny(v.Base, "\x00\n\r") {
		return LFSAsk{}, fmt.Errorf("lfs ask: bad base %q", v.Base)
	}
	if len(v.Objects) == 0 {
		return LFSAsk{}, errors.New("lfs ask: no objects")
	}
	if len(v.Objects) > MaxLFSObjects {
		return LFSAsk{}, fmt.Errorf("lfs ask: %d objects, more than %d", len(v.Objects), MaxLFSObjects)
	}
	ask := LFSAsk{At: at, AtRaw: v.At, Base: v.Base, Objects: make([]LFSObject, 0, len(v.Objects))}
	for _, item := range v.Objects {
		obj, err := parseLFSObject(item)
		if err != nil {
			return LFSAsk{}, err
		}
		ask.Objects = append(ask.Objects, obj)
	}
	return ask, nil
}

// parseLFSObject parses one "<oid> <size>" item of an LFS ask.
func parseLFSObject(item string) (LFSObject, error) {
	oid, size, ok := strings.Cut(item, " ")
	if !ok || !ValidLFSOID(oid) {
		return LFSObject{}, fmt.Errorf("lfs ask: bad object %q: want \"<64 lowercase hex> <size>\"", item)
	}
	if size == "" || strings.Trim(size, "0123456789") != "" {
		return LFSObject{}, fmt.Errorf("lfs ask: bad size in %q: want a non-negative integer", item)
	}
	n, err := strconv.ParseInt(size, 10, 64)
	if err != nil {
		return LFSObject{}, fmt.Errorf("lfs ask: bad size in %q: %w", item, err)
	}
	return LFSObject{OID: oid, Size: n}, nil
}

// ValidLFSOID reports that oid is 64 lowercase hex characters.
func ValidLFSOID(oid string) bool {
	if len(oid) != 64 {
		return false
	}
	for _, c := range oid {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
