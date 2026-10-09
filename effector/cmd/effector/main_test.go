package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/sign"
)

// The test binary doubles as the effector: re-executed with JR2_EFFECTOR_TEST_MAIN set, it runs
// main() — so these tests drive the real process, its env, its mount layout and its SIGTERM.
func TestMain(m *testing.M) {
	if os.Getenv("JR2_EFFECTOR_TEST_MAIN") == "1" {
		os.Args = os.Args[:1]
		logger := log.New(os.Stdout, "", 0)
		if err := run(logger); err != nil {
			logger.Printf("jr2.effector action=exit reason=%q", err.Error())
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

const placementKey = "an-effector-placement-key-0123456789abcdef"
const jiraSecret = "jira-secret-value-0123"

type effector struct {
	cmd  *exec.Cmd
	base string
	out  *strings.Builder
}

func startEffector(t *testing.T, upstream string, extra ...string) *effector {
	t.Helper()
	dir := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(dir, "secrets"), 0o700))
	must(t, os.WriteFile(filepath.Join(dir, "key"), []byte(placementKey+"\n"), 0o400))
	must(t, os.WriteFile(filepath.Join(dir, "secrets", "jira"), []byte(jiraSecret+"\n"), 0o400))
	u, _ := url.Parse(upstream)
	must(t, os.WriteFile(filepath.Join(dir, "effector.json"), fmt.Appendf(nil,
		`{"version":1,"placement":"instance","targets":[{"scheme":"http","host":%q,"port":%s,"secrets":["jira"]}]}`,
		u.Hostname(), u.Port()), 0o400))
	port := freePort(t)
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(),
		"JR2_EFFECTOR_TEST_MAIN=1",
		"JR2_EFFECTOR_PORT="+port,
		"JR2_EFFECTOR_KEY="+filepath.Join(dir, "key"),
		"JR2_EFFECTOR_CONFIG="+filepath.Join(dir, "effector.json"),
		"JR2_EFFECTOR_SECRETS="+filepath.Join(dir, "secrets"),
		"POD_NAME=effector-test-0",
		"POD_IP=127.0.0.1",
	)
	cmd.Env = append(cmd.Env, extra...)
	out := &strings.Builder{}
	cmd.Stdout = out
	cmd.Stderr = out
	must(t, cmd.Start())
	e := &effector{cmd: cmd, base: "http://127.0.0.1:" + port, out: out}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, err := http.Get(e.base + "/healthz")
		if err == nil {
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

func (e *effector) call(t *testing.T, method, path, body string) (int, string) {
	t.Helper()
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	nonce := hex.EncodeToString(b)
	at := strconv.FormatInt(time.Now().UnixMilli(), 10)
	req, _ := http.NewRequest(method, e.base+path, strings.NewReader(body))
	req.Header.Set(sign.HeaderTime, at)
	req.Header.Set(sign.HeaderNonce, nonce)
	req.Header.Set(sign.HeaderSignature, sign.RequestMAC([]byte(placementKey), method, path, at, nonce, []byte(body)))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.Header.Get(sign.HeaderSignature) != sign.ResponseMAC([]byte(placementKey), resp.StatusCode, method, path, nonce, raw) {
		t.Fatalf("an unsigned answer: %d %s", resp.StatusCode, raw)
	}
	return resp.StatusCode, string(raw)
}

func TestTheBinaryRunsAnHttpEffectAndScrubsItsAnswer(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, "you sent "+r.Header.Get("Authorization"))
	}))
	defer upstream.Close()
	e := startEffector(t, upstream.URL)
	body := fmt.Sprintf(`{"kind":"http","method":"GET","url":[{"text":%q}],"auth":{"bearer":{"secret":"jira"}},"timeoutMs":5000,"maxBody":1000}`, upstream.URL)
	if status, raw := e.call(t, "POST", "/effects/one", body); status != 202 || !strings.Contains(raw, `"name":"effector-test-0"`) {
		t.Fatalf("got %d %s", status, raw)
	}
	status, raw := e.call(t, "GET", "/effects/one", "")
	if status != 200 || !strings.Contains(raw, `"body":"you sent [secret:jira]"`) || strings.Contains(raw, jiraSecret) {
		t.Fatalf("got %d %s", status, raw)
	}
	if strings.Contains(e.out.String(), jiraSecret) {
		t.Fatalf("the log holds the secret: %s", e.out.String())
	}
}

func TestSigtermFinishesTheEffectInFlightAndRefusesNewOnes(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release
		_, _ = io.WriteString(w, "done")
	}))
	// Cleanups run last-registered first: the upstream's handlers are released before it closes, so
	// a failed assertion below ends the test instead of hanging it.
	t.Cleanup(upstream.Close)
	releaseAll := sync.OnceFunc(func() { close(release) })
	t.Cleanup(releaseAll)
	e := startEffector(t, upstream.URL)
	body := fmt.Sprintf(`{"kind":"http","method":"POST","url":[{"text":%q}],"timeoutMs":10000,"maxBody":100}`, upstream.URL)
	if status, raw := e.call(t, "POST", "/effects/inflight", body); status != 202 {
		t.Fatalf("got %d %s", status, raw)
	}
	must(t, e.cmd.Process.Signal(syscall.SIGTERM))
	// A new id each time: a POST that lands before the signal is handled starts its Effect, and a
	// second POST with that id would only attach to it (B2.1), never get the refusal this waits for.
	// An Effect started that way is in flight too; its outcome is read below.
	var started []string
	deadline := time.Now().Add(5 * time.Second)
	for i := 0; ; i++ {
		id := "late-" + strconv.Itoa(i)
		status, raw := e.call(t, "POST", "/effects/"+id, body)
		if status == 503 && strings.Contains(raw, "stopping") {
			break
		}
		if status == 202 {
			started = append(started, id)
		}
		if time.Now().After(deadline) {
			t.Fatalf("a new Effect is still taken: %d %s", status, raw)
		}
		time.Sleep(20 * time.Millisecond)
	}
	releaseAll()
	for _, id := range append([]string{"inflight"}, started...) {
		status, raw := e.call(t, "GET", "/effects/"+id, "")
		if status != 200 || !strings.Contains(raw, `"body":"done"`) {
			t.Fatalf("%s: got %d %s", id, status, raw)
		}
	}
	exited := make(chan error, 1)
	go func() { exited <- e.cmd.Wait() }()
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("exit: %v\n%s", err, e.out.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the effector did not exit once its outcome was read")
	}
}

func TestAShortSecretStopsTheStart(t *testing.T) {
	dir := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(dir, "secrets"), 0o700))
	must(t, os.WriteFile(filepath.Join(dir, "key"), []byte(placementKey), 0o400))
	must(t, os.WriteFile(filepath.Join(dir, "secrets", "tiny"), []byte("short"), 0o400))
	must(t, os.WriteFile(filepath.Join(dir, "effector.json"), []byte(`{"version":1,"placement":"instance","targets":[]}`), 0o400))
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "JR2_EFFECTOR_TEST_MAIN=1", "JR2_EFFECTOR_PORT="+freePort(t),
		"JR2_EFFECTOR_KEY="+filepath.Join(dir, "key"), "JR2_EFFECTOR_CONFIG="+filepath.Join(dir, "effector.json"),
		"JR2_EFFECTOR_SECRETS="+filepath.Join(dir, "secrets"))
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "secret tiny is shorter than 8") {
		t.Fatalf("got %v: %s", err, out)
	}
}

func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	_, port, _ := net.SplitHostPort(l.Addr().String())
	return port
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
