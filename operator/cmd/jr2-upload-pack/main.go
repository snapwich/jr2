/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

// Command jr2-upload-pack is `origin`'s fetch url inside a Sandbox (ADR-0053):
//
//	jr2-upload-pack <service> <identity> [adapter-url]
//
// Git runs it through its built-in `ext::` transport and substitutes `%S` for
// the service, so nothing here is typed by a human. It lives on the runtime
// volume at /opt/jr2/bin/jr2-upload-pack, which every seat of a Workspace pod
// mounts — the Harness container, the Sandbox Image's primary container, and
// the User Container (ADR-0005) — because the fetch url lives in the shared
// `default/.git/config` and a seat without the program has checkouts whose
// `git fetch` dies.
//
// The logic is in internal/uploadpack; this file is the seat of os.Exit alone.
package main

import (
	"os"

	"github.com/snapwich/jr2/operator/internal/uploadpack"
)

func main() {
	os.Exit(uploadpack.Run(uploadpack.Options{Args: os.Args[1:]}))
}
