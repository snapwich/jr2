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

// fetchArgs is what `fetch` reads from its arguments.
type fetchArgs struct {
	identity, base, commit string
	identitySet, baseSet   bool
}

// parseFetchArgs reads `[--identity I] [--base B] [--] <commit>`. It is false
// for a usage fault.
func parseFetchArgs(args []string) (fetchArgs, bool) {
	var f fetchArgs
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case (a == "--identity" || a == "--base") && i+1 < len(args):
			i++
			if a == "--identity" {
				f.identity, f.identitySet = args[i], true
			} else {
				f.base, f.baseSet = args[i], true
			}
		case strings.HasPrefix(a, "--identity="):
			f.identity, f.identitySet = strings.TrimPrefix(a, "--identity="), true
		case strings.HasPrefix(a, "--base="):
			f.base, f.baseSet = strings.TrimPrefix(a, "--base="), true
		case a == "--" && i+1 < len(args) && f.commit == "":
			i++
			f.commit = args[i]
		case strings.HasPrefix(a, "-") || f.commit != "":
			return f, false
		default:
			f.commit = a
		}
	}
	return f, f.commit != ""
}

// runFetch is `jr2-lfs fetch [--identity I] [--base B] <commit>`. It gets the
// LFS objects of one commit into the node cache before git checks the commit
// out (ADR-0053, ADR-0075). It exits 0 when it could do its work, also when
// objects are missing: the caller reads `missing`. It exits non-zero only for
// a usage or I/O fault.
func runFetch(o Options, args []string) int {
	f, ok := parseFetchArgs(args)
	if !ok {
		_, _ = io.WriteString(o.Stderr, Usage)
		return 2
	}
	identity, base, commit := f.identity, f.base, f.commit
	identitySet, baseSet := f.identitySet, f.baseSet

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
	// `check-attr --stdin` reads each path from the working directory, and
	// ls-tree gives each path from the top of the tree. So the listing runs at
	// the top of the checkout, also when the caller is in a subdirectory.
	top := o.Dir
	if t, err := gitOut(o.Dir, "rev-parse", "--show-toplevel"); err == nil && t != "" {
		top = t
	}
	pointers, err := listPointers(top, resolved)
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
