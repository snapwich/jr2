/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package lfstransfer

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// session drives the transfer agent over pipes, as git-lfs does: one JSON
// line in, one JSON line out.
type session struct {
	t    *testing.T
	in   *io.PipeWriter
	out  *bufio.Reader
	done chan int
}

func startAgent(t *testing.T, dir string) *session {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	s := &session{t: t, in: inW, out: bufio.NewReader(outR), done: make(chan int, 1)}
	go func() {
		code := Run(Options{Args: []string{"transfer"}, Dir: dir, Stdin: inR, Stdout: outW, Stderr: io.Discard})
		_ = outW.Close()
		s.done <- code
	}()
	return s
}

func (s *session) send(v any) {
	s.t.Helper()
	line, err := json.Marshal(v)
	if err != nil {
		s.t.Fatal(err)
	}
	if _, err := s.in.Write(append(line, '\n')); err != nil {
		s.t.Fatal(err)
	}
}

func (s *session) recv() map[string]any {
	s.t.Helper()
	line, err := s.out.ReadBytes('\n')
	if err != nil {
		s.t.Fatalf("no answer from the agent: %v", err)
	}
	var v map[string]any
	if err := json.Unmarshal(line, &v); err != nil {
		s.t.Fatalf("the agent wrote a line that is not JSON: %q", line)
	}
	return v
}

func (s *session) init() {
	s.t.Helper()
	s.send(map[string]any{"event": "init", "operation": "download", "remote": "origin", "concurrent": false, "concurrenttransfers": 1})
	if got := s.recv(); len(got) != 0 {
		s.t.Fatalf("init answer = %v, want {}", got)
	}
}

func (s *session) download(b blob) map[string]any {
	s.t.Helper()
	s.send(map[string]any{"event": "download", "oid": b.obj.OID, "size": b.obj.Size, "action": nil})
	return s.recv()
}

func (s *session) terminate() {
	s.t.Helper()
	s.send(map[string]any{"event": "terminate"})
	if code := <-s.done; code != 0 {
		s.t.Fatalf("terminate: exit %d, want 0", code)
	}
}

func lfsPod(t *testing.T, b blob) pod {
	return makePod(t, map[string]string{".gitattributes": attrsLFS, "big.bin": b.pointer})
}

// checkCopy asserts that a complete event names a temp copy of the blob under
// the clone's lfs/tmp, and not the cache's own file.
func checkCopy(t *testing.T, p pod, b blob, got map[string]any) {
	t.Helper()
	if got["event"] != "complete" || got["oid"] != b.obj.OID || got["error"] != nil {
		t.Fatalf("download answer = %v, want a complete event with a path", got)
	}
	path, _ := got["path"].(string)
	wantDir := filepath.Join(p.clone, ".git", "lfs", "tmp")
	if filepath.Dir(path) != wantDir {
		t.Fatalf("path %q is not under %s", path, wantDir)
	}
	data, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(data, b.data) {
		t.Fatalf("the temp copy holds %q (%v), want %q", data, err, b.data)
	}
	if _, err := os.Stat(objectPath(filepath.Join(p.cache, "lfs"), b.obj.OID)); err != nil {
		t.Fatalf("the cache's own file must stay: %v", err)
	}
	// git-lfs keeps this mode when it moves the copy into the clone's store,
	// so it follows the umask, as git-lfs's own downloads do.
	info, err := os.Stat(path)
	if want := os.FileMode(0o666) &^ umask(); err != nil || info.Mode().Perm() != want {
		t.Fatalf("the temp copy's mode = %v (%v), want %v", info.Mode().Perm(), err, want)
	}
}

// umask is the process's umask.
func umask() os.FileMode {
	m := syscall.Umask(0)
	syscall.Umask(m)
	return os.FileMode(m)
}

func TestTransferHitCopiesWithNoAsk(t *testing.T) {
	b := newBlob("a large file\n")
	p := lfsPod(t, b)
	land(t, filepath.Join(p.cache, "lfs"), b)
	c := newCustodian(t, p.cache)

	s := startAgent(t, p.clone)
	s.init()
	checkCopy(t, p, b, s.download(b))
	s.terminate()
	if n := len(c.asked()); n != 0 {
		t.Fatalf("a hit made %d asks, want 0", n)
	}
}

func TestTransferMissAsksThenCopies(t *testing.T) {
	b := newBlob("only the remote has this\n")
	p := lfsPod(t, b)
	c := newCustodian(t, p.cache, b)

	s := startAgent(t, p.clone)
	s.init()
	checkCopy(t, p, b, s.download(b))
	s.terminate()

	asks := c.asked()
	if len(asks) != 1 {
		t.Fatalf("a miss made %d asks, want 1", len(asks))
	}
	a := asks[0]
	if a.Identity != testIdentity || len(a.LFS.Objects) != 1 || a.LFS.Objects[0] != b.obj {
		t.Fatalf("ask = %+v, want identity %q and the one object %+v", a, testIdentity, b.obj)
	}
}

func TestTransferMissThenErrorNamesTheOID(t *testing.T) {
	b := newBlob("nobody has this\n")
	p := lfsPod(t, b)
	c := newCustodian(t, p.cache)
	const answerErr = "batch response: Repository or object not found"
	c.answerError(answerErr)

	s := startAgent(t, p.clone)
	s.init()
	got := s.download(b)
	s.terminate()

	msg := errorMessage(t, got)
	if !strings.HasPrefix(msg, "jr2:") || !strings.Contains(msg, b.obj.OID) || !strings.Contains(msg, answerErr) {
		t.Fatalf("error message = %q, want a jr2: line naming %s and %q", msg, b.obj.OID, answerErr)
	}
}

func TestTransferFaultsBecomeReasons(t *testing.T) {
	for name, set := range map[string]func(*custodian){
		"status":  func(c *custodian) { c.code = 502 },
		"shape":   func(c *custodian) { c.raw = "not json" },
		"no lfs":  func(c *custodian) { c.raw = `{"fetched":"x"}` },
		"no word": func(c *custodian) { c.raw = `{"lfs":{}}` },
	} {
		t.Run(name, func(t *testing.T) {
			b := newBlob("faulty " + name)
			p := lfsPod(t, b)
			c := newCustodian(t, p.cache)
			c.set(set)
			s := startAgent(t, p.clone)
			s.init()
			msg := errorMessage(t, s.download(b))
			s.terminate()
			if !strings.HasPrefix(msg, "jr2:") || !strings.Contains(msg, b.obj.OID) {
				t.Fatalf("error message = %q", msg)
			}
		})
	}
	t.Run("transport", func(t *testing.T) {
		b := newBlob("no custodian")
		p := lfsPod(t, b)
		t.Setenv("JR2_CUSTODIAN_URL", "http://127.0.0.1:1")
		s := startAgent(t, p.clone)
		s.init()
		msg := errorMessage(t, s.download(b))
		s.terminate()
		if !strings.HasPrefix(msg, "jr2:") || !strings.Contains(msg, b.obj.OID) {
			t.Fatalf("error message = %q", msg)
		}
	})
}

func TestTransferRefusesUpload(t *testing.T) {
	b := newBlob("a push\n")
	p := lfsPod(t, b)
	newCustodian(t, p.cache)
	s := startAgent(t, p.clone)
	s.send(map[string]any{"event": "init", "operation": "upload", "remote": "origin"})
	_ = s.recv()
	s.send(map[string]any{"event": "upload", "oid": b.obj.OID, "size": b.obj.Size, "path": "/x"})
	msg := errorMessage(t, s.recv())
	s.terminate()
	if !strings.Contains(msg, "push Effect") || !strings.Contains(msg, "ADR-0067") {
		t.Fatalf("upload refusal = %q", msg)
	}
}

func TestTransferRefusesBytesThatDoNotMatchTheOID(t *testing.T) {
	b := newBlob("the real bytes\n")
	p := lfsPod(t, b)
	bad := b
	bad.data = []byte("other bytes 15\n") // the same size, other bytes
	land(t, filepath.Join(p.cache, "lfs"), bad)
	c := newCustodian(t, p.cache)

	s := startAgent(t, p.clone)
	s.init()
	msg := errorMessage(t, s.download(b))
	s.terminate()
	if !strings.HasPrefix(msg, "jr2:") || !strings.Contains(msg, "does not match its oid") {
		t.Fatalf("error message = %q", msg)
	}
	entries, _ := os.ReadDir(filepath.Join(p.clone, ".git", "lfs", "tmp"))
	if len(entries) != 0 {
		t.Fatalf("a bad copy stays in lfs/tmp: %v", entries)
	}
	if n := len(c.asked()); n != 0 {
		t.Fatalf("a held object made %d asks", n)
	}
}

func TestTransferEndsAtEOF(t *testing.T) {
	var out bytes.Buffer
	code := Run(Options{Args: []string{"transfer"}, Dir: t.TempDir(), Stdin: strings.NewReader(""), Stdout: &out, Stderr: io.Discard})
	if code != 0 {
		t.Fatalf("exit %d at EOF", code)
	}
}

func TestUsage(t *testing.T) {
	for _, args := range [][]string{nil, {"nope"}, {"transfer", "x"}, {"fetch"}, {"fetch", "a", "b"}, {"fetch", "--bogus", "a"}, {"fetch", "--base", "main", "a"}} {
		var errOut bytes.Buffer
		if code := Run(Options{Args: args, Stderr: &errOut}); code == 0 || !strings.HasPrefix(errOut.String(), "usage: jr2-lfs") {
			t.Fatalf("%v: exit %d, stderr %q", args, code, errOut.String())
		}
	}
}

func TestIdentityOf(t *testing.T) {
	for url, want := range map[string]string{
		"ext::/opt/jr2/bin/jr2-upload-pack %S github.com/acme/app":          "github.com/acme/app",
		"ext::/opt/jr2/bin/jr2-upload-pack %S github.com/acme/my% app%%20x": "github.com/acme/my app%20x",
		"ext::/opt/jr2/bin/jr2-upload-pack  %S   github.com/acme/app  ":     "github.com/acme/app",
		"https://github.com/acme/app.git":                                   "",
		"ext::/opt/jr2/bin/jr2-upload-pack %S":                              "",
	} {
		if got := identityOf(url); got != want {
			t.Errorf("identityOf(%q) = %q, want %q", url, got, want)
		}
	}
}

func errorMessage(t *testing.T, got map[string]any) string {
	t.Helper()
	e, ok := got["error"].(map[string]any)
	if !ok || got["event"] != "complete" || got["path"] != nil {
		t.Fatalf("answer = %v, want a complete event with an error", got)
	}
	msg, _ := e["message"].(string)
	return msg
}
