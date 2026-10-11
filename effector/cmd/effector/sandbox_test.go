package main

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/gittest"
	"github.com/snapwich/jr2/effector/internal/sign"
)

const awsSecret = "aws-secret-value-0123456789"

// A Sandbox Effector: the binary with a read-only view of the Agent's /work, the node caches, a
// git credential and two secrets, as the Orchestrator composes its container: one mount holds the
// secrets and, at `@git`, the push credentials — a secret named `git` beside them included.
func startSandboxEffector(t *testing.T, p *gittest.Pod) *effector {
	t.Helper()
	e, out := startSandboxEffectorWith(t, p, false)
	if e == nil {
		t.Fatalf("the effector never served: %s", out)
	}
	return e
}

// startSandboxEffectorWith starts one, its effector.json saying whether its Workspace holds a
// credentialed command, with extra env; it answers nil and the output when the process ended
// before it served.
func startSandboxEffectorWith(t *testing.T, p *gittest.Pod, commands bool, extra ...string) (*effector, string) {
	t.Helper()
	dir := t.TempDir()
	gitDir := filepath.Join(dir, "secrets", "@git")
	// The entry's own Secret, as the operator projects it: what it is, and its token.
	entry := filepath.Join(gitDir, "jr2-git-push-0a1b2c3d")
	must(t, os.MkdirAll(entry, 0o700))
	must(t, os.WriteFile(filepath.Join(dir, "key"), []byte(placementKey+"\n"), 0o400))
	must(t, os.WriteFile(filepath.Join(dir, "secrets", "aws"), []byte(awsSecret+"\n"), 0o400))
	must(t, os.WriteFile(filepath.Join(dir, "secrets", "git"), []byte("git-named-secret-value\n"), 0o400))
	must(t, os.WriteFile(filepath.Join(entry, "entry.json"), []byte(`{"match":"*","order":0,"push":["token"]}`), 0o400))
	must(t, os.WriteFile(filepath.Join(entry, "password"), []byte("unused-token-value\n"), 0o400))
	config := `{"version":1,"placement":"sandbox","targets":[]` +
		map[bool]string{true: `,"commands":true}`, false: `}`}[commands]
	must(t, os.WriteFile(filepath.Join(dir, "effector.json"), []byte(config), 0o400))
	listen := freePort(t)
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(),
		"JR2_EFFECTOR_TEST_MAIN=1",
		"JR2_EFFECTOR_PORT="+listen,
		"JR2_EFFECTOR_KEY="+filepath.Join(dir, "key"),
		"JR2_EFFECTOR_CONFIG="+filepath.Join(dir, "effector.json"),
		"JR2_EFFECTOR_SECRETS="+filepath.Join(dir, "secrets"),
		"JR2_EFFECTOR_WORK="+p.Work,
		"JR2_EFFECTOR_REPOS="+filepath.Dir(p.Cache),
		"JR2_EFFECTOR_GIT="+gitDir,
		"JR2_EFFECTOR_SCRATCH="+filepath.Join(dir, "scratch"),
		"POD_NAME=sandbox-effector",
		"POD_IP=127.0.0.1",
		"NODE_NAME=node-1",
	)
	cmd.Env = dedupEnv(append(cmd.Env, extra...))
	out := &lockedBuffer{}
	cmd.Stdout, cmd.Stderr = out, out
	must(t, cmd.Start())
	e := &effector{cmd: cmd, base: "http://127.0.0.1:" + listen, out: out, keyFile: filepath.Join(dir, "key")}
	ended := make(chan struct{})
	go func() { _ = cmd.Wait(); close(ended) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-ended })
	deadline := time.Now().Add(10 * time.Second)
	for {
		if resp, err := http.Get(e.base + "/healthz"); err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == 200 {
				return e, ""
			}
		}
		select {
		case <-ended:
			return nil, out.String()
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("the effector never served: %s", out.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestASandboxEffectorPinsAPushToTheAgentsTipAndPushesIt(t *testing.T) {
	p := gittest.NewPod(t, "work")
	sha := p.Commit("one", map[string]string{"a.txt": "a\n"})
	e := startSandboxEffector(t, p)
	body := fmt.Sprintf(`{"kind":"push","push":{"repo":{"gitDir":"app/default/.git","worktree":"app/work",`+
		`"cache":"app-key"},"url":%q,"branch":"work"},"timeoutMs":30000}`, p.Remote)
	status, raw := e.call(t, "POST", "/effects/push-1", body)
	if status != 202 || !strings.Contains(raw, `"pinned":"`+sha+`"`) {
		t.Fatalf("got %d %s", status, raw)
	}
	// The Agent commits after the start: the push still publishes the pinned commit.
	p.Commit("two", map[string]string{"b.txt": "b\n"})
	got := e.wait(t, "push-1")
	if !strings.Contains(got, `"outcome":"pushed"`) || !strings.Contains(got, `"published":"`+sha+`"`) {
		t.Fatalf("got %s", got)
	}
	if p.RemoteTip("refs/heads/work") != sha {
		t.Fatal("the remote does not hold the pinned commit")
	}
}

// A credentialed command runs in the Sandbox Effector, and its child is confined (ADR-0068, B9):
// a committed script that reads the placement key — the Agent's code, which the author's argv
// runs — ends with a permission error, and the answer carries no key. Its named secret it reads,
// from env and from its file.
func TestASandboxEffectorRunsACredentialedCommandWhoseChildCannotReadTheKey(t *testing.T) {
	p := gittest.NewPod(t, "work")
	e, out := startSandboxEffectorWith(t, p, true)
	if e == nil {
		t.Fatalf("the effector never served: %s", out)
	}
	key := e.keyFile
	p.Commit("a committed script", map[string]string{
		"leak.sh": "base32 -w0 < '" + key + "'; cat '" + key + "'; sh -c \"cat '" + key + "'\"\n",
		"read.sh": "printf 'env=%s\\n' \"$AWS\"; printf 'file=%s\\n' \"$(cat \"$AWS_FILE\")\"\n",
	})
	start := func(id, script string) string {
		body := `{"kind":"command","command":{"repo":{"gitDir":"app/default/.git","worktree":"app/work",` +
			`"cache":"app-key"},"branch":"work","argv":["sh","` + script + `"],"env":{"AWS":{"secret":"aws"},` +
			`"AWS_FILE":{"secret":"aws","path":true}},"tail":4000},"timeoutMs":30000}`
		if status, raw := e.call(t, "POST", "/effects/"+id, body); status != 202 {
			t.Fatalf("got %d %s", status, raw)
		}
		return e.wait(t, id)
	}
	leaked := start("leak-1", "leak.sh")
	if !strings.Contains(leaked, `"outcome":"exited"`) || !strings.Contains(leaked, "Permission denied") ||
		strings.Contains(leaked, `"code":0`) {
		t.Fatalf("got %s", leaked)
	}
	for _, v := range []string{placementKey, base32.StdEncoding.EncodeToString([]byte(placementKey))[:16]} {
		if strings.Contains(leaked, v) {
			t.Fatalf("the answer carries the key: %s", leaked)
		}
	}
	read := start("read-1", "read.sh")
	if !strings.Contains(read, `env=[secret:aws]\nfile=[secret:aws]\n`) || !strings.Contains(read, `"code":0`) {
		t.Fatalf("got %s", read)
	}
}

// The Landlock probe (ADR-0068, B9): on a node whose kernel cannot confine a child, a Sandbox
// Effector whose Workspace holds a credentialed command never becomes ready, and says why with the
// node's name — its termination message, which the Sandbox's status carries. One whose Workspace
// holds none serves its other kinds and refuses a command start.
func TestTheLandlockProbeStopsTheStartWhenTheWorkspaceHoldsACredentialedCommand(t *testing.T) {
	p := gittest.NewPod(t, "work")
	e, out := startSandboxEffectorWith(t, p, true, "JR2_EFFECTOR_TEST_NO_LANDLOCK=1")
	if e != nil {
		t.Fatal("the effector served on a node that cannot confine its command's child")
	}
	if !strings.Contains(out, "landlock: unavailable on node node-1") || !strings.Contains(out, "EOPNOTSUPP") {
		t.Fatalf("got %s", out)
	}
	e, out = startSandboxEffectorWith(t, p, false, "JR2_EFFECTOR_TEST_NO_LANDLOCK=1")
	if e == nil {
		t.Fatalf("a Workspace with no credentialed command stopped: %s", out)
	}
	body := `{"kind":"command","command":{"repo":{"gitDir":"app/default/.git","worktree":"app/work",` +
		`"cache":"app-key"},"branch":"work","argv":["true"],"env":{"AWS":{"secret":"aws"}},"tail":4000},` +
		`"timeoutMs":30000}`
	if status, raw := e.call(t, "POST", "/effects/c-1", body); status != 400 ||
		!strings.Contains(raw, "landlock: unavailable on node node-1") {
		t.Fatalf("got %d %s", status, raw)
	}
}

// The child's PATH is the Effector container's own, as its image set it, and argv[0] is looked up
// there (ADR-0067): a tool the image keeps on its own PATH — outside the FHS defaults — runs. The
// binary passes its own PATH to the child; a test that set the Runner's Path by hand could not see
// that the binary never wired it (run B3 defect).
func TestACredentialedCommandFindsItsToolOnTheContainersPath(t *testing.T) {
	p := gittest.NewPod(t, "work")
	p.Commit("one", map[string]string{"a.txt": "a\n"})
	// A tool the author's image keeps on its PATH, outside /usr/local/bin:/usr/bin:/bin.
	bin := t.TempDir()
	must(t, os.WriteFile(filepath.Join(bin, "deploytool"), []byte("#!/bin/sh\necho deployed\n"), 0o755))
	e, out := startSandboxEffectorWith(t, p, true, "PATH="+bin+":/usr/bin:/bin")
	if e == nil {
		t.Fatalf("the effector never served: %s", out)
	}
	body := `{"kind":"command","command":{"repo":{"gitDir":"app/default/.git","worktree":"app/work",` +
		`"cache":"app-key"},"branch":"work","argv":["deploytool"],"env":{"AWS":{"secret":"aws"}},"tail":4000},` +
		`"timeoutMs":30000}`
	if status, raw := e.call(t, "POST", "/effects/tool-1", body); status != 202 {
		t.Fatalf("got %d %s", status, raw)
	}
	got := e.wait(t, "tool-1")
	if !strings.Contains(got, `"outcome":"exited"`) || !strings.Contains(got, `"code":0`) ||
		!strings.Contains(got, `deployed`) {
		t.Fatalf("the tool on the container's PATH did not run: %s", got)
	}
}

// dedupEnv keeps the last value of each variable, so a test's `extra` PATH wins over the inherited
// one and the child reads the one the test set.
func dedupEnv(env []string) []string {
	seen := map[string]int{}
	out := make([]string, 0, len(env))
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		if i, ok := seen[name]; ok {
			out[i] = kv
			continue
		}
		seen[name] = len(out)
		out = append(out, kv)
	}
	return out
}

// wait polls a started Effect to its output.
func (e *effector) wait(t *testing.T, id string) string {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		status, raw := e.call(t, "GET", "/effects/"+id, "")
		if status != 200 {
			t.Fatalf("poll: got %d %s", status, raw)
		}
		if strings.Contains(raw, `"state":"settled"`) {
			return raw
		}
		if time.Now().After(deadline) {
			t.Fatalf("never settled: %s", raw)
		}
	}
}

// callRaw sends a signed request and says whether the answer carries the Effector's signature.
func (e *effector) callRaw(t *testing.T, method, path, body string) (int, string, bool) {
	t.Helper()
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	nonce := hex.EncodeToString(b)
	at := strconv.FormatInt(time.Now().UnixMilli(), 10)
	req, _ := http.NewRequest(method, e.base+path, strings.NewReader(body))
	req.Header.Set(sign.HeaderTime, at)
	req.Header.Set(sign.HeaderNonce, nonce)
	req.Header.Set(sign.HeaderSignature, sign.RequestMAC([]byte(placementKey), method,
		strings.TrimPrefix(e.base, "http://"), path, at, nonce, []byte(body)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err.Error(), false
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	signed := resp.Header.Get(sign.HeaderSignature) ==
		sign.ResponseMAC([]byte(placementKey), resp.StatusCode, method, path, nonce, raw)
	return resp.StatusCode, string(raw), signed
}

// B2: a process in the Harness container takes the Effector's port while the Effector is down.
// It receives the signed request, which names a secret and carries no value of one, and its
// answer carries no signature the key verifies — so it is no answer, and the Effect fails closed.
func TestAPortTakeoverReceivesASignedRequestThatCarriesNoSecretAndCannotAnswerIt(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(t, err)
	defer func() { _ = listener.Close() }()
	got := make(chan string, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		buf := make([]byte, 64<<10)
		n, _ := conn.Read(buf)
		got <- string(buf[:n])
		// It holds no key: whatever it answers is unsigned, or signed with a key it guessed.
		_, _ = io.WriteString(conn, "HTTP/1.1 200 OK\r\nX-Jr2-Signature: forged\r\nContent-Length: 2\r\n\r\n{}")
	}()
	e := &effector{base: "http://" + listener.Addr().String()}
	body := `{"kind":"command","command":{"repo":{"gitDir":"app/default/.git","worktree":"app/work","cache":"k"},` +
		`"branch":"work","argv":["deploy"],"env":{"AWS":{"secret":"aws"}},"tail":100},"timeoutMs":1000}`
	status, raw, signed := e.callRaw(t, "POST", "/effects/takeover", body)
	if signed {
		t.Fatalf("the takeover's answer verified: %d %s", status, raw)
	}
	request := <-got
	if !strings.Contains(request, sign.HeaderSignature) || !strings.Contains(request, `"secret":"aws"`) {
		t.Fatalf("the takeover did not get the signed request: %s", request)
	}
	if strings.Contains(request, awsSecret) || strings.Contains(request, placementKey) {
		t.Fatalf("the request carries a secret: %s", request)
	}
}
