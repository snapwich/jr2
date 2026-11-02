/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package repocache

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

func secret(name string, data map[string]string) *corev1.Secret {
	bytes := make(map[string][]byte, len(data))
	for k, v := range data {
		bytes[k] = []byte(v)
	}
	return &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}, Data: bytes}
}

func withSecret(name string) *corev1alpha1.Repo {
	r := repo(1)
	r.Spec.SecretRef = &corev1.LocalObjectReference{Name: name}
	return r
}

func envValue(env []string, name string) (string, bool) {
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, name+"="); ok {
			return v, true
		}
	}
	return "", false
}

func TestNoSecretRefIsAnAnonymousClone(t *testing.T) {
	a := newAgent(t, &fakeGit{})
	env, err := a.credentials(context.Background(), repo(1))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(env, []string{"GIT_TERMINAL_PROMPT=0"}) {
		t.Fatalf("expected only the no-prompt guard, got %v", env)
	}
}

func TestHttpsTokenRidesTheEnvironmentThroughACredentialHelper(t *testing.T) {
	// ADR-0051: Flux's key names; the value is never in argv or on disk.
	a := newAgent(t, &fakeGit{}, secret("jr2-git-abcd1234", map[string]string{"username": "x-access-token", "password": "ghp_secret"}))
	env, err := a.credentials(context.Background(), withSecret("jr2-git-abcd1234"))
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"GIT_TERMINAL_PROMPT": "0",
		"JR2_GIT_USERNAME":    "x-access-token",
		"JR2_GIT_PASSWORD":    "ghp_secret",
		"GIT_CONFIG_COUNT":    "2",
		"GIT_CONFIG_KEY_0":    "credential." + origin(t, repoURL) + ".helper",
		"GIT_CONFIG_VALUE_0":  `!f() { echo "username=$JR2_GIT_USERNAME"; echo "password=$JR2_GIT_PASSWORD"; }; f`,
		"GIT_CONFIG_KEY_1":    "http.followRedirects",
		"GIT_CONFIG_VALUE_1":  "false",
	} {
		if got, ok := envValue(env, name); !ok || got != want {
			t.Errorf("%s: want %q, got %q (present %v)", name, want, got, ok)
		}
	}
	if _, ok := envValue(env, "GIT_SSH_COMMAND"); ok {
		t.Fatal("an https credential sets no ssh command")
	}
	if entries, _ := os.ReadDir(a.Home); len(entries) != 0 {
		t.Fatalf("an https credential writes nothing under HOME, got %v", entries)
	}
}

func TestSshKeyIsWrittenPrivateAndAcceptsNewHostsWithoutKnownHosts(t *testing.T) {
	a := newAgent(t, &fakeGit{}, secret("jr2-git-ssh", map[string]string{secretKeyIdentity: "-----BEGIN KEY-----\nabc\n-----END KEY-----", "identity.pub": "ssh-ed25519 AAAA"}))
	env, err := a.credentials(context.Background(), withSecret("jr2-git-ssh"))
	if err != nil {
		t.Fatal(err)
	}
	identityFile := filepath.Join(a.Home, ".ssh", key)
	info, err := os.Stat(identityFile)
	if err != nil {
		t.Fatalf("the deploy key must be written under $HOME/.ssh/<key>: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("the deploy key must be 0600, got %o", info.Mode().Perm())
	}
	body, _ := os.ReadFile(identityFile)
	if !strings.HasSuffix(string(body), "-----END KEY-----\n") {
		t.Fatalf("the key file must end in a newline for ssh to read it, got %q", body)
	}
	cmd, ok := envValue(env, "GIT_SSH_COMMAND")
	if !ok {
		t.Fatalf("expected GIT_SSH_COMMAND, got %v", env)
	}
	want := "ssh -i " + identityFile + " -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile=" + filepath.Join(a.Home, ".ssh", "known_hosts") + " -o StrictHostKeyChecking=accept-new"
	if cmd != want {
		t.Fatalf("want %q\n got %q", want, cmd)
	}
	if _, ok := envValue(env, "JR2_GIT_PASSWORD"); ok {
		t.Fatal("an ssh credential sets no token")
	}
}

func TestSshKnownHostsPinsTheHostStrictly(t *testing.T) {
	a := newAgent(t, &fakeGit{}, secret("jr2-git-ssh", map[string]string{secretKeyIdentity: "k\n", secretKeyKnownHosts: "github.com ssh-ed25519 AAAA\n"}))
	env, err := a.credentials(context.Background(), withSecret("jr2-git-ssh"))
	if err != nil {
		t.Fatal(err)
	}
	knownHosts := filepath.Join(a.Home, ".ssh", key+".known_hosts")
	body, err := os.ReadFile(knownHosts)
	if err != nil || string(body) != "github.com ssh-ed25519 AAAA\n" {
		t.Fatalf("the Secret's known_hosts must be written for this Repo: %v %q", err, body)
	}
	cmd, _ := envValue(env, "GIT_SSH_COMMAND")
	if !strings.HasSuffix(cmd, "-o UserKnownHostsFile="+knownHosts+" -o StrictHostKeyChecking=yes") {
		t.Fatalf("a known_hosts in the Secret means strict checking against it, got %q", cmd)
	}
}

func TestSshKeyIsRewrittenPrivateWhenTheFileExists(t *testing.T) {
	a := newAgent(t, &fakeGit{}, secret("jr2-git-ssh", map[string]string{secretKeyIdentity: "k\n"}))
	sshDir := filepath.Join(a.Home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sshDir, key), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := a.credentials(context.Background(), withSecret("jr2-git-ssh")); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(filepath.Join(sshDir, key))
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("a rewritten key must be 0600, got %o", info.Mode().Perm())
	}
}

func TestAMissingSecretIsTheUsersToFix(t *testing.T) {
	a := newAgent(t, &fakeGit{})
	_, err := a.credentials(context.Background(), withSecret("jr2-git-ssh"))
	if err == nil || err.Error() != `secret "jr2-git-ssh" not found — create it (ADR-0047) or fix git.credentials` {
		t.Fatalf("expected the ADR-0047 hint, got %v", err)
	}
}

func TestASecretWithNeitherShapeIsRefused(t *testing.T) {
	a := newAgent(t, &fakeGit{}, secret("odd", map[string]string{"token": "x"}))
	_, err := a.credentials(context.Background(), withSecret("odd"))
	if err == nil || !strings.Contains(err.Error(), `carries neither "identity" (ssh) nor "password" (https)`) {
		t.Fatalf("expected a refusal naming the two shapes, got %v", err)
	}
}

func origin(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Scheme + "://" + u.Host
}

// ADR-0051: the cluster's https clone token never leaves the Repo's own origin. The Repo's host
// answers the clone (here `git ls-remote`, as the probe runs it) with a redirect to another host;
// git follows no redirect, and the helper answers for the Repo's origin alone, so the other host
// never gets the token.
func TestAnHttpsCredentialFollowsNoRedirectToAnotherHost(t *testing.T) {
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Fatalf("this test runs git: %v", err)
	}
	got := make(chan string, 8)
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "" {
			got <- auth
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("WWW-Authenticate", `Basic realm="x"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer other.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+r.URL.RequestURI(), http.StatusFound)
	}))
	defer origin.Close()

	a := newAgent(t, &fakeGit{}, secret("jr2-git-abcd1234", map[string]string{"username": "x-access-token",
		"password": "CLUSTER-TOKEN-123"}))
	r := withSecret("jr2-git-abcd1234")
	r.Spec.URL = origin.URL + "/org/repo.git"
	env, err := a.credentials(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(gitBin, "ls-remote", "--", r.Spec.URL)
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH"), "HOME=" + t.TempDir(), "GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null"}, env...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("the clone through a redirect succeeded: %s", out)
	}
	select {
	case auth := <-got:
		t.Fatalf("the other host got a credential: %s (git: %s)", auth, out)
	default:
	}
}

// An https credential on a url that is not http(s) has no origin to scope its helper to: refused.
func TestAnHttpsCredentialOnAnUrlThatIsNotHttpsIsRefused(t *testing.T) {
	a := newAgent(t, &fakeGit{}, secret("tok", map[string]string{"username": "u", "password": "p"}))
	r := withSecret("tok")
	r.Spec.URL = "git@github.com:org/repo.git"
	if _, err := a.credentials(context.Background(), r); err == nil || !strings.Contains(err.Error(), "not an http(s) url") {
		t.Fatalf("got %v", err)
	}
}
