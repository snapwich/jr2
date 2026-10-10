package secrets

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/snapwich/jr2/effector/internal/gitclean"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// GitAuth is a push credential (ADR-0051's `git.credentials` entry, its `push` field or the clone
// credential): an ssh key's directory (`identity`, `known_hosts`) or a token's, under the git
// mount. Exactly one is set.
type GitAuth struct {
	SSHKey string `json:"sshKey,omitempty"`
	Token  string `json:"token,omitempty"`
}

// GitSign is a signing key and the committer it signs as: an ssh key's directory (`identity`) or
// a GPG key's (`private.asc`). Exactly one key is set.
type GitSign struct {
	SSHKey string `json:"sshKey,omitempty"`
	GPGKey string `json:"gpgKey,omitempty"`
	Name   string `json:"name"`
	Email  string `json:"email"`
}

// GitEntry is one `git.credentials` entry a push placed here spends.
type GitEntry struct {
	Match string   `json:"match"`
	Push  *GitAuth `json:"push,omitempty"`
	Sign  *GitSign `json:"sign,omitempty"`
}

func (e *GitEntry) validate(i int) error {
	if e.Match == "" {
		return fmt.Errorf("git[%d] has no match", i)
	}
	if e.Push != nil && (e.Push.SSHKey == "") == (e.Push.Token == "") {
		return fmt.Errorf("git[%d].push is not exactly one of sshKey, token", i)
	}
	if s := e.Sign; s != nil {
		if (s.SSHKey == "") == (s.GPGKey == "") {
			return fmt.Errorf("git[%d].sign is not exactly one of sshKey, gpgKey", i)
		}
		if s.Name == "" || s.Email == "" || strings.ContainsAny(s.Name+s.Email, "<>\n") {
			return fmt.Errorf("git[%d].sign needs a committer name and email", i)
		}
	}
	for _, d := range []string{e.dirs()[0], e.dirs()[1]} {
		if d != "" && !wire.ValidSecretName(d) {
			return fmt.Errorf("git[%d] names %q, which is no directory name", i, d)
		}
	}
	return nil
}

func (e *GitEntry) dirs() [2]string {
	var out [2]string
	if e.Push != nil {
		out[0] = e.Push.SSHKey + e.Push.Token
	}
	if e.Sign != nil {
		out[1] = e.Sign.SSHKey + e.Sign.GPGKey
	}
	return out
}

// Entry is the git entry whose match is match.
func (c *Config) Entry(match string) *GitEntry {
	for i := range c.Git {
		if c.Git[i].Match == match {
			return &c.Git[i]
		}
	}
	return nil
}

// EntryFor is the entry a push spends: the one match names, or — match empty — the entry whose
// match the url falls under, the longest winning and a tie going to the first (ADR-0051).
func (c *Config) EntryFor(match, url string) *GitEntry {
	if match != "" {
		return c.Entry(match)
	}
	best, length := -1, -1
	for i := range c.Git {
		m := c.Git[i].Match
		if !gitclean.Matches(url, m) {
			continue
		}
		n := len(m)
		if m == "*" {
			n = 0
		}
		if n > length {
			best, length = i, n
		}
	}
	if best < 0 {
		return nil
	}
	return &c.Git[best]
}

// secretFiles are the files of a git credential's directory whose content is secret: a private
// key, a token. `identity.pub` and `known_hosts` are public.
var secretFiles = []string{"identity", "token", "private.asc"}

// ReadGit reads the content of every secret file under the git mount, by `git:<dir>/<file>`, for
// the scrubber: an Effector returns no secret it holds, a key or a token included (ADR-0068).
func ReadGit(dir string) (map[string]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		for _, f := range secretFiles {
			raw, err := os.ReadFile(filepath.Join(dir, e.Name(), f))
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return nil, err
			}
			if v := strings.TrimSpace(string(raw)); v != "" {
				out["git:"+e.Name()+"/"+f] = v
			}
		}
	}
	return out, nil
}
