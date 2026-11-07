package pushkind

// A push uploads its large files first (ADR-0067). When the commits that a push publishes hold
// Git LFS pointers, the Effector uploads those objects before it updates the branch:
//
//  1. It lists the pointers: each blob of `rev-list --objects <published> --not <held>` that is
//     at most 1024 bytes and parses as a pointer. A push with no pointer runs no git-lfs.
//  2. It reads each object as DATA: from the Agent's `<git dir>/lfs/objects`, opened beneath the
//     git dir with no symlink (package beneath), else from the node cache's `lfs/objects`. It
//     checks each one against its oid (sha256) and its size, and copies it into the call's own
//     scratch repository. git never runs with the Agent's repository as its repository, and
//     nothing of the Agent's config is read.
//  3. It runs jr2's own git-lfs (GitLFS) as `push --object-id` in the scratch repository, to the
//     push url. The LFS server is `lfs.url`, else `remote.origin.lfsurl`, of `.lfsconfig` at the
//     Binding's base in the node cache; else git-lfs derives it from the push url.
//
// The credential is the push's own: an https token goes only through the host-scoped helper, so
// an LFS server or an upload href on another host gets no token, and an href gets only the
// headers of the batch answer (ADR-0051). An upload that fails is `rejected` at stage `upload`,
// and nothing is pushed.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/snapwich/jr2/effector/internal/beneath"
	"github.com/snapwich/jr2/effector/internal/gitclean"
	"github.com/snapwich/jr2/effector/internal/reaper"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// DefaultGitLFS is jr2's own git-lfs, on the runtime volume (ADR-0053).
const DefaultGitLFS = "/opt/jr2/bin/git-lfs"

// lfsPointerMax is the largest blob that git-lfs reads as a pointer.
const lfsPointerMax = 1024

// stageUpload is the stage of an output whose LFS upload failed.
const stageUpload = "upload"

// lfsObject is one LFS object that a push publishes, and the first path that points to it.
type lfsObject struct {
	oid  string
	size int64
	path string
}

func (o lfsObject) name() string {
	if o.path == "" {
		return "oid " + o.oid
	}
	return fmt.Sprintf("%s (oid %s)", o.path, short(o.oid))
}

// uploadLFS uploads the LFS objects of what published adds to held. A nil output means that the
// push goes on: every object is uploaded, or there is none.
func (c *call) uploadLFS(ctx context.Context, published string, held []string) *wire.Output {
	objects, err := c.lfsPointers(ctx, published, held)
	if err != nil {
		return ptr(rejected(stageUpload, "the LFS pointers of the commits to publish could not be listed: "+
			err.Error()+"; nothing was pushed", ""))
	}
	if len(objects) == 0 {
		return nil
	}
	endpoint, err := c.lfsEndpoint(ctx)
	if err != nil {
		return ptr(rejected(stageUpload, err.Error()+"; nothing was pushed", ""))
	}
	for _, o := range objects {
		if err := c.stageLFS(o); err != nil {
			return ptr(rejected(stageUpload, err.Error()+"; nothing was pushed", ""))
		}
	}
	return c.runLFS(ctx, endpoint, objects)
}

// lfsPointers lists the pointer blobs that published adds to held, one per oid, sorted by path.
func (c *call) lfsPointers(ctx context.Context, published string, held []string) ([]lfsObject, error) {
	raw, err := c.repo.Git(ctx, strings.NewReader(revListInput(published, held)), "rev-list", "--objects", "--stdin")
	if err != nil {
		return nil, errors.New(tail(stderrOf(err)))
	}
	paths := map[string]string{}
	var ids []string
	for line := range strings.SplitSeq(string(raw), "\n") {
		id, path, _ := strings.Cut(line, " ")
		if id == "" {
			continue
		}
		if _, ok := paths[id]; !ok {
			ids = append(ids, id)
			paths[id] = path
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}
	// Only small blobs can be pointers: their type and size come first, their bytes after.
	checked, err := c.repo.Git(ctx, strings.NewReader(strings.Join(ids, "\n")+"\n"), "cat-file",
		"--batch-check=%(objectname) %(objecttype) %(objectsize)")
	if err != nil {
		return nil, errors.New(tail(stderrOf(err)))
	}
	var small []string
	for line := range strings.SplitSeq(string(checked), "\n") {
		f := strings.Fields(line)
		if len(f) != 3 || f[1] != "blob" {
			continue
		}
		if n, err := strconv.ParseInt(f[2], 10, 64); err == nil && n <= lfsPointerMax {
			small = append(small, f[0])
		}
	}
	if len(small) == 0 {
		return nil, nil
	}
	body, err := c.repo.Git(ctx, strings.NewReader(strings.Join(small, "\n")+"\n"), "cat-file", "--batch")
	if err != nil {
		return nil, errors.New(tail(stderrOf(err)))
	}
	byOid := map[string]lfsObject{}
	for len(body) > 0 {
		header, rest, ok := bytes.Cut(body, []byte("\n"))
		if !ok {
			break
		}
		f := strings.Fields(string(header))
		if len(f) != 3 {
			break
		}
		n, err := strconv.Atoi(f[2])
		if err != nil || n < 0 || n+1 > len(rest) {
			break
		}
		if o, ok := parsePointer(rest[:n]); ok {
			o.path = paths[f[0]]
			if prev, seen := byOid[o.oid]; !seen || o.path < prev.path {
				byOid[o.oid] = o
			}
		}
		body = rest[n+1:]
	}
	out := make([]lfsObject, 0, len(byOid))
	for _, o := range byOid {
		out = append(out, o)
	}
	slices.SortFunc(out, func(a, b lfsObject) int { return strings.Compare(a.path+"\x00"+a.oid, b.path+"\x00"+b.oid) })
	return out, nil
}

var (
	pointerVersion = regexp.MustCompile(`^version https://git-lfs\.github\.com/spec/v1$`)
	pointerExt     = regexp.MustCompile(`^ext-[0-9]-[A-Za-z0-9]+ sha256:[0-9a-f]{64}$`)
	pointerOid     = regexp.MustCompile(`^oid sha256:([0-9a-f]{64})$`)
	pointerSize    = regexp.MustCompile(`^size (0|[1-9][0-9]{0,18})$`)
)

// parsePointer reads a Git LFS pointer: the version line, the extension lines that the spec
// allows (`ext-<n>-<name> sha256:<oid>`, at most ten), then the oid and the size, each line ended
// by a newline. Any other blob is not a pointer.
func parsePointer(raw []byte) (lfsObject, bool) {
	if !bytes.HasSuffix(raw, []byte("\n")) {
		return lfsObject{}, false
	}
	lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	if len(lines) < 3 || len(lines) > 13 || !pointerVersion.MatchString(lines[0]) {
		return lfsObject{}, false
	}
	for _, ext := range lines[1 : len(lines)-2] {
		if !pointerExt.MatchString(ext) {
			return lfsObject{}, false
		}
	}
	oid := pointerOid.FindStringSubmatch(lines[len(lines)-2])
	size := pointerSize.FindStringSubmatch(lines[len(lines)-1])
	if oid == nil || size == nil {
		return lfsObject{}, false
	}
	n, err := strconv.ParseInt(size[1], 10, 64)
	if err != nil {
		return lfsObject{}, false
	}
	return lfsObject{oid: oid[1], size: n}, true
}

// lfsRel is where git-lfs keeps one object, under a git dir.
func lfsRel(oid string) string {
	return filepath.Join("lfs", "objects", oid[0:2], oid[2:4], oid)
}

// stageLFS copies one object into the scratch repository's own store: from the Agent's store,
// else from the node cache's, each checked against its oid and size. An object that neither
// holds whole names its file, and why the opener refused the Agent's file when it did. Such an
// object is refused also when the server holds it already: `git-lfs push --object-id` reads
// each object from local storage before it asks the server.
func (c *call) stageLFS(o lfsObject) error {
	dst := filepath.Join(c.repo.Dir, lfsRel(o.oid))
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	agentErr := c.copyLFS(c.r.WorkRoot, c.spec.Repo.GitDir, o, dst)
	if agentErr == nil {
		return nil
	}
	// Each cache is its own mount (/repos/<key>), so the cache's folder is the root that is opened:
	// the opener crosses no mount.
	cacheErr := c.copyLFS(filepath.Join(c.r.ReposRoot, c.spec.Repo.Cache), ".", o, dst)
	if cacheErr == nil {
		return nil
	}
	var mismatch *lfsMismatch
	switch {
	case errors.As(agentErr, &mismatch), errors.As(cacheErr, &mismatch):
		return fmt.Errorf("the LFS object of %s does not match its oid: %s", o.name(), mismatch.why)
	}
	why := ""
	if refused := refusal(agentErr); refused != "" {
		why = " (the Agent's file was refused: " + refused + ")"
	}
	return fmt.Errorf("the LFS object of %s is in neither the Agent's repository nor the node cache%s, so it "+
		"cannot be uploaded", o.name(), why)
}

// refusal is why the opener refused the Agent's object file: a symlink, a FIFO, a file with more
// than one hard link. A file that is not there is no refusal: "".
func refusal(err error) string {
	var refused *beneath.Refused
	if !errors.As(err, &refused) || strings.Contains(refused.Reason, "does not exist") {
		return ""
	}
	return refused.Reason
}

// lfsMismatch is an object file whose bytes are not the pointer's.
type lfsMismatch struct{ why string }

func (m *lfsMismatch) Error() string { return m.why }

// copyLFS reads the object of o under root/rel, as data, and writes it to dst when its bytes
// hash to the oid and have the size.
func (c *call) copyLFS(root, rel string, o lfsObject, dst string) error {
	dir, err := beneath.Dir(root, rel)
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	src, err := beneath.Open(dir, lfsRel(o.oid))
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	if src.Size != o.size {
		return &lfsMismatch{why: fmt.Sprintf("its file holds %d bytes, and the pointer says %d", src.Size, o.size)}
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".in-")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	sum := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, sum), io.LimitReader(src, o.size+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n != o.size {
		return &lfsMismatch{why: fmt.Sprintf("its file holds %d bytes, and the pointer says %d", n, o.size)}
	}
	if got := hex.EncodeToString(sum.Sum(nil)); got != o.oid {
		return &lfsMismatch{why: "its bytes hash to " + short(got)}
	}
	return os.Rename(tmp.Name(), dst)
}

// lfsEndpoint is the LFS server that `.lfsconfig` at the Binding's base names in the node cache:
// `lfs.url`, else `remote.origin.lfsurl`. "" is none: git-lfs derives the server from the push
// url. The base is resolved after `--end-of-options`, and the cache is the scratch repository's
// alternate, so its blob is read there. A named server must use https or http, or ssh on the
// host of an ssh push url (ADR-0051's LFS rule): a base cannot send the upload to a file in the
// Effector's pod, and the push's ssh key goes to no other host.
func (c *call) lfsEndpoint(ctx context.Context) (string, error) {
	name := c.spec.Base
	if name == "" {
		name = "HEAD"
	}
	cache := filepath.Join(c.r.ReposRoot, c.spec.Repo.Cache)
	out, err := gitclean.Exec(ctx, c.repo, nil, "git", "--git-dir="+cache, "rev-parse", "--verify", "--quiet",
		"--end-of-options", name+"^{commit}")
	commit := strings.TrimSpace(string(out))
	if err != nil || !gitclean.IsSha(commit) {
		if c.spec.Base == "" {
			return "", nil
		}
		return "", fmt.Errorf("the LFS server could not be read: the Binding's base %q is not in the node cache", c.spec.Base)
	}
	blob := commit + ":.lfsconfig"
	if _, err := c.repo.Line(ctx, "rev-parse", "--verify", "--quiet", "--end-of-options", blob); err != nil {
		return "", nil
	}
	for _, key := range []string{"lfs.url", "remote.origin.lfsurl"} {
		// With no includes: an include.path in the base would make git read any file as config,
		// the Agent's own config among them, or block on a FIFO.
		value, err := c.repo.Line(ctx, "config", "--no-includes", "--blob", blob, "--get", key)
		if err != nil || value == "" {
			continue
		}
		if !c.lfsSchemeAllowed(value) {
			return "", fmt.Errorf(".lfsconfig at the Binding's base names %s %q: jr2 uploads LFS objects only to an "+
				"https or http server, or to an ssh server on the host of an ssh push url", key, value)
		}
		return value, nil
	}
	return "", nil
}

func (c *call) lfsSchemeAllowed(raw string) bool {
	if strings.HasPrefix(raw, "-") || strings.ContainsAny(raw, "\x00\r\n\t ") {
		return false
	}
	scheme, host, ok := lfsURLParts(raw)
	if !ok {
		return false
	}
	switch scheme {
	case gitclean.SchemeHTTPS, gitclean.SchemeHTTP:
		return host != ""
	case gitclean.SchemeSSH:
		pushScheme, pushHost, pushOK := lfsURLParts(c.spec.URL)
		return pushOK && pushScheme == gitclean.SchemeSSH && strings.EqualFold(host, pushHost)
	}
	return false
}

// lfsURLParts gives the scheme and the host of a git url, as the cache agent reads an LFS server
// (ADR-0051): `<scheme>://...`, with git+ssh as ssh, or the scp-like `[user@]host:path`, which is
// ssh. A local path, a file url, a `<helper>::<address>` and an ssh host that is not a plain name
// give !ok.
func lfsURLParts(raw string) (scheme, host string, ok bool) {
	if i := strings.Index(raw, "://"); i >= 0 {
		scheme = strings.ToLower(raw[:i])
		if scheme == "git+ssh" {
			scheme = gitclean.SchemeSSH
		}
		if !schemeName.MatchString(scheme) || scheme == "file" {
			return "", "", false
		}
		u, err := url.Parse(raw)
		if err != nil || u.Hostname() == "" || strings.HasPrefix(u.Hostname(), "-") {
			return "", "", false
		}
		if scheme == gitclean.SchemeSSH && !hostName.MatchString(u.Hostname()) {
			return "", "", false
		}
		return scheme, u.Hostname(), true
	}
	// git's rule: a colon before any slash makes the url scp-like; else it is a path.
	colon := strings.Index(raw, ":")
	if colon <= 0 || strings.Contains(raw[:colon], "/") || strings.HasPrefix(raw[colon+1:], ":") {
		return "", "", false
	}
	host = raw[:colon]
	if at := strings.LastIndex(host, "@"); at >= 0 {
		host = host[at+1:]
	}
	if !hostName.MatchString(host) {
		return "", "", false
	}
	return gitclean.SchemeSSH, host, true
}

var (
	schemeName = regexp.MustCompile(`^[a-z][a-z0-9+.-]*$`)
	hostName   = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]*$`)
)

// runLFS runs git-lfs `push --object-id` in the scratch repository, to the push url, with the
// push's credential config (the helper or the ssh command, the CA file).
func (c *call) runLFS(ctx context.Context, endpoint string, objects []lfsObject) *wire.Output {
	repo := c.repo
	settings := [][2]string{
		// A lock is not the push's business: git-lfs asks the server about none.
		{"lfs.locksverify", "false"},
	}
	if endpoint != "" {
		settings = append(settings, [2]string{"lfs.url", endpoint})
	}
	for _, kv := range settings {
		if _, err := repo.Git(ctx, nil, "config", kv[0], kv[1]); err != nil {
			return ptr(rejected(stageUpload, "the LFS upload could not be configured; nothing was pushed",
				tail(stderrOf(err))))
		}
	}
	program := c.r.GitLFS
	if program == "" {
		program = DefaultGitLFS
	}
	var oids strings.Builder
	for _, o := range objects {
		oids.WriteString(o.oid + "\n")
	}
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, program, "push", "--object-id", "--stdin", c.spec.URL)
	cmd.Env = append(repo.Env(), "GIT_DIR="+repo.Dir)
	cmd.Dir = repo.Dir
	cmd.Stdin = strings.NewReader(oids.String())
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = time.Second
	err := reaper.Run(ctx, cmd)
	if err == nil {
		return nil
	}
	words := strings.TrimSpace(stdout.String() + "\n" + stderr.String())
	reason := "the LFS objects of " + namesOf(objects) + " could not be uploaded"
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		reason += ": the timeout passed"
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, os.ErrNotExist):
		reason += ": this Effector holds no git-lfs at " + program
	default:
		if why := classify(words, ctx); why == "the remote refused the credential" ||
			why == "the remote's TLS certificate is not trusted" {
			reason += ": " + why
		}
		if last := lastLine(words); last != "" {
			reason += "; git-lfs: " + last
		}
	}
	return ptr(rejected(stageUpload, reason+"; nothing was pushed", tail(words)))
}

// lastLine is the last line of git-lfs's words that is not its progress, at most 300 bytes: its
// summary of the failure.
func lastLine(words string) string {
	last := ""
	for line := range strings.FieldsFuncSeq(words, func(r rune) bool { return r == '\n' || r == '\r' }) {
		if line = strings.TrimSpace(line); line != "" && !strings.HasPrefix(line, "Uploading LFS objects") {
			last = line
		}
	}
	if len(last) > 300 {
		last = last[:300] + "…"
	}
	return last
}

// namesOf names the files of an upload: the first three, and how many more.
func namesOf(objects []lfsObject) string {
	var names []string
	for i, o := range objects {
		if i == 3 {
			names = append(names, fmt.Sprintf("and %d more", len(objects)-3))
			break
		}
		names = append(names, o.name())
	}
	return strings.Join(names, ", ")
}
