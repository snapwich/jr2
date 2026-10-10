package pushkind

import (
	"encoding/base64"
	"encoding/pem"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/wire"
)

const token = "tok-0123456789abcdef"

// A smart-HTTP git server over TLS on loopback (git http-backend), which takes a push only with
// Basic `x-access-token:<token>`, and records every Authorization it saw.
func tokenServer(t *testing.T, root string) (*httptest.Server, *[]string) {
	t.Helper()
	backend := ""
	for _, dir := range []string{"/usr/lib/git-core", "/usr/libexec/git-core"} {
		if _, err := os.Stat(filepath.Join(dir, "git-http-backend")); err == nil {
			backend = filepath.Join(dir, "git-http-backend")
		}
	}
	if backend == "" {
		t.Skip("no git-http-backend")
	}
	var mu sync.Mutex
	seen := []string{}
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte(HelperUser+":"+token))
	cgiHandler := &cgi.Handler{
		Path: backend,
		Env: []string{"GIT_PROJECT_ROOT=" + root, "GIT_HTTP_EXPORT_ALL=1", "REMOTE_USER=bot",
			"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1"},
	}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		mu.Lock()
		seen = append(seen, auth)
		mu.Unlock()
		if auth != want {
			w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		cgiHandler.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

func TestATokenPushGoesBasicThroughTheHelperAndTheTokenIsInNoOutput(t *testing.T) {
	f := newFixture(t, "")
	sha := f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	srv, seen := tokenServer(t, filepath.Dir(f.pod.Remote))
	if err := os.WriteFile(filepath.Join(f.runner.GitRoot, "push", "token"), []byte(token+"\n"), 0o400); err != nil {
		t.Fatal(err)
	}
	ca := filepath.Join(f.pod.Root, "ca.pem")
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	if err := os.WriteFile(ca, cert, 0o644); err != nil {
		t.Fatal(err)
	}
	f.runner.CAFile = ca
	f.runner.Scrubber = scrub.New(map[string]string{"git:push/token": token})
	url := srv.URL + "/" + filepath.Base(f.pod.Remote)
	f.runner.Config.Git[0].Match = "*"

	req := f.request(false, nil)
	req.Push.URL = url
	out := f.runner.Run(t.Context(), req)
	if out.Outcome != wire.OutcomePushed || out.Push.Published != sha {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != sha {
		t.Fatal("the remote does not hold the push")
	}
	sawBasic := false
	for _, a := range *seen {
		if strings.HasPrefix(a, "Basic ") {
			sawBasic = true
		}
		if strings.Contains(a, "Bearer") {
			t.Fatalf("a bearer was sent: %q", a)
		}
	}
	if !sawBasic {
		t.Fatal("the token never went Basic")
	}

	// A wrong token: rejected, and its words carry no form of the token.
	_ = os.Remove(filepath.Join(f.runner.GitRoot, "push", "token"))
	if err := os.WriteFile(filepath.Join(f.runner.GitRoot, "push", "token"), []byte("tok-wrong-wrong-wrong"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.pod.Commit("two", map[string]string{"b.txt": "b\n"})
	req = f.request(false, nil)
	req.Push.URL = url
	bad := f.runner.Run(t.Context(), req)
	if bad.Outcome != wire.OutcomeRejected || !strings.Contains(bad.Reason, "credential") {
		t.Fatalf("got %+v %+v", bad, bad.Push)
	}
	encoded, _ := wire.Encode(bad)
	if strings.Contains(string(encoded), "tok-") {
		t.Fatalf("a token reached the output: %s", encoded)
	}
}

func TestTheHelperAnswersOnlyGetAndOnlyFromItsFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(file, []byte(token+"\n"), 0o400); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JR2_GIT_TOKEN_FILE", file)
	var out strings.Builder
	if code := Helper([]string{"get"}, strings.NewReader("protocol=https\nhost=x\n\n"), &out); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if out.String() != "username="+HelperUser+"\npassword="+token+"\n" {
		t.Fatalf("got %q", out.String())
	}
	out.Reset()
	if code := Helper([]string{"store"}, strings.NewReader("password=x\n\n"), &out); code != 0 || out.Len() != 0 {
		t.Fatalf("store: %d %q", code, out.String())
	}
	t.Setenv("JR2_GIT_TOKEN_FILE", "")
	if code := Helper([]string{"get"}, strings.NewReader("\n"), &out); code == 0 {
		t.Fatal("answered with no file")
	}
	// The binary itself is the helper git runs.
	cmd := exec.Command(os.Args[0], "git-credential", "get")
	cmd.Env = append(os.Environ(), "JR2_GIT_TOKEN_FILE="+file)
	cmd.Stdin = strings.NewReader("\n")
	got, err := cmd.Output()
	if err != nil || !strings.Contains(string(got), "password="+token) {
		t.Fatalf("%v %q", err, got)
	}
}
