/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package lfstransfer

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"path"
	"strconv"
	"strings"
)

// maxPointerSize is git-lfs's own cutoff: a blob larger than this is never a
// pointer, so the program does not read it.
const maxPointerSize = 1024

// Pointer is one LFS pointer in a commit's tree.
type Pointer struct {
	Path string
	Object
}

// treeEntry is one blob of `git ls-tree -r -l`.
type treeEntry struct {
	mode, oid, path string
	size            int64
}

// checkAttrSource is true when the program asks git for attributes with
// `check-attr --source` (git 2.40 and later). When that fails, it reads the
// commit into a temp index and asks with `--cached`. A test sets it to false
// to run the second way.
var checkAttrSource = true

// listPointers gives the LFS pointers in the tree of commit: the blobs that
// are pointer-shaped AND whose `filter` attribute is `lfs` in that commit.
// `git lfs ls-files` lists every pointer-shaped blob, whatever the attributes
// say, which is why the program does not use it.
//
// The cost for a commit with no `filter=lfs` in a .gitattributes is the one
// tree listing and a read of each .gitattributes blob: no other blob is read.
func listPointers(dir, commit string) ([]Pointer, error) {
	entries, err := lsTree(dir, commit)
	if err != nil {
		return nil, err
	}
	var attrs []string
	for _, e := range entries {
		if path.Base(e.path) == ".gitattributes" {
			attrs = append(attrs, e.oid)
		}
	}
	if len(attrs) == 0 {
		return nil, nil
	}
	attrBlobs, err := catBlobs(dir, attrs)
	if err != nil {
		return nil, err
	}
	named := false
	for _, b := range attrBlobs {
		if bytes.Contains(b, []byte("filter=lfs")) {
			named = true
			break
		}
	}
	if !named {
		return nil, nil
	}

	var candidates []treeEntry
	for _, e := range entries {
		if e.size > 0 && e.size <= maxPointerSize && e.mode != "120000" {
			candidates = append(candidates, e)
		}
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	paths := make([]string, len(candidates))
	for i, e := range candidates {
		paths[i] = e.path
	}
	lfsPaths, err := lfsFiltered(dir, commit, paths)
	if err != nil {
		return nil, err
	}
	var kept []treeEntry
	for _, e := range candidates {
		if lfsPaths[e.path] {
			kept = append(kept, e)
		}
	}
	if len(kept) == 0 {
		return nil, nil
	}
	oids := make([]string, len(kept))
	for i, e := range kept {
		oids[i] = e.oid
	}
	blobs, err := catBlobs(dir, oids)
	if err != nil {
		return nil, err
	}
	var pointers []Pointer
	for i, e := range kept {
		if obj, ok := parsePointer(blobs[i]); ok {
			pointers = append(pointers, Pointer{Path: e.path, Object: obj})
		}
	}
	return pointers, nil
}

// lsTree lists every blob of the commit's tree, with its size.
func lsTree(dir, commit string) ([]treeEntry, error) {
	cmd := gitCommand(dir, nil, "ls-tree", "-r", "-z", "-l", "--full-tree", commit)
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("git ls-tree %s: %s", commit, oneLine(errOut.String()+" "+err.Error()))
	}
	var entries []treeEntry
	for rec := range strings.SplitSeq(out.String(), "\x00") {
		if rec == "" {
			continue
		}
		meta, p, ok := strings.Cut(rec, "\t")
		if !ok {
			return nil, fmt.Errorf("git ls-tree gave a line jr2 cannot read: %q", rec)
		}
		f := strings.Fields(meta)
		if len(f) != 4 || f[1] != "blob" {
			continue
		}
		size, err := strconv.ParseInt(f[3], 10, 64)
		if err != nil {
			continue
		}
		entries = append(entries, treeEntry{mode: f[0], oid: f[2], path: p, size: size})
	}
	return entries, nil
}

// catBlobs reads the blobs in one `git cat-file --batch`, in order.
func catBlobs(dir string, oids []string) ([][]byte, error) {
	cmd := gitCommand(dir, nil, "cat-file", "--batch")
	cmd.Stdin = strings.NewReader(strings.Join(oids, "\n") + "\n")
	var errOut bytes.Buffer
	cmd.Stderr = &errOut
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	r := bufio.NewReader(stdout)
	blobs := make([][]byte, 0, len(oids))
	var readErr error
	for range oids {
		header, err := r.ReadString('\n')
		if err != nil {
			readErr = fmt.Errorf("git cat-file ended early: %v", err)
			break
		}
		f := strings.Fields(header)
		if len(f) != 3 {
			readErr = fmt.Errorf("git cat-file cannot read %s", strings.TrimSpace(header))
			break
		}
		size, err := strconv.ParseInt(f[2], 10, 64)
		if err != nil {
			readErr = fmt.Errorf("git cat-file gave a size jr2 cannot read: %q", header)
			break
		}
		body := make([]byte, size+1)
		if _, err := io.ReadFull(r, body); err != nil {
			readErr = fmt.Errorf("git cat-file ended early: %v", err)
			break
		}
		blobs = append(blobs, body[:size])
	}
	_, _ = io.Copy(io.Discard, r)
	if err := cmd.Wait(); err != nil && readErr == nil {
		readErr = fmt.Errorf("git cat-file: %s", oneLine(errOut.String()+" "+err.Error()))
	}
	return blobs, readErr
}

// lfsFiltered tells which of paths have the `filter` attribute `lfs` in the
// commit's attributes.
func lfsFiltered(dir, commit string, paths []string) (map[string]bool, error) {
	if checkAttrSource {
		if got, err := checkAttr(dir, nil, "--source="+commit); err == nil {
			return got(paths)
		}
	}
	// The way for a git before 2.40: the commit's tree in a temp index.
	tmp, err := os.CreateTemp("", "jr2-lfs-index-")
	if err != nil {
		return nil, err
	}
	name := tmp.Name()
	_ = tmp.Close()
	_ = os.Remove(name)
	defer func() { _ = os.Remove(name) }()
	env := []string{"GIT_INDEX_FILE=" + name}
	read := gitCommand(dir, env, "read-tree", commit)
	if out, err := read.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("git read-tree %s: %s", commit, oneLine(string(out)+" "+err.Error()))
	}
	got, err := checkAttr(dir, env, "--cached")
	if err != nil {
		return nil, err
	}
	return got(paths)
}

// checkAttr gives a function that asks `git check-attr` for the filter of
// paths, with the one flag that names where the attributes come from. The
// first call with no paths tells whether git accepts the flag.
func checkAttr(dir string, env []string, flag string) (func([]string) (map[string]bool, error), error) {
	run := func(paths []string) (map[string]bool, error) {
		cmd := gitCommand(dir, env, "check-attr", flag, "-z", "--stdin", "filter")
		var in bytes.Buffer
		for _, p := range paths {
			in.WriteString(p)
			in.WriteByte(0)
		}
		cmd.Stdin = &in
		var out, errOut bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errOut
		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("git check-attr %s: %s", flag, oneLine(errOut.String()+" "+err.Error()))
		}
		got := map[string]bool{}
		f := strings.Split(out.String(), "\x00")
		for i := 0; i+2 < len(f); i += 3 {
			if f[i+2] == "lfs" {
				got[f[i]] = true
			}
		}
		return got, nil
	}
	if _, err := run(nil); err != nil {
		return nil, err
	}
	return run, nil
}

// parsePointer reads an LFS pointer (the v1 spec): a `version` line first,
// an `oid sha256:<hex>` line and a `size` line. Anything else is a plain blob.
func parsePointer(b []byte) (Object, bool) {
	text := string(b)
	if !strings.HasPrefix(text, "version https://git-lfs.github.com/spec/v1\n") &&
		!strings.HasPrefix(text, "version https://hawser.github.com/spec/v1\n") {
		return Object{}, false
	}
	var obj Object
	sized := false
	for _, line := range strings.Split(strings.TrimSuffix(text, "\n"), "\n")[1:] {
		key, value, ok := strings.Cut(line, " ")
		if !ok {
			return Object{}, false
		}
		switch key {
		case "oid":
			hexOID, ok := strings.CutPrefix(value, "sha256:")
			if !ok || !oidPattern.MatchString(hexOID) {
				return Object{}, false
			}
			obj.OID = hexOID
		case "size":
			n, err := strconv.ParseInt(value, 10, 64)
			if err != nil || n < 0 {
				return Object{}, false
			}
			obj.Size, sized = n, true
		}
	}
	return obj, obj.OID != "" && sized
}
