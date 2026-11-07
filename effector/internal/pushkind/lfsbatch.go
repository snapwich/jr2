package pushkind

// The Effector asks the LFS server's batch API itself (ADR-0067), before and after git-lfs
// uploads, because git-lfs's exit code does not say that the server holds an object: an upload
// href or a verify that answers 422 makes `git-lfs push --object-id` exit 0. Before the upload,
// the answer tells which objects the server lacks: an object that the server holds already is not
// uploaded, and needs no local copy. After the upload, the same question confirms that the server
// holds each object that was uploaded. The question is an upload batch: an object that the answer
// gives no action holds on the server.
//
// The batch goes where git-lfs sends its own: the server that `.lfsconfig` names at the Binding's
// base, else the one that git-lfs derives from the push url. An https server gets the token only
// through the credential helper, after a 401, as git-lfs does: the helper answers only the push
// url's own origin. An ssh server gets the headers that `git-lfs-authenticate` gives, through the
// call's own ssh command.

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/snapwich/jr2/effector/internal/gitclean"
)

// lfsMediaType is the media type of the batch API.
const lfsMediaType = "application/vnd.git-lfs+json"

// lfsBatchSize is how many objects one batch request names, as git-lfs's default.
const lfsBatchSize = 100

// lfsAnswerMax bounds the bytes of one batch answer that are read.
const lfsAnswerMax = 16 << 20

// lfsAPI is the batch API of one LFS server: its url, and the headers that git-lfs-authenticate
// gave for it.
type lfsAPI struct {
	href   string
	header map[string]string
}

// lfsState is what a batch answer says of one object.
type lfsState struct {
	// held: the answer gives the object no action, so the server holds it.
	held bool
	// why is the server's refusal of the object, or "" when the answer gives an upload action.
	why string
}

// lfsAPIFor finds the batch API of the server, as git-lfs finds it: configured, which `.lfsconfig`
// names, else the push url. An http(s) server is its url; a url that git-lfs derives gets
// `.git/info/lfs`. An ssh server is the href that git-lfs-authenticate gives over the call's ssh
// command.
func (c *call) lfsAPIFor(ctx context.Context, configured string) (*lfsAPI, error) {
	raw := configured
	if raw == "" {
		raw = strings.TrimSpace(c.spec.URL)
	}
	scheme, _, ok := lfsURLParts(raw)
	if !ok {
		return nil, errors.New("the LFS server could not be found from the push url")
	}
	switch scheme {
	case gitclean.SchemeHTTPS, gitclean.SchemeHTTP:
		href := strings.TrimSuffix(raw, "/")
		if configured == "" {
			if !strings.HasSuffix(href, ".git") {
				href += ".git"
			}
			href += "/info/lfs"
		}
		return &lfsAPI{href: href}, nil
	case gitclean.SchemeSSH:
		return c.lfsAuthenticate(ctx, raw)
	}
	return nil, fmt.Errorf("the LFS server's scheme %q is not one jr2 uploads over", scheme)
}

// lfsAuthenticate runs `git-lfs-authenticate <path> upload` on the ssh server of raw, with the
// call's own ssh command (its key, its known hosts, batch mode), and reads the href and the
// headers that it answers.
func (c *call) lfsAuthenticate(ctx context.Context, raw string) (*lfsAPI, error) {
	if c.sshCommand == "" {
		return nil, errors.New("the LFS server is ssh, and the push has no ssh credential")
	}
	var dest, port, path string
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err != nil {
			return nil, errors.New("the LFS server's ssh url could not be read")
		}
		dest, port, path = u.Hostname(), u.Port(), u.Path
		if u.User != nil && u.User.Username() != "" {
			dest = u.User.Username() + "@" + dest
		}
	} else {
		dest, path, _ = strings.Cut(raw, ":")
	}
	// git-lfs sends the path to the remote shell unquoted; a path of other characters is refused,
	// so the remote shell reads it as one word.
	if strings.HasPrefix(dest, "-") || !sshPath.MatchString(path) || (port != "" && !isDigits(port)) {
		return nil, errors.New("the LFS server's ssh url is not one jr2 runs ssh to")
	}
	args := []string{}
	if port != "" {
		args = append(args, "-p", port)
	}
	args = append(args, dest, "git-lfs-authenticate", path, "upload")
	// git runs core.sshCommand through the shell; so does this call, with the args after it.
	out, err := gitclean.Exec(ctx, c.repo, nil, append([]string{"sh", "-c", c.sshCommand + ` "$@"`, "ssh"},
		args...)...)
	if err != nil {
		reason, _ := c.failure(stderrOf(err), ctx)
		return nil, errors.New("git-lfs-authenticate on the LFS server failed: " + reason)
	}
	var answer struct {
		Href   string            `json:"href"`
		Header map[string]string `json:"header"`
	}
	if err := json.Unmarshal(out, &answer); err != nil || answer.Href == "" {
		return nil, errors.New("git-lfs-authenticate on the LFS server gave no href")
	}
	if s, _, ok := lfsURLParts(answer.Href); !ok || (s != gitclean.SchemeHTTPS && s != gitclean.SchemeHTTP) {
		return nil, errors.New("git-lfs-authenticate on the LFS server gave an href that is not http(s)")
	}
	return &lfsAPI{href: strings.TrimSuffix(answer.Href, "/"), header: answer.Header}, nil
}

func isDigits(s string) bool {
	return s != "" && strings.Trim(s, "0123456789") == ""
}

// sshPath is a repository path that the remote shell reads as one word.
var sshPath = regexp.MustCompile(`^[A-Za-z0-9._~/@+][A-Za-z0-9._~/@+-]*$`)

// lfsStates asks the server about each object, in batches, and answers what the answer says of
// each oid. An object that an answer leaves out has no entry.
func (c *call) lfsStates(ctx context.Context, api *lfsAPI, objects []lfsObject) (map[string]lfsState, error) {
	client := c.lfsClient()
	states := map[string]lfsState{}
	auth := ""
	for chunk := range slices.Chunk(objects, lfsBatchSize) {
		answer, err := c.lfsBatch(ctx, client, api, chunk, &auth)
		if err != nil {
			return nil, err
		}
		maps.Copy(states, answer)
	}
	return states, nil
}

// lfsClient is the batch's HTTP client: the instance's CA beside the system's, as git-lfs adds
// http.sslCAInfo, no proxy (git-lfs gets the call's cleared env), and no redirect, so that the
// token never goes to another origin.
func (c *call) lfsClient() *http.Client {
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	if c.r.CAFile != "" {
		if pem, err := os.ReadFile(c.r.CAFile); err == nil {
			pool.AppendCertsFromPEM(pem)
		}
	}
	transport := &http.Transport{
		Proxy:               nil,
		DialContext:         (&net.Dialer{Timeout: 30 * time.Second}).DialContext,
		TLSClientConfig:     &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout: 30 * time.Second,
	}
	return &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

// lfsBatch sends one upload batch request. A 401 asks the credential helper for the batch url,
// once, and sends again with the pair it gives: auth keeps it for the next batch.
func (c *call) lfsBatch(ctx context.Context, client *http.Client, api *lfsAPI, objects []lfsObject,
	auth *string) (map[string]lfsState, error) {
	type object struct {
		Oid  string `json:"oid"`
		Size int64  `json:"size"`
	}
	body := struct {
		Operation string   `json:"operation"`
		Transfers []string `json:"transfers"`
		Objects   []object `json:"objects"`
		HashAlgo  string   `json:"hash_algo"`
	}{Operation: "upload", Transfers: []string{"basic"}, HashAlgo: "sha256"}
	for _, o := range objects {
		body.Objects = append(body.Objects, object{Oid: o.oid, Size: o.size})
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	target := api.href + "/objects/batch"
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(raw))
		if err != nil {
			return nil, errors.New("the LFS server's batch url could not be read")
		}
		req.Header.Set("Accept", lfsMediaType)
		req.Header.Set("Content-Type", lfsMediaType)
		for k, v := range api.header {
			req.Header.Set(k, v)
		}
		if *auth != "" {
			req.Header.Set("Authorization", *auth)
		}
		res, err := client.Do(req)
		if err != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, errors.New("the LFS server's batch answer did not come: the timeout passed")
			}
			return nil, errors.New("the LFS server's batch request failed: " + withoutQueries(err.Error()))
		}
		answer, readErr := io.ReadAll(io.LimitReader(res.Body, lfsAnswerMax))
		_ = res.Body.Close()
		if res.StatusCode == http.StatusUnauthorized && attempt == 0 && *auth == "" {
			if *auth = c.lfsCredential(ctx, target); *auth != "" {
				continue
			}
		}
		if res.StatusCode != http.StatusOK {
			why := fmt.Sprintf("the LFS server answered the batch request %d", res.StatusCode)
			if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
				why += ": the server refused the credential"
			}
			if m := lfsMessage(answer); m != "" {
				why += " (" + m + ")"
			}
			return nil, errors.New(why)
		}
		if readErr != nil {
			return nil, errors.New("the LFS server's batch answer could not be read: " + readErr.Error())
		}
		return lfsParse(answer)
	}
}

// lfsCredential asks the call's credential helper for url through `git credential fill`, as
// git-lfs does after a 401: the helper answers only the push url's own origin (ADR-0051), so any
// other url gets "". It answers a Basic Authorization, or "".
func (c *call) lfsCredential(ctx context.Context, target string) string {
	out, err := c.repo.Git(ctx, strings.NewReader("url="+target+"\n\n"), "credential", "fill")
	if err != nil {
		return ""
	}
	attrs := map[string]string{}
	for line := range strings.SplitSeq(string(out), "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			attrs[k] = v
		}
	}
	if attrs["password"] == "" {
		return ""
	}
	pair := attrs["username"] + ":" + attrs["password"]
	encoded := base64.StdEncoding.EncodeToString([]byte(pair))
	c.built["git:push/basic"] = encoded
	return "Basic " + encoded
}

// lfsParse reads a batch answer: per oid, held (no action), an upload to do, or the server's
// error for that object.
func lfsParse(raw []byte) (map[string]lfsState, error) {
	var answer struct {
		Objects []struct {
			Oid     string                     `json:"oid"`
			Actions map[string]json.RawMessage `json:"actions"`
			Error   *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		} `json:"objects"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil {
		return nil, errors.New("the LFS server's batch answer is not the batch API's JSON")
	}
	states := map[string]lfsState{}
	for _, o := range answer.Objects {
		switch {
		case o.Error != nil:
			why := fmt.Sprintf("the server answered %d", o.Error.Code)
			if m := oneLine(o.Error.Message); m != "" {
				why += " (" + m + ")"
			}
			states[o.Oid] = lfsState{why: why}
		case o.Actions["upload"] != nil:
			states[o.Oid] = lfsState{}
		default:
			states[o.Oid] = lfsState{held: true}
		}
	}
	return states, nil
}

// lfsMessage is the `message` of an error answer, on one line.
func lfsMessage(raw []byte) string {
	var answer struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &answer) != nil {
		return ""
	}
	return oneLine(answer.Message)
}

// oneLine is s on one line, at most 200 bytes, with no query of a url.
func oneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return withoutQueries(s)
}
