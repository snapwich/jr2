/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package repocache

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
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
	a := newAgent(t, &fakeGit{}, secret("j2-git-abcd1234", map[string]string{"username": "x-access-token", "password": "ghp_secret"}))
	env, err := a.credentials(context.Background(), withSecret("j2-git-abcd1234"))
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"GIT_TERMINAL_PROMPT": "0",
		"J2_GIT_USERNAME":     "x-access-token",
		"J2_GIT_PASSWORD":     "ghp_secret",
		"GIT_CONFIG_COUNT":    "1",
		"GIT_CONFIG_KEY_0":    "credential.helper",
		"GIT_CONFIG_VALUE_0":  `!f() { echo "username=$J2_GIT_USERNAME"; echo "password=$J2_GIT_PASSWORD"; }; f`,
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
	a := newAgent(t, &fakeGit{}, secret("j2-git-ssh", map[string]string{secretKeyIdentity: "-----BEGIN KEY-----\nabc\n-----END KEY-----", "identity.pub": "ssh-ed25519 AAAA"}))
	env, err := a.credentials(context.Background(), withSecret("j2-git-ssh"))
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
	want := "ssh -i " + identityFile + " -o IdentitiesOnly=yes -o UserKnownHostsFile=" + filepath.Join(a.Home, ".ssh", "known_hosts") + " -o StrictHostKeyChecking=accept-new"
	if cmd != want {
		t.Fatalf("want %q\n got %q", want, cmd)
	}
	if _, ok := envValue(env, "J2_GIT_PASSWORD"); ok {
		t.Fatal("an ssh credential sets no token")
	}
}

func TestSshKnownHostsPinsTheHostStrictly(t *testing.T) {
	a := newAgent(t, &fakeGit{}, secret("j2-git-ssh", map[string]string{secretKeyIdentity: "k\n", secretKeyKnownHosts: "github.com ssh-ed25519 AAAA\n"}))
	env, err := a.credentials(context.Background(), withSecret("j2-git-ssh"))
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
	a := newAgent(t, &fakeGit{}, secret("j2-git-ssh", map[string]string{secretKeyIdentity: "k\n"}))
	sshDir := filepath.Join(a.Home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sshDir, key), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := a.credentials(context.Background(), withSecret("j2-git-ssh")); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(filepath.Join(sshDir, key))
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("a rewritten key must be 0600, got %o", info.Mode().Perm())
	}
}

func TestAMissingSecretIsTheUsersToFix(t *testing.T) {
	a := newAgent(t, &fakeGit{})
	_, err := a.credentials(context.Background(), withSecret("j2-git-ssh"))
	if err == nil || err.Error() != `secret "j2-git-ssh" not found — create it (ADR-0047) or fix git.credentials` {
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
