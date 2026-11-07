/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package lfstransfer

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// smudgePod is a pod whose clone smudges with git-lfs's filter by absolute
// path and jr2's standalone transfer agent, as the attach configures it. The
// agent is this test binary (TestMain), started by git-lfs itself.
func smudgePod(t *testing.T, b blob) pod {
	t.Helper()
	gitLFS, err := exec.LookPath("git-lfs")
	if err != nil {
		t.Skip("git-lfs is not on PATH")
	}
	p := lfsPod(t, b)
	agent, err := filepath.Abs(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, kv := range [][2]string{
		{"filter.lfs.process", gitLFS + " filter-process"},
		{"filter.lfs.required", "true"},
		{"lfs.standalonetransferagent", "jr2"},
		{"lfs.customtransfer.jr2.path", agent},
		{"lfs.customtransfer.jr2.args", "transfer"},
		{"lfs.customtransfer.jr2.concurrent", "false"},
	} {
		run(t, p.clone, "config", kv[0], kv[1])
	}
	t.Setenv(agentEnv, "1")
	return p
}

func checkOut(t *testing.T, p pod) (string, error) {
	t.Helper()
	cmd := exec.Command("git", "checkout", "-f", "main")
	cmd.Dir = p.clone
	var errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &errOut, &errOut
	err := cmd.Run()
	return errOut.String(), err
}

func checkSmudged(t *testing.T, p pod, b blob) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(p.clone, "big.bin"))
	if err != nil || !bytes.Equal(data, b.data) {
		t.Fatalf("big.bin = %q (%v), want the smudged content", data, err)
	}
	if !holds(filepath.Join(p.clone, ".git", "lfs"), b.obj) {
		t.Fatalf("the clone's own store does not hold %s", b.obj.OID)
	}
}

func TestSmudgeReadsTheCacheThroughTheAlternate(t *testing.T) {
	b := newBlob("held by the node cache\n")
	p := smudgePod(t, b)
	land(t, filepath.Join(p.cache, "lfs"), b)
	c := newCustodian(t, p.cache)
	if out, err := checkOut(t, p); err != nil {
		t.Fatalf("checkout: %v\n%s", err, out)
	}
	checkSmudged(t, p, b)
	if n := len(c.asked()); n != 0 {
		t.Fatalf("a held object made %d asks, want 0", n)
	}
}

func TestSmudgeAsksTheCustodianForAMiss(t *testing.T) {
	b := newBlob("only the remote has this one\n")
	p := smudgePod(t, b)
	c := newCustodian(t, p.cache, b)
	if out, err := checkOut(t, p); err != nil {
		t.Fatalf("checkout: %v\n%s", err, out)
	}
	checkSmudged(t, p, b)
	if n := len(c.asked()); n != 1 {
		t.Fatalf("a miss made %d asks, want 1", n)
	}
	if !holds(filepath.Join(p.cache, "lfs"), b.obj) {
		t.Fatal("the cache's own file must stay after git-lfs moves the copy")
	}
}

func TestSmudgeFailsWithJr2sLine(t *testing.T) {
	b := newBlob("nobody can give this\n")
	p := smudgePod(t, b)
	c := newCustodian(t, p.cache)
	c.error = "batch response: object not found"
	out, err := checkOut(t, p)
	if err == nil {
		t.Fatalf("the checkout passed with no object:\n%s", out)
	}
	if !strings.Contains(out, "jr2:") || !strings.Contains(out, b.obj.OID) {
		t.Fatalf("stderr has no jr2: line naming %s:\n%s", b.obj.OID, out)
	}
	if testing.Verbose() {
		t.Log(out)
	}
}
