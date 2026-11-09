/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

// Command jr2-lfs is jr2's program for Git LFS inside a Sandbox (ADR-0053):
//
//	jr2-lfs transfer [--no-ask]
//	jr2-lfs fetch [--identity I] [--budget D] <commit>
//
// `transfer` is the standalone transfer agent that git-lfs starts for a
// smudge that the node cache cannot serve. The cut's checkout starts it with
// `--no-ask`: it then refuses each object, because the cut asked first. `fetch` is the attach's and the
// cut's ask for one commit's large files. It lives on the runtime volume at
// /opt/jr2/bin/jr2-lfs, beside git-lfs, in every seat of a Workspace pod.
//
// The logic is in internal/lfstransfer; this file is the seat of os.Exit alone.
package main

import (
	"os"

	"github.com/snapwich/jr2/operator/internal/lfstransfer"
)

func main() {
	os.Exit(lfstransfer.Run(lfstransfer.Options{Args: os.Args[1:]}))
}
