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
	t.Setenv("JR2_GIT_TOKEN_HOST", "x")
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
	cmd.Env = append(os.Environ(), "JR2_GIT_TOKEN_FILE="+file, "JR2_GIT_TOKEN_HOST=x")
	cmd.Stdin = strings.NewReader("protocol=https\nhost=x\n\n")
	got, err := cmd.Output()
	if err != nil || !strings.Contains(string(got), "password="+token) {
		t.Fatalf("%v %q", err, got)
	}
}

// A redirect from the Binding's host takes neither the push nor the token to another origin:
// the clean repository follows no redirect, and the helper answers only the Binding's host.
func TestARedirectTakesTheTokenToNoOtherOrigin(t *testing.T) {
	for _, scheme := range []string{"https", "http"} {
		t.Run(scheme, func(t *testing.T) {
			f := newFixture(t, "")
			f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
			before := remoteRef(f)
			// The other origin: a git server that takes this token and records what it saw — over
			// TLS on another port (only the redirect and the helper stop it), or plain http.
			var elsewhere string
			var asked func() int
			if scheme == "https" {
				srv, seen := tokenServer(t, filepath.Dir(f.pod.Remote))
				elsewhere, asked = srv.URL, func() int { return len(*seen) }
			} else {
				var mu sync.Mutex
				n := 0
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					mu.Lock()
					n++
					mu.Unlock()
					w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
					w.WriteHeader(http.StatusUnauthorized)
				}))
				t.Cleanup(srv.Close)
				elsewhere, asked = srv.URL, func() int { mu.Lock(); defer mu.Unlock(); return n }
			}
			binding := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, elsewhere+strings.TrimPrefix(r.URL.RequestURI(), "/redir"), http.StatusFound)
			}))
			t.Cleanup(binding.Close)
			if err := os.WriteFile(filepath.Join(f.runner.GitRoot, "push", "token"), []byte(token+"\n"), 0o400); err != nil {
				t.Fatal(err)
			}
			// httptest's TLS servers share one certificate, so one CA file trusts both origins.
			ca := filepath.Join(f.pod.Root, "ca.pem")
			cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: binding.Certificate().Raw})
			if err := os.WriteFile(ca, cert, 0o644); err != nil {
				t.Fatal(err)
			}
			f.runner.CAFile = ca
			f.runner.Scrubber = scrub.New(map[string]string{"git:push/token": token})

			req := f.request(false, nil)
			req.Push.URL = binding.URL + "/redir/" + filepath.Base(f.pod.Remote)
			out := f.runner.Run(t.Context(), req)
			if out.Outcome == wire.OutcomePushed {
				t.Fatalf("a push followed the redirect: %+v %+v", out, out.Push)
			}
			if n := asked(); n != 0 {
				t.Fatalf("the other origin was asked %d times", n)
			}
			if remoteRef(f) != before {
				t.Fatal("the remote moved")
			}
		})
	}
}

func TestATokenPushOverHTTPIsRefusedAndSendsNothing(t *testing.T) {
	f := newFixture(t, "")
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	var mu sync.Mutex
	seen := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		seen++
		mu.Unlock()
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)
	if err := os.WriteFile(filepath.Join(f.runner.GitRoot, "push", "token"), []byte(token+"\n"), 0o400); err != nil {
		t.Fatal(err)
	}
	req := f.request(false, nil)
	req.Push.URL = srv.URL + "/" + filepath.Base(f.pod.Remote)
	out := f.runner.Run(t.Context(), req)
	if out.Outcome != wire.OutcomeRejected || !strings.Contains(out.Reason, "https only") {
		t.Fatalf("got %+v", out)
	}
	mu.Lock()
	defer mu.Unlock()
	if seen != 0 {
		t.Fatalf("the http server was asked %d times", seen)
	}
}

func TestTheHelperAnswersOnlyTheBindingsHostOverHTTPS(t *testing.T) {
	file := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(file, []byte(token+"\n"), 0o400); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JR2_GIT_TOKEN_FILE", file)
	t.Setenv("JR2_GIT_TOKEN_HOST", "git.example.com:8443")
	for _, ask := range []string{
		"protocol=https\nhost=other.example.com:8443\n\n",
		"protocol=http\nhost=git.example.com:8443\n\n",
		"protocol=https\nhost=git.example.com\n\n",
		"host=git.example.com:8443\n\n",
	} {
		var out strings.Builder
		if code := Helper([]string{"get"}, strings.NewReader(ask), &out); code == 0 || out.Len() != 0 {
			t.Fatalf("%q: exit %d, %q", ask, code, out.String())
		}
	}
	var out strings.Builder
	if code := Helper([]string{"get"}, strings.NewReader("protocol=https\nhost=GIT.example.com:8443\n\n"), &out); code != 0 ||
		!strings.Contains(out.String(), "password="+token) {
		t.Fatalf("the Binding's host: %q", out.String())
	}
	t.Setenv("JR2_GIT_TOKEN_HOST", "")
	out.Reset()
	if code := Helper([]string{"get"}, strings.NewReader("protocol=https\nhost=git.example.com:8443\n\n"), &out); code == 0 {
		t.Fatal("answered with no host")
	}
}
