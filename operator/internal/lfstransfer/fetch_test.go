/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package lfstransfer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func fetch(t *testing.T, dir string, args ...string) FetchResult {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Run(Options{Args: append([]string{"fetch"}, args...), Dir: dir, Stdout: &out, Stderr: &errOut})
	if code != 0 {
		t.Fatalf("fetch %v: exit %d: %s", args, code, errOut.String())
	}
	if strings.Count(out.String(), "\n") != 1 {
		t.Fatalf("fetch printed %q, want one line", out.String())
	}
	var r FetchResult
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatalf("fetch printed %q: %v", out.String(), err)
	}
	return r
}

// gitLog puts a git on PATH that logs each argv to a file, then runs the
// real git. It shows which git commands a fetch runs.
func gitLog(t *testing.T) func() []string {
	t.Helper()
	real, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not on PATH")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "log")
	script := fmt.Sprintf("#!/bin/sh\necho \"$*\" >> %q\nexec %q \"$@\"\n", log, real)
	if err := os.WriteFile(filepath.Join(dir, "git"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return func() []string {
		data, _ := os.ReadFile(log)
		return strings.Split(strings.TrimSpace(string(data)), "\n")
	}
}

func TestFetchAsksOnlyForLFSFilesThatNoStoreHolds(t *testing.T) {
	inCache, inClone, remote, absent, outside := newBlob("held by the cache"), newBlob("held by the clone"),
		newBlob("only the remote"), newBlob("nobody"), newBlob("pointer-shaped, not lfs")
	p := makePod(t, map[string]string{
		".gitattributes":         attrsLFS,
		"a.bin":                  inCache.pointer,
		"dir/b.bin":              inClone.pointer,
		"dir/sub/c.bin":          remote.pointer,
		"d.bin":                  absent.pointer,
		"e.bin":                  remote.pointer, // the same object at a second path
		"notes/pointer.txt":      outside.pointer,
		"plain.bin":              "a .bin that is not a pointer\n",
		"README":                 "jr2\n",
		"dir/sub/.gitattributes": "# nothing for lfs here\n",
	})
	land(t, filepath.Join(p.cache, "lfs"), inCache)
	land(t, filepath.Join(p.clone, ".git", "lfs"), inClone)
	c := newCustodian(t, p.cache, remote)
	c.error = "object d not found on the remote"

	calls := gitLog(t)
	r := fetch(t, p.clone, "main")
	for _, call := range calls() {
		if strings.HasPrefix(call, "read-tree") {
			t.Fatalf("git %s has check-attr --source, but the fetch read the tree into an index", run(t, "", "version"))
		}
	}
	if r.Pointers != 5 || r.Asked != 2 {
		t.Fatalf("result = %+v, want 5 pointers and 2 asked", r)
	}
	asks := c.asked()
	if len(asks) != 1 {
		t.Fatalf("%d asks, want 1", len(asks))
	}
	got := asks[0].LFS.Objects
	want := []Object{remote.obj, absent.obj}
	sortObjects(got)
	sortObjects(want)
	if !slices.Equal(got, want) || asks[0].Identity != testIdentity || asks[0].LFS.Base != "main" {
		t.Fatalf("ask = %+v, want objects %v", asks[0], want)
	}
	if len(r.Missing) != 1 || r.Missing[0].Path != "d.bin" || r.Missing[0].OID != absent.obj.OID ||
		r.Missing[0].Reason != c.error {
		t.Fatalf("missing = %+v, want d.bin with the answer's error", r.Missing)
	}
}

func TestFetchFlagsOverrideTheConfig(t *testing.T) {
	b := newBlob("flags")
	p := makePod(t, map[string]string{".gitattributes": attrsLFS, "x.bin": b.pointer})
	c := newCustodian(t, p.cache, b)
	r := fetch(t, p.clone, "--identity", "gitlab.com/x/y", "--base=v1.0", "--", "HEAD")
	if r.Asked != 1 || len(r.Missing) != 0 {
		t.Fatalf("result = %+v", r)
	}
	if a := c.asked()[0]; a.Identity != "gitlab.com/x/y" || a.LFS.Base != "v1.0" {
		t.Fatalf("ask = %+v", a)
	}
}

func TestFetchWithTheTempIndex(t *testing.T) {
	checkAttrSource = false
	t.Cleanup(func() { checkAttrSource = true })
	b, outside := newBlob("temp index"), newBlob("outside")
	p := makePod(t, map[string]string{".gitattributes": attrsLFS, "x.bin": b.pointer, "y.txt": outside.pointer})
	c := newCustodian(t, p.cache, b)
	r := fetch(t, p.clone, "main")
	if r.Pointers != 1 || r.Asked != 1 || len(c.asked()) != 1 {
		t.Fatalf("result = %+v", r)
	}
}

func TestFetchWithNoLFSReadsOneTree(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"no .gitattributes":   {"a.bin": newBlob("x").pointer, "README": "jr2\n"},
		"no filter=lfs in it": {".gitattributes": "*.sh text eol=lf\n", "a.bin": newBlob("x").pointer},
	} {
		t.Run(name, func(t *testing.T) {
			p := makePod(t, files)
			c := newCustodian(t, p.cache)
			calls := gitLog(t)
			r := fetch(t, p.clone, "main")
			if r.Pointers != 0 || r.Asked != 0 || len(r.Missing) != 0 || len(c.asked()) != 0 {
				t.Fatalf("result = %+v, asks %d", r, len(c.asked()))
			}
			trees := 0
			for _, call := range calls() {
				if strings.HasPrefix(call, "ls-tree") {
					trees++
				}
				if strings.HasPrefix(call, "check-attr") || strings.HasPrefix(call, "read-tree") {
					t.Fatalf("a commit with no LFS ran %q", call)
				}
			}
			if trees != 1 {
				t.Fatalf("%d tree listings, want 1: %v", trees, calls())
			}
			// A cat-file reads the .gitattributes blob alone, if there is one.
			if _, has := files[".gitattributes"]; !has {
				for _, call := range calls() {
					if strings.HasPrefix(call, "cat-file") {
						t.Fatalf("a commit with no .gitattributes ran %q", call)
					}
				}
			}
		})
	}
}

func TestFetchSplitsAsksAt256(t *testing.T) {
	files := map[string]string{".gitattributes": attrsLFS}
	blobs := make([]blob, 0, 600)
	for i := range 600 {
		b := newBlob(fmt.Sprintf("object %d", i))
		blobs = append(blobs, b)
		files[fmt.Sprintf("f/%03d.bin", i)] = b.pointer
	}
	p := makePod(t, files)
	c := newCustodian(t, p.cache, blobs...)
	r := fetch(t, p.clone, "main")
	if r.Pointers != 600 || r.Asked != 600 || len(r.Missing) != 0 {
		t.Fatalf("result = pointers %d, asked %d, missing %d", r.Pointers, r.Asked, len(r.Missing))
	}
	asks := c.asked()
	sizes := make([]int, 0, len(asks))
	for _, a := range asks {
		sizes = append(sizes, len(a.LFS.Objects))
	}
	if !slices.Equal(sizes, []int{256, 256, 88}) {
		t.Fatalf("ask sizes = %v, want [256 256 88]", sizes)
	}
}

func TestFetchFaults(t *testing.T) {
	p := makePod(t, map[string]string{"README": "jr2\n"})
	var errOut bytes.Buffer
	if code := Run(Options{Args: []string{"fetch", "no-such-ref"}, Dir: p.clone, Stdout: io.Discard, Stderr: &errOut}); code == 0 ||
		!strings.HasPrefix(errOut.String(), "jr2:") {
		t.Fatalf("an unknown commit: exit %d, %q", code, errOut.String())
	}
	errOut.Reset()
	if code := Run(Options{Args: []string{"fetch", "main"}, Dir: t.TempDir(), Stdout: io.Discard, Stderr: &errOut}); code == 0 ||
		!strings.HasPrefix(errOut.String(), "jr2:") {
		t.Fatalf("not a checkout: exit %d, %q", code, errOut.String())
	}
}

func TestParsePointer(t *testing.T) {
	b := newBlob("x")
	if obj, ok := parsePointer([]byte(b.pointer)); !ok || obj != b.obj {
		t.Fatalf("parsePointer = %+v %v", obj, ok)
	}
	for _, bad := range []string{
		"",
		"version https://git-lfs.github.com/spec/v1\nsize 3\n",
		"version https://git-lfs.github.com/spec/v1\noid sha256:XYZ\nsize 3\n",
		"version https://git-lfs.github.com/spec/v1\noid sha256:" + b.obj.OID + "\nsize -1\n",
		"oid sha256:" + b.obj.OID + "\nsize 1\n",
	} {
		if _, ok := parsePointer([]byte(bad)); ok {
			t.Errorf("parsePointer(%q) took it", bad)
		}
	}
}

func sortObjects(objs []Object) {
	slices.SortFunc(objs, func(a, b Object) int { return strings.Compare(a.OID, b.OID) })
}
