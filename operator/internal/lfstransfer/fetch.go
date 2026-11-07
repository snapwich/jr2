/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package lfstransfer

import (
	"encoding/json"
	"io"
	"strings"
	"time"
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

// NoTimeToAsk is the reason of each object that a `--budget` of zero or less
// gave no time to ask for. With it, `fetch` sends no ask.
const NoTimeToAsk = "no time was left to ask for it"

// fetchArgs is what `fetch` reads from its arguments.
type fetchArgs struct {
	identity, commit string
	identitySet      bool
	// budget bounds all the asks of the run. Zero: no bound but each ask's
	// own AskTimeout.
	budget    time.Duration
	budgetSet bool
}

// parseFetchArgs reads `[--identity I] [--budget D] [--] <commit>`.
// It is false for a usage fault. D is a Go duration, such as "390s".
func parseFetchArgs(args []string) (fetchArgs, bool) {
	var f fetchArgs
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "--budget" && i+1 < len(args):
			i++
			d, err := time.ParseDuration(args[i])
			if err != nil {
				return f, false
			}
			f.budget, f.budgetSet = d, true
		case strings.HasPrefix(a, "--budget="):
			d, err := time.ParseDuration(strings.TrimPrefix(a, "--budget="))
			if err != nil {
				return f, false
			}
			f.budget, f.budgetSet = d, true
		case a == "--identity" && i+1 < len(args):
			i++
			f.identity, f.identitySet = args[i], true
		case strings.HasPrefix(a, "--identity="):
			f.identity, f.identitySet = strings.TrimPrefix(a, "--identity="), true
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

// runFetch is `jr2-lfs fetch [--identity I] [--budget D] <commit>`.
// It gets the LFS objects of one commit into the node cache before git checks
// the commit out (ADR-0053, ADR-0075). It exits 0 when it could do its work,
// also when objects are missing: the caller reads `missing`. It exits non-zero
// only for a usage or I/O fault. With `--budget`, the asks end when the budget
// does, and each object that did not come in time is missing with a reason
// that says so: the cut gives the part of its Effect's timeout that is left,
// so that it can still answer `refused`, naming the files. A budget of zero or
// less sends no ask, and each object that no store holds is missing with the
// reason NoTimeToAsk.
func runFetch(o Options, args []string) int {
	f, ok := parseFetchArgs(args)
	if !ok {
		_, _ = io.WriteString(o.Stderr, Usage)
		return 2
	}
	identity, commit := f.identity, f.commit
	var deadline time.Time
	if f.budgetSet {
		deadline = time.Now().Add(f.budget)
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
	if len(wanted) > 0 && f.budgetSet && f.budget <= 0 {
		// The caller had no time left for an ask, so none is sent.
		for _, w := range wanted {
			reasons[w.OID] = NoTimeToAsk
		}
	} else if len(wanted) > 0 {
		if !f.identitySet {
			identity = identityOf(gitConfig(o.Dir, "remote.origin.url"))
		}
		a := newAsker(o, identity)
		a.deadline, a.budget = deadline, f.budget
		_, reasons = a.askAll(wanted)
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
