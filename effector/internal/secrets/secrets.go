// Package secrets reads what one Effector holds (ADR-0068): every Effect secret as a file in its
// own mount, `/run/jr2/secrets/<name>`, and the placement's config `jr2 up` wrote — which
// hosts its Effects may call, and with which secrets. Read once, at start: a change rolls
// the pod (the digest on its template), as a Custodian's values do (ADR-0059).
package secrets

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// Read loads every secret under dir, by file name. A name that starts with "." is the kubelet's
// own (`..data`) and is skipped. One trailing "\n" or "\r\n" is taken off, as the Custodian does.
// An empty value, or one shorter than scrub.MinLength, stops the start with a line that names it
// (ADR-0068): `jr2 up` refuses a short one before the converge, a literal and a value in the
// user's own Secret alike, and this refusal is for a Secret edited after it. Read once, at start:
// when a value changed, the next `jr2 up` rolls the pod.
func Read(dir string) (map[string]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			return nil, fmt.Errorf("secret %s: %w", name, err)
		}
		// A directory is no secret: the push credentials sit in one (`@git`, a name no secret can
		// take), and the kubelet's own are skipped above.
		if info.IsDir() {
			continue
		}
		if !wire.ValidSecretName(name) {
			return nil, fmt.Errorf("secret file %q is not a secret name", name)
		}
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, fmt.Errorf("secret %s: %w", name, err)
		}
		value := strings.TrimSuffix(strings.TrimSuffix(string(raw), "\n"), "\r")
		if value == "" {
			return nil, fmt.Errorf("secret %s is empty", name)
		}
		if len(value) < scrub.MinLength {
			return nil, fmt.Errorf(
				"secret %s is shorter than %d characters: the scrubber would replace every match of it in "+
					"ordinary text, so the Effector refuses it (ADR-0068)", name, scrub.MinLength)
		}
		out[name] = value
	}
	return out, nil
}

// Target is one place an Effect placed here may call, and the secrets it may carry there.
type Target struct {
	Scheme  string   `json:"scheme"`
	Host    string   `json:"host"`
	Port    int      `json:"port"`
	Secrets []string `json:"secrets"`
}

// Config is `effector.json`, which `jr2 up` writes from the Effects' plain-data parts.
type Config struct {
	Version   int      `json:"version"`
	Placement string   `json:"placement"`
	Targets   []Target `json:"targets"`
	// Git is the `git.credentials` entries the pushes placed here spend (a Sandbox Effector's).
	Git []GitEntry `json:"git,omitempty"`
}

// ReadConfig loads and checks the config file.
func ReadConfig(path string) (*Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	var c Config
	if err := wire.Decode(f, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if c.Version != 1 {
		return nil, fmt.Errorf("%s: version %d is not 1", path, c.Version)
	}
	if c.Placement == "" {
		return nil, fmt.Errorf("%s: no placement", path)
	}
	for i, t := range c.Targets {
		if (t.Scheme != "https" && t.Scheme != "http") || t.Host == "" || t.Port < 1 || t.Port > 65535 {
			return nil, fmt.Errorf("%s: targets[%d] is not { scheme: http|https, host, port }", path, i)
		}
	}
	for i := range c.Git {
		if err := c.Git[i].validate(i); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	}
	return &c, nil
}

// Allows says whether an Effect may call scheme://host:port carrying names.
func (c *Config) Allows(scheme, host string, port int, names []string) bool {
	for _, t := range c.Targets {
		if t.Scheme != scheme || !strings.EqualFold(t.Host, host) || t.Port != port {
			continue
		}
		if every(names, t.Secrets) {
			return true
		}
	}
	return false
}

func every(names, in []string) bool {
	for _, n := range names {
		if !slices.Contains(in, n) {
			return false
		}
	}
	return true
}
