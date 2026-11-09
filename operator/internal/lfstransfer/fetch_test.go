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
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
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

// gitCalls is what the logging git saw: each argv, and the stdin of each
// cat-file.
type gitCalls struct {
	argv, catIn string
}

// gitLog puts a git on PATH that logs each argv to a file, and the stdin of
// each cat-file to a second file, then runs the real git. It shows which git
// commands a fetch runs and which blobs it reads. Each call must carry
// safeConfig; calls() gives the argv after it.
func gitLog(t *testing.T) func() []string {
	t.Helper()
	l := gitLogFull(t)
	return l.calls
}

type gitLogger struct {
	t     *testing.T
	files gitCalls
}

func gitLogFull(t *testing.T) *gitLogger {
	t.Helper()
	real, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git is not on PATH")
	}
	dir := t.TempDir()
	l := &gitLogger{t: t, files: gitCalls{argv: filepath.Join(dir, "log"), catIn: filepath.Join(dir, "cat-in")}}
	script := fmt.Sprintf(`#!/bin/sh
echo "$*" >> %[1]q
case " $* " in
*" cat-file "*) tee -a %[2]q | exec %[3]q "$@" ;;
esac
exec %[3]q "$@"
`, l.files.argv, l.files.catIn, real)
	if err := os.WriteFile(filepath.Join(dir, "git"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return l
}

func (l *gitLogger) calls() []string {
	l.t.Helper()
	data, _ := os.ReadFile(l.files.argv)
	prefix := strings.Join(safeConfig, " ") + " "
	var calls []string
	for line := range strings.SplitSeq(strings.TrimSpace(string(data)), "\n") {
		rest, ok := strings.CutPrefix(line, prefix)
		if !ok {
			l.t.Fatalf("git %q ran with no %q", line, prefix)
		}
		calls = append(calls, rest)
	}
	return calls
}

// catInput is every oid that a cat-file read, in order.
func (l *gitLogger) catInput() []string {
	data, _ := os.ReadFile(l.files.catIn)
	return strings.Fields(string(data))
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
	const answerErr = "object d not found on the remote"
	c.answerError(answerErr)

	// Probe first: only a git with `check-attr --source` (2.40 and later) must
	// do without the temp index.
	probe := exec.Command("git", "-C", p.clone, "check-attr", "--source=HEAD", "filter", "--", "a.bin")
	hasSource := probe.Run() == nil
	calls := gitLog(t)
	r := fetch(t, p.clone, "main")
	for _, call := range calls() {
		if hasSource && strings.HasPrefix(call, "read-tree") {
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
	if !slices.Equal(got, want) || asks[0].Identity != testIdentity {
		t.Fatalf("ask = %+v, want objects %v", asks[0], want)
	}
	if len(r.Missing) != 1 || r.Missing[0].Path != "d.bin" || r.Missing[0].OID != absent.obj.OID ||
		r.Missing[0].Reason != answerErr {
		t.Fatalf("missing = %+v, want d.bin with the answer's error", r.Missing)
	}
}

func TestFetchFlagsOverrideTheConfig(t *testing.T) {
	b := newBlob("flags")
	p := makePod(t, map[string]string{".gitattributes": attrsLFS, "x.bin": b.pointer})
	c := newCustodian(t, p.cache, b)
	r := fetch(t, p.clone, "--identity", "gitlab.com/x/y", "--", "HEAD")
	if r.Asked != 1 || len(r.Missing) != 0 {
		t.Fatalf("result = %+v", r)
	}
	if a := c.asked()[0]; a.Identity != "gitlab.com/x/y" {
		t.Fatalf("ask = %+v", a)
	}
}

func TestFetchIgnoresAGitattributesThatGitIgnores(t *testing.T) {
	// git reads no .gitattributes over 100 MB; the program reads none either,
	// so a commit whose only `filter=lfs` is in such a file has no LFS file.
	maxAttributesSize = int64(len(attrsLFS)) - 1
	t.Cleanup(func() { maxAttributesSize = 100 << 20 })
	b := newBlob("too large attributes")
	p := makePod(t, map[string]string{".gitattributes": attrsLFS, "x.bin": b.pointer})
	c := newCustodian(t, p.cache, b)
	r := fetch(t, p.clone, "main")
	if r.Pointers != 0 || r.Asked != 0 || len(c.asked()) != 0 {
		t.Fatalf("result = %+v, asks %d: want no LFS file", r, len(c.asked()))
	}
}

func TestFetchBudgetEndsTheAsksAndNamesTheFiles(t *testing.T) {
	b := newBlob("slow")
	p := makePod(t, map[string]string{".gitattributes": attrsLFS, "x.bin": b.pointer})
	// The stand-in never answers within the budget.
	release := make(chan struct{})
	var asks atomic.Int32
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asks.Add(1)
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(release); slow.Close() })
	t.Setenv("JR2_CUSTODIAN_URL", slow.URL)
	start := time.Now()
	r := fetch(t, p.clone, "--budget", "300ms", "main")
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("the budget did not end the ask: it took %s", took)
	}
	if len(r.Missing) != 1 || r.Missing[0].Path != "x.bin" ||
		!strings.Contains(r.Missing[0].Reason, "within the budget of") {
		t.Fatalf("missing = %+v, want x.bin and the budget's words", r.Missing)
	}

	// A budget that is already spent sends no ask and names each file.
	for _, budget := range []string{"--budget=0s", "--budget=-2s"} {
		before := asks.Load()
		r = fetch(t, p.clone, budget, "main")
		if r.Asked != 0 || len(r.Missing) != 1 || r.Missing[0].Path != "x.bin" || r.Missing[0].Reason != NoTimeToAsk {
			t.Fatalf("%s: result = %+v", budget, r)
		}
		if n := asks.Load() - before; n != 0 {
			t.Fatalf("%s: %d asks went, want none", budget, n)
		}
	}

	// A budget that is not a duration is a usage fault.
	var out, errOut strings.Builder
	if code := Run(Options{Args: []string{"fetch", "--budget", "soon", "main"}, Dir: p.clone, Stdout: &out, Stderr: &errOut}); code != 2 {
		t.Fatalf("exit %d, want 2", code)
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
	const attrs = "*.sh text eol=lf\n"
	for name, files := range map[string]map[string]string{
		"no .gitattributes":   {"a.bin": newBlob("x").pointer, "README": "jr2\n"},
		"no filter=lfs in it": {".gitattributes": attrs, "a.bin": newBlob("x").pointer},
	} {
		t.Run(name, func(t *testing.T) {
			p := makePod(t, files)
			c := newCustodian(t, p.cache)
			l := gitLogFull(t)
			r := fetch(t, p.clone, "main")
			if r.Pointers != 0 || r.Asked != 0 || len(r.Missing) != 0 || len(c.asked()) != 0 {
				t.Fatalf("result = %+v, asks %d", r, len(c.asked()))
			}
			trees, cats := 0, 0
			for _, call := range l.calls() {
				switch {
				case strings.HasPrefix(call, "ls-tree"):
					trees++
				case strings.HasPrefix(call, "cat-file"):
					cats++
				case strings.HasPrefix(call, "check-attr") || strings.HasPrefix(call, "read-tree"):
					t.Fatalf("a commit with no LFS ran %q", call)
				}
			}
			if trees != 1 {
				t.Fatalf("%d tree listings, want 1: %v", trees, l.calls())
			}
			// One cat-file reads the .gitattributes blob alone, if there is
			// one, and no other blob.
			var want []string
			if _, has := files[".gitattributes"]; has {
				want = []string{run(t, p.clone, "rev-parse", "main:.gitattributes")}
			}
			if cats != len(want) || !slices.Equal(l.catInput(), want) {
				t.Fatalf("%d cat-file runs read %v, want %v", cats, l.catInput(), want)
			}
		})
	}
}

// TestFetchRunsNoProgramOfTheClone plants an fsmonitor and hooks in the
// clone's config. The cut and the attach call fetch in a clone whose config
// the Agent can write, and no program of the Agent's may run then (ADR-0075).
func TestFetchRunsNoProgramOfTheClone(t *testing.T) {
	for _, source := range []bool{true, false} {
		t.Run(fmt.Sprintf("check-attr --source %v", source), func(t *testing.T) {
			checkAttrSource = source
			t.Cleanup(func() { checkAttrSource = true })
			b := newBlob("planted")
			p := makePod(t, map[string]string{".gitattributes": attrsLFS, "x.bin": b.pointer})
			dir := t.TempDir()
			marker := filepath.Join(dir, "ran")
			prog := filepath.Join(dir, "planted")
			if err := os.WriteFile(prog, []byte("#!/bin/sh\necho \"$0 $*\" >> "+marker+"\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			hooks := filepath.Join(dir, "hooks")
			if err := os.MkdirAll(hooks, 0o755); err != nil {
				t.Fatal(err)
			}
			for _, h := range []string{"post-index-change", "post-checkout", "reference-transaction"} {
				if err := os.Symlink(prog, filepath.Join(hooks, h)); err != nil {
					t.Fatal(err)
				}
			}
			run(t, p.clone, "config", "core.fsmonitor", prog)
			run(t, p.clone, "config", "core.hooksPath", hooks)
			newCustodian(t, p.cache, b)
			if r := fetch(t, p.clone, "main"); r.Pointers != 1 {
				t.Fatalf("result = %+v", r)
			}
			if data, err := os.ReadFile(marker); err == nil {
				t.Fatalf("fetch ran the clone's planted program:\n%s", data)
			}
		})
	}
}

// TestFetchReadsNoAttributesFileOfTheHome plants an attributes file in the
// HOME. The cut's HOME is a folder that the Agents write, and git reads
// `$XDG_CONFIG_HOME/git/attributes` when no config names another file, also
// with no global config. A rule there must not make a file an LFS file that
// the commit's own attributes do not (ADR-0075).
func TestFetchReadsNoAttributesFileOfTheHome(t *testing.T) {
	for _, source := range []bool{true, false} {
		t.Run(fmt.Sprintf("check-attr --source %v", source), func(t *testing.T) {
			checkAttrSource = source
			t.Cleanup(func() { checkAttrSource = true })
			b := newBlob("in the commit's attributes")
			other := newBlob("only in the HOME's attributes")
			p := makePod(t, map[string]string{".gitattributes": attrsLFS, "x.bin": b.pointer, "y.txt": other.pointer})
			home := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "git")
			if err := os.MkdirAll(home, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(home, "attributes"), []byte("*.txt filter=lfs\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			newCustodian(t, p.cache, b, other)
			if r := fetch(t, p.clone, "main"); r.Pointers != 1 || r.Asked != 1 {
				t.Fatalf("result = %+v, want the one LFS file of the commit's own attributes", r)
			}
		})
	}
}

// TestGitReadsNoCommitGraphAndNoMultiPackIndex: each git that the program
// starts reads no commit-graph and no multi-pack-index, which an Agent can
// write in the clone with no object rewritten (ADR-0075). git 2.56 then reads
// another tree for a commit; the git of this host may not, so the test reads
// the arguments.
func TestGitReadsNoCommitGraphAndNoMultiPackIndex(t *testing.T) {
	args := gitCommand(t.TempDir(), nil, "ls-tree", "HEAD").Args
	joined := strings.Join(args, " ")
	for _, pin := range []string{
		"-c core.commitGraph=false",
		"-c core.multiPackIndex=false",
		"-c core.attributesFile=/dev/null",
		"-c core.fsmonitor=false",
		"-c core.hooksPath=/dev/null",
	} {
		if !strings.Contains(joined, pin) {
			t.Fatalf("git %s: no %q", joined, pin)
		}
	}
	if args[len(args)-2] != "ls-tree" {
		t.Fatalf("the pins come before the subcommand: %v", args)
	}
}

// TestFetchFromASubdirectory runs fetch below the top of the checkout. An
// attribute pattern with a directory still matches.
func TestFetchFromASubdirectory(t *testing.T) {
	b := newBlob("in assets")
	p := makePod(t, map[string]string{".gitattributes": "assets/*.bin filter=lfs -text\n", "assets/x.bin": b.pointer})
	sub := filepath.Join(p.clone, "src")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	newCustodian(t, p.cache, b)
	if r := fetch(t, sub, "main"); r.Pointers != 1 || r.Asked != 1 || len(r.Missing) != 0 {
		t.Fatalf("result = %+v, want the one pointer", r)
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
