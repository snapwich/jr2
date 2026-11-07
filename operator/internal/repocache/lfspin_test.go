/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package repocache

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// gitLFSPin is what a Dockerfile pins of git-lfs: the version and the sha256
// of each arch's release archive.
type gitLFSPin struct {
	version string
	sha     map[string]string
}

var (
	lfsVersionRE = regexp.MustCompile(`(?m)^ARG GIT_LFS_VERSION=(\S+)$`)
	lfsShaRE     = regexp.MustCompile(`(?m)^\s*(\w+)\) lfs_sha='([0-9a-f]{64})' ;;`)
)

func readGitLFSPin(t *testing.T, path string) gitLFSPin {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	versions := lfsVersionRE.FindAllSubmatch(raw, -1)
	if len(versions) != 1 {
		t.Fatalf("%s: want one ARG GIT_LFS_VERSION, got %d", path, len(versions))
	}
	pin := gitLFSPin{version: string(versions[0][1]), sha: map[string]string{}}
	for _, m := range lfsShaRE.FindAllSubmatch(raw, -1) {
		pin.sha[string(m[1])] = string(m[2])
	}
	if len(pin.sha) == 0 {
		t.Fatalf("%s: no lfs_sha lines", path)
	}
	return pin
}

// TestTheCacheAgentAndTheHarnessPinOneGitLFS: the cache agent fetches the
// objects that the seats' git-lfs reads (ADR-0053), so both images carry the
// same official release, checked against the same sha256 for each arch.
func TestTheCacheAgentAndTheHarnessPinOneGitLFS(t *testing.T) {
	operator := readGitLFSPin(t, filepath.Join("..", "..", "Dockerfile"))
	harness := readGitLFSPin(t, filepath.Join("..", "..", "..", "deploy", "harness", "Dockerfile"))
	if operator.version != harness.version {
		t.Fatalf("git-lfs version: operator/Dockerfile %s, deploy/harness/Dockerfile %s", operator.version, harness.version)
	}
	for _, arch := range []string{"amd64", "arm64"} {
		if operator.sha[arch] == "" || operator.sha[arch] != harness.sha[arch] {
			t.Fatalf("git-lfs sha256 for %s: operator/Dockerfile %q, deploy/harness/Dockerfile %q", arch, operator.sha[arch], harness.sha[arch])
		}
	}
	if len(operator.sha) != len(harness.sha) {
		t.Fatalf("the two Dockerfiles pin different arch sets: %v, %v", operator.sha, harness.sha)
	}
}
