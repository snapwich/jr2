package secrets

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/snapwich/jr2/effector/internal/gitclean"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// The files of one entry's directory under the git mount: the entry's own Secret,
// `jr2-git-push-<hash>`, which `jr2 up` writes and the operator projects at `@git/<its name>/`
// (ADR-0051, ADR-0068). Flux's key names where Flux has them: an ssh push key is `identity` and
// `known_hosts`, a token is `password` (beside `username`). The signing key, which Flux does not
// name, is `sign.identity` (ssh) or `sign.private.asc` (GPG). `entry.json` says what the entry is.
const (
	EntryFile      = "entry.json"
	PushKeyFile    = "identity"
	KnownHostsFile = "known_hosts"
	TokenFile      = "password"
	SignSSHFile    = "sign.identity"
	SignGPGFile    = "sign.private.asc"
)

// GitAuth is a push credential (ADR-0051's `git.credentials` entry, its `push` field or the clone
// credentials): the directory, under the git mount, that holds an ssh key (`identity`,
// `known_hosts`), a token (`password`), or both — an entry with no `push` field pushes with its
// clone credentials, each over its own scheme. At least one is set.
type GitAuth struct {
	SSHKey string `json:"sshKey,omitempty"`
	Token  string `json:"token,omitempty"`
}

// GitSign is a signing key and the committer it signs as: the directory that holds an ssh key
// (`sign.identity`) or a GPG key (`sign.private.asc`). Exactly one key is set.
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
	// Order is the entry's place in the list: a tie on the match's length goes to the first.
	Order int `json:"-"`
}

// entryFile is `entry.json`: what one entry is, never a value.
type entryFile struct {
	Match string `json:"match"`
	Order int    `json:"order"`
	// Push is what the entry pushes with: "ssh", "token", or both.
	Push []string `json:"push"`
	Sign *struct {
		Format string `json:"format"`
		Name   string `json:"name"`
		Email  string `json:"email"`
	} `json:"sign,omitempty"`
}

// ReadGitEntries reads every entry the git mount holds: one directory each, the Secret the
// Orchestrator named on the Sandbox for a url its pushes spend, its `entry.json` saying what it is.
// No mount, no entry: the Workspace pushes nothing.
func ReadGitEntries(dir string) ([]GitEntry, error) {
	dirs, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []GitEntry
	for _, d := range dirs {
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		f, err := os.Open(filepath.Join(dir, name, EntryFile))
		if err != nil {
			return nil, fmt.Errorf("git credential %s: %w", name, err)
		}
		var e entryFile
		err = wire.Decode(f, &e)
		_ = f.Close()
		if err != nil {
			return nil, fmt.Errorf("git credential %s: %s: %w", name, EntryFile, err)
		}
		entry := GitEntry{Match: e.Match, Order: e.Order, Push: &GitAuth{}}
		for _, kind := range e.Push {
			switch kind {
			case "ssh":
				entry.Push.SSHKey = name
			case "token":
				entry.Push.Token = name
			default:
				return nil, fmt.Errorf("git credential %s: push %q is not ssh or token", name, kind)
			}
		}
		if s := e.Sign; s != nil {
			entry.Sign = &GitSign{Name: s.Name, Email: s.Email}
			switch s.Format {
			case "ssh":
				entry.Sign.SSHKey = name
			case "gpg":
				entry.Sign.GPGKey = name
			default:
				return nil, fmt.Errorf("git credential %s: sign format %q is not ssh or gpg", name, s.Format)
			}
		}
		if err := entry.validate(len(out)); err != nil {
			return nil, fmt.Errorf("git credential %s: %w", name, err)
		}
		out = append(out, entry)
	}
	slices.SortFunc(out, func(a, b GitEntry) int { return a.Order - b.Order })
	return out, nil
}

func (e *GitEntry) validate(i int) error {
	if e.Match == "" {
		return fmt.Errorf("git[%d] has no match", i)
	}
	if e.Push != nil && e.Push.SSHKey == "" && e.Push.Token == "" {
		return fmt.Errorf("git[%d].push names neither sshKey nor token", i)
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
// key, a token. `identity.pub`, `known_hosts`, `username` and `entry.json` are public.
var secretFiles = []string{PushKeyFile, TokenFile, SignSSHFile, SignGPGFile}

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
