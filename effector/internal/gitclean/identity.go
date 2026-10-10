package gitclean

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

// The Repo identity of ADR-0051, as `@jr2/orchestrator`'s repo-identity.ts derives it: host plus
// path, scheme and user dropped, the host lower-cased, a default port dropped, one trailing
// `.git` off. The Effector reads it to fence a push: the url must fall under the `git.credentials`
// entry whose credential it spends.

var scpStyle = regexp.MustCompile(`^(?:[^@/:]+@)?([^:/@]+):(.+)$`)

// The schemes a url is reached by.
const (
	SchemeSSH   = "ssh"
	SchemeHTTPS = "https"
	SchemeHTTP  = "http"
	SchemeLocal = "local"
)

var defaultPort = map[string]string{SchemeSSH: "22", SchemeHTTPS: "443", SchemeHTTP: "80", "git": "9418"}

// Scheme names how a url is reached: https, http, ssh, git, or local.
func Scheme(raw string) string {
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "://") {
		if scpStyle.MatchString(raw) {
			return SchemeSSH
		}
		return SchemeLocal
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	switch u.Scheme {
	case "git+ssh", SchemeSSH:
		return SchemeSSH
	case "file":
		return SchemeLocal
	}
	return u.Scheme
}

// Identity is a url's Repo identity.
func Identity(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.HasPrefix(raw, "-") {
		return "", errors.New("the url is empty or begins with -")
	}
	if !strings.Contains(raw, "://") {
		if m := scpStyle.FindStringSubmatch(raw); m != nil && !strings.HasPrefix(m[2], "//") {
			return remoteIdentity(strings.ToLower(m[1]), m[2])
		}
		if !strings.HasPrefix(raw, "/") {
			return "", errors.New("the url is not absolute or remote")
		}
		return "/" + normalize(raw), nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if u.Scheme == "file" {
		return "/" + normalize(u.Path), nil
	}
	scheme := Scheme(raw)
	if _, ok := defaultPort[scheme]; !ok {
		return "", errors.New("the url's scheme is not one git pushes over")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", errors.New("the url has no host")
	}
	if p := u.Port(); p != "" && p != defaultPort[scheme] {
		host += ":" + p
	}
	return remoteIdentity(host, u.Path)
}

func remoteIdentity(host, path string) (string, error) {
	n := normalize(path)
	if n == "" {
		return "", errors.New("the url has no path")
	}
	return host + "/" + n, nil
}

func normalize(path string) string {
	var segs []string
	for s := range strings.SplitSeq(path, "/") {
		switch s {
		case "", ".":
		case "..":
			if len(segs) > 0 {
				segs = segs[:len(segs)-1]
			}
		default:
			segs = append(segs, s)
		}
	}
	if n := len(segs); n > 0 {
		last := segs[n-1]
		segs = segs[:n-1]
		if last != ".git" {
			segs = append(segs, strings.TrimSuffix(last, ".git"))
		}
	}
	return strings.Join(segs, "/")
}

// Matches says whether a url falls under a `git.credentials` entry's match: `*`, or a prefix of
// its identity.
func Matches(rawURL, match string) bool {
	if match == "*" {
		return true
	}
	id, err := Identity(rawURL)
	return err == nil && strings.HasPrefix(id, match)
}
