/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package lfstransfer

import (
	"encoding/json"
	"io"
	"strings"
)

// FetchResult is the one JSON line that `fetch` prints.
type FetchResult struct {
	// Pointers is the count of LFS files in the commit.
	Pointers int `json:"pointers"`
	// Asked is the count of objects that the program asked for.
	Asked int `json:"asked"`
	// Missing names each LFS file whose object is in no store after the asks.
	Missing []Missing `json:"missing"`
}

// Missing is one LFS file that the checkout cannot smudge.
type Missing struct {
	Path   string `json:"path"`
	OID    string `json:"oid"`
	Reason string `json:"reason"`
}

// runFetch is `jr2-lfs fetch [--identity I] [--base B] <commit>`. It gets the
// LFS objects of one commit into the node cache before git checks the commit
// out (ADR-0053, ADR-0075). It exits 0 when it could do its work, also when
// objects are missing: the caller reads `missing`. It exits non-zero only for
// a usage or I/O fault.
func runFetch(o Options, args []string) int {
	var identity, base, commit string
	identitySet, baseSet := false, false
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case (a == "--identity" || a == "--base") && i+1 < len(args):
			i++
			if a == "--identity" {
				identity, identitySet = args[i], true
			} else {
				base, baseSet = args[i], true
			}
		case strings.HasPrefix(a, "--identity="):
			identity, identitySet = strings.TrimPrefix(a, "--identity="), true
		case strings.HasPrefix(a, "--base="):
			base, baseSet = strings.TrimPrefix(a, "--base="), true
		case a == "--" && i+1 < len(args) && commit == "":
			i++
			commit = args[i]
		case strings.HasPrefix(a, "-") || commit != "":
			_, _ = io.WriteString(o.Stderr, Usage)
			return 2
		default:
			commit = a
		}
	}
	if commit == "" {
		_, _ = io.WriteString(o.Stderr, Usage)
		return 2
	}

	c, err := findCheckout(o.Dir)
	if err != nil {
		fault(o, "%v", err)
		return 1
	}
	resolved, err := gitOut(o.Dir, "rev-parse", "--verify", "--quiet", "--end-of-options", commit+"^{commit}")
	if err != nil || resolved == "" {
		fault(o, "%q names no commit in this clone", commit)
		return 1
	}
	pointers, err := listPointers(o.Dir, resolved)
	if err != nil {
		fault(o, "cannot list the large files of %s: %v", commit, err)
		return 1
	}

	result := FetchResult{Pointers: len(pointers), Missing: []Missing{}}
	var wanted []Object
	seen := map[string]bool{}
	for _, p := range pointers {
		if seen[p.OID] || holds(c.cloneLFS(), p.Object) || holds(c.cacheLFS(), p.Object) {
			continue
		}
		seen[p.OID] = true
		wanted = append(wanted, p.Object)
	}
	reasons := map[string]string{}
	if len(wanted) > 0 {
		if !identitySet {
			identity = identityOf(gitConfig(o.Dir, "remote.origin.url"))
		}
		if !baseSet {
			base = gitConfig(o.Dir, "jr2.base")
		}
		_, reasons = newAsker(o, identity, base).askAll(wanted)
		result.Asked = len(wanted)
	}
	for _, p := range pointers {
		if !seen[p.OID] || holds(c.cacheLFS(), p.Object) {
			continue
		}
		reason := reasons[p.OID]
		if reason == "" {
			reason = "the node cache does not hold it after the ask"
		}
		result.Missing = append(result.Missing, Missing{Path: p.Path, OID: p.OID, Reason: reason})
	}
	if err := json.NewEncoder(o.Stdout).Encode(result); err != nil {
		fault(o, "cannot write the result: %v", err)
		return 1
	}
	return 0
}
