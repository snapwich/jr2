package pushkind

// The Effector asks the LFS server's batch API itself (ADR-0067), before and after git-lfs
// uploads, because git-lfs's exit code does not say that the server holds an object: an upload
// href or a verify that answers 422 makes `git-lfs push --object-id` exit 0. Before the upload,
// the answer tells which objects the server holds already: those are not uploaded, and need no
// local copy. After the upload, the same question confirms that the server holds each object
// that was uploaded. The question is a DOWNLOAD batch: the server holds an object when the answer
// gives it a download action and no error, which the batch API requires of a server. An upload
// batch would not do: that a server gives no upload action for an object it holds is only a
// SHOULD, and a server that always gives one would make every good push `rejected`.
//
// The batch goes where git-lfs sends its own: the server that `.lfsconfig` names at the Binding's
// base, else the one that git-lfs derives from the push url. An https server gets the token only
// through the credential helper, after a 401, as git-lfs does: the helper answers only the push
// url's own origin. An ssh server is asked as git-lfs asks it (lfs.sshtransfer=negotiate): over
// the pure SSH protocol (`git-lfs-transfer`, lfsssh.go) first, and through the headers that
// `git-lfs-authenticate` gives when the server does not speak it. Both go through the call's own
// ssh command.

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
	// authenticated: git-lfs-authenticate gave href and header, so the push is ssh and holds no
	// token, and a refusal is of that header.
	authenticated bool
}

// lfsState is what a download batch answer says of one object.
type lfsState struct {
	// held: the answer gives the object a download action and no error, so the server holds it.
	held bool
	// why is the server's error for the object, or "".
	why string
}

// lfsHeld asks the LFS server which of objects it holds: per oid, what a download batch answer
// says of it. An object that an answer leaves out has no entry. The server is endpoint, which
// `.lfsconfig` names, else the push url's, as git-lfs finds it: an http(s) server is its url, and
// a url that git-lfs derives gets `.git/info/lfs`. Each call opens its own session, so a header
// of git-lfs-authenticate that expires during a long upload is not used again.
func (c *call) lfsHeld(ctx context.Context, endpoint string, objects []lfsObject) (map[string]lfsState, error) {
	raw := endpoint
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
		if endpoint == "" {
			if !strings.HasSuffix(href, ".git") {
				href += ".git"
			}
			href += "/info/lfs"
		}
		return c.lfsStates(ctx, &lfsAPI{href: href}, objects)
	case gitclean.SchemeSSH:
		return c.lfsHeldSSH(ctx, raw, objects)
	}
	return nil, fmt.Errorf("the LFS server's scheme %q is not one jr2 uploads over", scheme)
}

// lfsHeldSSH asks an ssh LFS server as git-lfs negotiates (lfs.sshtransfer=negotiate): over
// `git-lfs-transfer` when the server speaks it, else over https with the headers that
// `git-lfs-authenticate` gives.
func (c *call) lfsHeldSSH(ctx context.Context, raw string, objects []lfsObject) (map[string]lfsState, error) {
	if c.sshCommand == "" {
		return nil, errors.New("the LFS server is ssh, and the push has no ssh credential")
	}
	target, err := parseSSHTarget(raw)
	if err != nil {
		return nil, err
	}
	session, transferErr := c.openTransfer(ctx, target, "download")
	if transferErr == nil {
		defer session.close()
		states := map[string]lfsState{}
		for chunk := range slices.Chunk(objects, lfsBatchSize) {
			answer, err := session.batch(chunk)
			if err != nil && ctx.Err() != nil {
				return nil, errors.New("git-lfs-transfer on the LFS server did not answer: the timeout passed")
			}
			if err != nil {
				return nil, errors.New("git-lfs-transfer on the LFS server: " + err.Error())
			}
			maps.Copy(states, answer)
		}
		return states, nil
	}
	if ctx.Err() != nil {
		return nil, errors.New("the LFS server did not answer: the timeout passed")
	}
	// ssh's lines of the failed session go into its error, not into the next call's reason.
	if line := c.takeSSHLine(); line != "" {
		transferErr = fmt.Errorf("%w (ssh: %s)", transferErr, line)
	}
	api, err := c.lfsAuthenticate(ctx, target)
	if err != nil {
		return nil, fmt.Errorf("%w; before it, git-lfs-transfer failed: %s", err, transferErr.Error())
	}
	return c.lfsStates(ctx, api, objects)
}

// sshTarget is the ssh destination, port and path of an ssh LFS server.
type sshTarget struct{ dest, port, path string }

// parseSSHTarget reads an ssh url, `ssh://` or scp-like.
func parseSSHTarget(raw string) (sshTarget, error) {
	var t sshTarget
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err != nil {
			return t, errors.New("the LFS server's ssh url could not be read")
		}
		t = sshTarget{dest: u.Hostname(), port: u.Port(), path: u.Path}
		if u.User != nil && u.User.Username() != "" {
			t.dest = u.User.Username() + "@" + t.dest
		}
	} else {
		t.dest, t.path, _ = strings.Cut(raw, ":")
	}
	// git-lfs sends the path to the remote shell unquoted; a path of other characters is refused,
	// so the remote shell reads it as one word.
	if strings.HasPrefix(t.dest, "-") || !sshPath.MatchString(t.path) || (t.port != "" && !isDigits(t.port)) {
		return t, errors.New("the LFS server's ssh url is not one jr2 runs ssh to")
	}
	return t, nil
}

// args are ssh's arguments after its command: the port, the destination, and the remote command.
func (t sshTarget) args(command, operation string) []string {
	var args []string
	if t.port != "" {
		args = append(args, "-p", t.port)
	}
	return append(args, t.dest, command, t.path, operation)
}

// sshArgv runs the call's ssh command with args: git runs core.sshCommand through the shell, and
// so does this, with the args after it.
func (c *call) sshArgv(args []string) []string {
	return append([]string{"sh", "-c", c.sshCommand + ` "$@"`, "ssh"}, args...)
}

// lfsAuthenticate runs `git-lfs-authenticate <path> download` on the ssh server, with the call's
// own ssh command (its key, its known hosts, batch mode), and reads the href and the headers that
// it answers.
func (c *call) lfsAuthenticate(ctx context.Context, t sshTarget) (*lfsAPI, error) {
	out, err := gitclean.Exec(ctx, c.repo, nil, c.sshArgv(t.args("git-lfs-authenticate", "download"))...)
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
	return &lfsAPI{href: strings.TrimSuffix(answer.Href, "/"), header: answer.Header, authenticated: true}, nil
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

// lfsBatch sends one download batch request. A 401 asks the credential helper for the batch url,
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
	}{Operation: "download", Transfers: []string{"basic"}, HashAlgo: "sha256"}
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
			switch {
			// The origin rule is why only when the push holds a token that the rule withheld.
			case res.StatusCode == http.StatusUnauthorized && *auth == "" && !api.authenticated && c.holdsToken() &&
				!c.onPushOrigin(target):
				why += ": " + originRule + ", and the LFS server is on another origin"
			case res.StatusCode == http.StatusUnauthorized, res.StatusCode == http.StatusForbidden:
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

// lfsParse reads a download batch answer: per oid, held (a download action and no error), or not,
// with the server's error for that object.
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
		case o.Actions["download"] != nil:
			states[o.Oid] = lfsState{held: true}
		default:
			states[o.Oid] = lfsState{}
		}
	}
	return states, nil
}

// originRule is why jr2 gave no token for a url on another origin (ADR-0051).
const originRule = "jr2 sends the push token only to the push url's origin (scheme, host, port)"

// holdsToken reports that the push holds a token: its url is https (ADR-0051).
func (c *call) holdsToken() bool {
	scheme, _, _ := lfsURLParts(strings.TrimSpace(c.spec.URL))
	return scheme == gitclean.SchemeHTTPS
}

// onPushOrigin reports that raw has the push url's origin: its scheme and its host with its port,
// as the credential helper matches them.
func (c *call) onPushOrigin(raw string) bool {
	a, errA := url.Parse(raw)
	b, errB := url.Parse(strings.TrimSpace(c.spec.URL))
	return errA == nil && errB == nil && strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Host, b.Host)
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
