/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
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
