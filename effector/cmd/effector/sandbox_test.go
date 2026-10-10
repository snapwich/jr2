package main

import (
	"crypto/rand"
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
// git credential and a secret, as the Orchestrator composes its container.
func startSandboxEffector(t *testing.T, p *gittest.Pod) *effector {
	t.Helper()
	dir := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(dir, "secrets"), 0o700))
	must(t, os.MkdirAll(filepath.Join(dir, "git", "push"), 0o700))
	must(t, os.WriteFile(filepath.Join(dir, "key"), []byte(placementKey+"\n"), 0o400))
	must(t, os.WriteFile(filepath.Join(dir, "secrets", "aws"), []byte(awsSecret+"\n"), 0o400))
	must(t, os.WriteFile(filepath.Join(dir, "git", "push", "token"), []byte("unused-token-value\n"), 0o400))
	must(t, os.WriteFile(filepath.Join(dir, "effector.json"),
		[]byte(`{"version":1,"placement":"sandbox","targets":[],"git":[{"match":"*","push":{"token":"push"}}]}`), 0o400))
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
		"JR2_EFFECTOR_GIT="+filepath.Join(dir, "git"),
		"JR2_EFFECTOR_SCRATCH="+filepath.Join(dir, "scratch"),
		"POD_NAME=sandbox-effector",
		"POD_IP=127.0.0.1",
	)
	out := &lockedBuffer{}
	cmd.Stdout, cmd.Stderr = out, out
	must(t, cmd.Start())
	e := &effector{cmd: cmd, base: "http://127.0.0.1:" + listen, out: out, keyFile: filepath.Join(dir, "key")}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	deadline := time.Now().Add(10 * time.Second)
	for {
		if resp, err := http.Get(e.base + "/healthz"); err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == 200 {
				return e
			}
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

func TestASandboxEffectorRunsACredentialedCommandAndScrubsIt(t *testing.T) {
	p := gittest.NewPod(t, "work")
	sha := p.Commit("one", map[string]string{"a.txt": "a\n"})
	e := startSandboxEffector(t, p)
	body := `{"kind":"command","command":{"repo":{"gitDir":"app/default/.git","worktree":"app/work",` +
		`"cache":"app-key"},"branch":"work","argv":["sh","-c","echo $AWS; cat $AWS_FILE; cat a.txt"],` +
		`"env":{"AWS":{"secret":"aws"},"AWS_FILE":{"secret":"aws","path":true}},"tail":1000},"timeoutMs":30000}`
	status, raw := e.call(t, "POST", "/effects/cmd-1", body)
	if status != 202 || !strings.Contains(raw, `"pinned":"`+sha+`"`) {
		t.Fatalf("got %d %s", status, raw)
	}
	got := e.wait(t, "cmd-1")
	if !strings.Contains(got, `"outcome":"exited"`) || !strings.Contains(got, `[secret:aws]\n[secret:aws]\na\n`) ||
		strings.Contains(got, awsSecret) {
		t.Fatalf("got %s", got)
	}
	if strings.Contains(e.out.String(), awsSecret) {
		t.Fatalf("the log holds the secret: %s", e.out.String())
	}
}

// B3.2: the scrubber matches every secret the Effector holds — its own placement key too. A
// credentialed command may run a file the Agent committed (B4.6), and its child can read the key's
// file; a key that reached the Agent would sign any start from bash in the Harness container.
func TestACredentialedCommandThatReadsThePlacementKeyReturnsItScrubbed(t *testing.T) {
	p := gittest.NewPod(t, "work")
	e := startSandboxEffector(t, p)
	keyFile := e.keyFile
	p.Commit("a committed script", map[string]string{"leak.sh": "cat '" + keyFile + "'; base64 < '" + keyFile + "'\n"})
	body := `{"kind":"command","command":{"repo":{"gitDir":"app/default/.git","worktree":"app/work",` +
		`"cache":"app-key"},"branch":"work","argv":["sh","leak.sh"],"env":{"AWS":{"secret":"aws"}},"tail":4000},` +
		`"timeoutMs":30000}`
	if status, raw := e.call(t, "POST", "/effects/leak-1", body); status != 202 {
		t.Fatalf("got %d %s", status, raw)
	}
	got := e.wait(t, "leak-1")
	if !strings.Contains(got, `"outcome":"exited"`) || !strings.Contains(got, "[secret:effector-key]") ||
		strings.Contains(got, placementKey) {
		t.Fatalf("got %s", got)
	}
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
