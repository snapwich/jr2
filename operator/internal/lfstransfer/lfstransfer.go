/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

// Package lfstransfer is the program behind `/opt/jr2/bin/jr2-lfs` (ADR-0053).
// It has two subcommands:
//
//	jr2-lfs transfer
//	jr2-lfs fetch [--identity I] [--base B] <commit>
//
// `transfer` is jr2's standalone transfer agent. git-lfs starts it when a
// smudge needs an object that neither the clone's store nor the node cache's
// store holds. `fetch` is the ask of the attach and of the cut: it gets the
// LFS objects of one commit before git checks the commit out (ADR-0075).
//
// Both ask by the same carrier. The asker sends the oids to the Custodian on
// the pod's loopback, on the path that a fetch's ask takes. The cache agent
// downloads the objects into the node cache, and the asker then reads them
// from the cache's `lfs/objects` through the pod's read-only mount.
//
// The program is static and imports the standard library only, for the reason
// of jr2-upload-pack (ADR-0037): it runs on a libc that jr2 does not control.
package lfstransfer

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// Usage is the text the program prints when its arguments are wrong.
const Usage = `usage: jr2-lfs transfer
       jr2-lfs fetch [--identity I] [--base B] <commit>
`

// Options is everything the program reads from the world. Every field has a
// default, so main passes only the arguments.
type Options struct {
	// Args is argv[1:].
	Args []string
	// Dir is the working directory: a checkout of the clone. Defaults to the
	// process's own.
	Dir string
	// Stdin carries git-lfs's events to the transfer agent. Defaults to
	// os.Stdin.
	Stdin io.Reader
	// Stdout carries the transfer agent's answers, or the one JSON line of
	// `fetch`. Defaults to os.Stdout.
	Stdout io.Writer
	// Stderr carries usage and fault lines. Defaults to os.Stderr.
	Stderr io.Writer
	// Getenv reads JR2_CUSTODIAN_URL. Defaults to os.Getenv.
	Getenv func(string) string
	// Client sends the asks. Defaults to one bounded by AskTimeout.
	Client *http.Client
}

// Run is the program. It returns the exit code.
func Run(o Options) int {
	fill(&o)
	if len(o.Args) == 0 {
		_, _ = io.WriteString(o.Stderr, Usage)
		return 2
	}
	switch o.Args[0] {
	case "transfer":
		if len(o.Args) != 1 {
			_, _ = io.WriteString(o.Stderr, Usage)
			return 2
		}
		return runTransfer(o)
	case "fetch":
		return runFetch(o, o.Args[1:])
	default:
		_, _ = io.WriteString(o.Stderr, Usage)
		return 2
	}
}

func fill(o *Options) {
	if o.Stdin == nil {
		o.Stdin = os.Stdin
	}
	if o.Stdout == nil {
		o.Stdout = os.Stdout
	}
	if o.Stderr == nil {
		o.Stderr = os.Stderr
	}
	if o.Getenv == nil {
		o.Getenv = os.Getenv
	}
	if o.Dir == "" {
		wd, err := os.Getwd()
		if err != nil {
			wd = "."
		}
		o.Dir = wd
	}
	if o.Client == nil {
		o.Client = &http.Client{Timeout: AskTimeout}
	}
}

// oneLine keeps a reason on one line: git-lfs and the Harness print it as one.
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// fault writes one `jr2:` line to stderr.
func fault(o Options, format string, args ...any) {
	_, _ = fmt.Fprintf(o.Stderr, "jr2: "+format+"\n", args...)
}
