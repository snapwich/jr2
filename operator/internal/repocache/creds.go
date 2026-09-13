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
	"fmt"
	"os"
	"path/filepath"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

// The Secret a Repo's secretRef names uses Flux's key names (ADR-0051), so a
// Flux or Argo user reuses the Secret they have: `username`/`password` for
// https, `identity` (+ `identity.pub`, optionally `known_hosts`) for ssh. The
// Secret's keys say which shape it is; the Orchestrator that wrote the
// secretRef already picked the field by the url's scheme.
const (
	secretKeyUsername   = "username"
	secretKeyPassword   = "password"
	secretKeyIdentity   = "identity"
	secretKeyKnownHosts = "known_hosts"

	// envUsername and envPassword carry an https credential to the helper
	// below, so the token is never in argv or on disk.
	envUsername = "J2_GIT_USERNAME"
	envPassword = "J2_GIT_PASSWORD"
	// credentialHelper is the inline helper git runs to read those two.
	credentialHelper = `!f() { echo "username=$` + envUsername + `"; echo "password=$` + envPassword + `"; }; f`
)

// credentials resolves the Repo's secretRef into the environment every git
// child for that Repo gets. No secretRef → an anonymous clone. A secretRef
// naming an absent Secret is an error the caller reports without touching the
// network: the fix is the user's (ADR-0047), not a retry's.
func (a *Agent) credentials(ctx context.Context, repo *corev1alpha1.Repo) ([]string, error) {
	env := []string{"GIT_TERMINAL_PROMPT=0"}
	if repo.Spec.SecretRef == nil {
		return env, nil
	}
	name := repo.Spec.SecretRef.Name
	var secret corev1.Secret
	if err := a.Get(ctx, client.ObjectKey{Namespace: repo.Namespace, Name: name}, &secret); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, fmt.Errorf("secret %q not found — create it (ADR-0047) or fix git.credentials", name)
		}
		return nil, fmt.Errorf("read secret %q: %w", name, err)
	}
	if identity, ok := secret.Data[secretKeyIdentity]; ok {
		return a.sshEnv(env, repo.Name, identity, secret.Data[secretKeyKnownHosts])
	}
	if password, ok := secret.Data[secretKeyPassword]; ok {
		return append(env,
			envUsername+"="+string(secret.Data[secretKeyUsername]),
			envPassword+"="+string(password),
			"GIT_CONFIG_COUNT=1",
			"GIT_CONFIG_KEY_0=credential.helper",
			"GIT_CONFIG_VALUE_0="+credentialHelper,
		), nil
	}
	return nil, fmt.Errorf("secret %q carries neither %q (ssh) nor %q (https)", name, secretKeyIdentity, secretKeyPassword)
}

// sshEnv writes the deploy key under $HOME/.ssh (an emptyDir, mode 0600) and
// points ssh at it. A Secret that carries known_hosts pins the host strictly
// through its own file; without one the host key is accepted on first contact
// and remembered in the shared known_hosts for the agent's lifetime.
func (a *Agent) sshEnv(env []string, key string, identity, knownHosts []byte) ([]string, error) {
	sshDir := filepath.Join(a.Home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		return nil, fmt.Errorf("prepare %s: %w", sshDir, err)
	}
	identityFile := filepath.Join(sshDir, key)
	if len(identity) > 0 && identity[len(identity)-1] != '\n' {
		identity = append(identity, '\n')
	}
	if err := writePrivate(identityFile, identity); err != nil {
		return nil, err
	}
	knownHostsFile := filepath.Join(sshDir, "known_hosts")
	strict := "accept-new"
	if knownHosts != nil {
		knownHostsFile = filepath.Join(sshDir, key+".known_hosts")
		strict = "yes"
		if err := writePrivate(knownHostsFile, knownHosts); err != nil {
			return nil, err
		}
	}
	return append(env, "GIT_SSH_COMMAND="+fmt.Sprintf(
		"ssh -i %s -o IdentitiesOnly=yes -o UserKnownHostsFile=%s -o StrictHostKeyChecking=%s",
		identityFile, knownHostsFile, strict)), nil
}

// writePrivate writes a file readable by the agent alone, whether or not it
// already existed.
func writePrivate(path string, data []byte) error {
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("chmod %s: %w", path, err)
	}
	return nil
}
