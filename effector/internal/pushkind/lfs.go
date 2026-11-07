package pushkind

// A push uploads its large files first (ADR-0067). When the commits that a push publishes hold
// Git LFS pointers, the Effector uploads those objects before it updates the branch:
//
//  1. It lists the pointers: each blob of `rev-list --objects <published> --not <held>` that is
//     at most 1024 bytes and parses as a pointer. A push with no pointer runs no git-lfs.
//  2. It asks the LFS server's batch API which objects the server holds, with a download batch
//     (lfsbatch.go). An object that the server holds is not uploaded, and needs no local copy. An
//     object that the answer leaves out is `rejected` at once.
//  3. It reads each object that the server lacks as DATA: from the Agent's
//     `<git dir>/lfs/objects`, opened beneath the git dir with no symlink (package beneath), else
//     from the node cache's `lfs/objects`. It checks each one against its oid (sha256) and its
//     size, and copies it into the call's own scratch repository. git never runs with the
//     Agent's repository as its repository, and nothing of the Agent's config is read.
//  4. It runs jr2's own git-lfs (GitLFS) as `push --object-id` in the scratch repository, to the
//     push url.
//  5. It asks the batch API again, with a download batch: the server must hold each object that
//     was uploaded. git-lfs's exit code alone does not say so: a PUT or a verify that answers 422
//     makes it exit 0.
//
// The LFS server is the first of `lfs.pushurl`, `lfs.url`, `remote.origin.lfspushurl` and
// `remote.origin.lfsurl` of `.lfsconfig` at the Binding's base in the node cache, as git-lfs
// chooses for an upload; else git-lfs derives it from the push url.
//
// The credential is the push's own: an https token goes only through the origin-scoped helper,
// so an LFS server or an upload href on another origin gets no token, and an href there gets only
// the headers of the batch answer (ADR-0051). An upload that fails is `rejected` at stage
// `upload`, and nothing is pushed.

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

// lfsBatchChunk is how many small blobs one `cat-file --batch` reads: at most about 1 MiB.
const lfsBatchChunk = 1024

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
// push goes on: the server holds every object, or there is none.
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
	states, err := c.lfsHeld(ctx, endpoint, objects)
	if err != nil {
		return ptr(rejected(stageUpload, "the LFS objects of "+namesOf(objects)+" could not be uploaded: "+
			withoutQueries(err.Error())+"; nothing was pushed", ""))
	}
	var need []lfsObject
	for _, o := range objects {
		s, ok := states[o.oid]
		switch {
		case !ok:
			return ptr(rejected(stageUpload, "the LFS object of "+o.name()+" could not be uploaded: the server's "+
				"batch answer left it out; nothing was pushed", ""))
		case !s.held:
			need = append(need, o)
		}
	}
	if len(need) == 0 {
		return nil
	}
	for _, o := range need {
		if err := c.stageLFS(o); err != nil {
			return ptr(rejected(stageUpload, err.Error()+"; nothing was pushed", ""))
		}
	}
	words, out := c.runLFS(ctx, endpoint, need)
	if out != nil {
		return out
	}
	// git-lfs exited 0. The server must hold each object now: ask it.
	after, err := c.lfsHeld(ctx, endpoint, need)
	if err != nil {
		return ptr(rejected(stageUpload, "the upload of the LFS objects of "+namesOf(need)+" could not be "+
			"confirmed: "+withoutQueries(err.Error())+"; nothing was pushed", tail(words)))
	}
	var lacking []lfsObject
	why := ""
	for _, o := range need {
		if s := after[o.oid]; !s.held {
			lacking = append(lacking, o)
			if why == "" {
				why = s.why
			}
		}
	}
	if len(lacking) == 0 {
		return nil
	}
	reason := "the LFS server does not hold the objects of " + namesOf(lacking) + " after the upload"
	if why != "" {
		reason += " (" + why + ")"
	}
	if last := lastLine(words); last != "" {
		reason += "; git-lfs: " + last
	}
	return ptr(rejected(stageUpload, reason+"; nothing was pushed", tail(words)))
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
	// The bytes are read in chunks, so that a push of very many small files holds at most one
	// chunk of their bytes.
	byOid := map[string]lfsObject{}
	for chunk := range slices.Chunk(small, lfsBatchChunk) {
		body, err := c.repo.Git(ctx, strings.NewReader(strings.Join(chunk, "\n")+"\n"), "cat-file", "--batch")
		if err != nil {
			return nil, errors.New(tail(stderrOf(err)))
		}
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
	}
	out := make([]lfsObject, 0, len(byOid))
	for _, o := range byOid {
		out = append(out, o)
	}
	slices.SortFunc(out, func(a, b lfsObject) int { return strings.Compare(a.path+"\x00"+a.oid, b.path+"\x00"+b.oid) })
	return out, nil
}

var (
	pointerExt = regexp.MustCompile(`^ext-[0-9]-[A-Za-z0-9_]+$`)
	pointerSha = regexp.MustCompile(`^sha256:([0-9a-f]{64})$`)
	// pointerVersions are the versions that git-lfs reads as the pointer spec's v1.
	pointerVersions = []string{"https://git-lfs.github.com/spec/v1", "https://hawser.github.com/spec/v1",
		"http://git-media.io/v/2"}
	pointerKeys = []string{"version", "oid", "size"}
)

// parsePointer reads a Git LFS pointer as git-lfs reads it, so that each blob that a checkout
// smudges is a pointer here too: space at the start and the end is ignored, a line ends at a
// newline with an optional carriage return, an empty line is skipped, and the size is a decimal
// that ParseInt reads ("012" and "+12" are 12). The keys are the version, the oid and the size,
// in that order, with extension lines (`ext-<n>-<name> sha256:<oid>`) where a key is expected.
// Any other blob is not a pointer.
func parsePointer(raw []byte) (lfsObject, bool) {
	values := map[string]string{}
	next := 0
	for line := range strings.SplitSeq(string(bytes.TrimSpace(raw)), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" {
			continue
		}
		key, value, ok := strings.Cut(line, " ")
		if !ok || next == len(pointerKeys) {
			return lfsObject{}, false
		}
		if key != pointerKeys[next] {
			if !pointerExt.MatchString(key) || !pointerSha.MatchString(value) {
				return lfsObject{}, false
			}
			continue
		}
		values[key] = value
		next++
	}
	if next != len(pointerKeys) || !slices.Contains(pointerVersions, values["version"]) {
		return lfsObject{}, false
	}
	oid := pointerSha.FindStringSubmatch(values["oid"])
	n, err := strconv.ParseInt(values["size"], 10, 64)
	if oid == nil || err != nil || n < 0 {
		return lfsObject{}, false
	}
	return lfsObject{oid: oid[1], size: n}, true
}

// lfsRel is where git-lfs keeps one object, under a git dir.
func lfsRel(oid string) string {
	return filepath.Join("lfs", "objects", oid[0:2], oid[2:4], oid)
}

// stageLFS copies one object that the server lacks into the scratch repository's own store:
// from the Agent's store, else from the node cache's, each checked against its oid and size. An
// object that neither holds whole names its file and the cause: a file whose bytes are not the
// pointer's, the opener's refusal of the Agent's file, or the error that the read gave.
func (c *call) stageLFS(o lfsObject) error {
	dst := filepath.Join(c.repo.Dir, lfsRel(o.oid))
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return fmt.Errorf("the LFS object of %s could not be staged: %w", o.name(), err)
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
		return fmt.Errorf("the LFS object of %s does not match its oid: %s, and the server lacks it", o.name(),
			mismatch.why)
	}
	var causes []string
	if why := readCause(agentErr); why != "" {
		causes = append(causes, "the Agent's file: "+why)
	}
	if why := readCause(cacheErr); why != "" {
		causes = append(causes, "the node cache's file: "+why)
	}
	if len(causes) > 0 {
		return fmt.Errorf("the LFS object of %s could not be read (%s), and the server lacks it, so it cannot be "+
			"uploaded", o.name(), strings.Join(causes, "; "))
	}
	return fmt.Errorf("the LFS object of %s is in neither the Agent's repository nor the node cache, and the "+
		"server lacks it, so it cannot be uploaded", o.name())
}

// readCause is why a store's object file could not be read, or "" when the file is not there: the
// opener's refusal (a symlink, a FIFO, a file with more than one hard link), or an I/O error such
// as a permission or a full disk.
func readCause(err error) string {
	var refused *beneath.Refused
	switch {
	case err == nil, errors.Is(err, os.ErrNotExist):
		return ""
	case errors.As(err, &refused):
		if strings.Contains(refused.Reason, "does not exist") {
			return ""
		}
		return "refused: " + refused.Reason
	}
	return err.Error()
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

// lfsEndpoint is the LFS server that `.lfsconfig` at the Binding's base names in the node cache,
// as git-lfs chooses the server of an upload: `lfs.pushurl`, `lfs.url`,
// `remote.origin.lfspushurl`, then `remote.origin.lfsurl`. A push url is honored because a
// repository that names one reads from a server that may take no upload, a mirror. "" is none:
// git-lfs derives the server from the push url. The base is resolved after `--end-of-options`,
// and the cache is the scratch repository's alternate, so its blob is read there. A named server
// must use https or http, or ssh on the host of an ssh push url (ADR-0051's LFS rule): a base
// cannot send the upload to a file in the Effector's pod, and the push's ssh key goes to no other
// host.
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
	for _, key := range []string{"lfs.pushurl", "lfs.url", "remote.origin.lfspushurl", "remote.origin.lfsurl"} {
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
	if before, _, found := strings.Cut(raw, "://"); found {
		scheme = strings.ToLower(before)
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
// push's credential config (the helper or the ssh command, the CA file). It answers git-lfs's
// words with no query of a url, and an output when git-lfs failed. An exit of 0 is not proof that
// the server holds the objects: the caller asks the server.
func (c *call) runLFS(ctx context.Context, endpoint string, objects []lfsObject) (string, *wire.Output) {
	repo := c.repo
	settings := [][2]string{
		// A lock is not the push's business: git-lfs asks the server about none.
		{"lfs.locksverify", "false"},
		// git-lfs's own default, set so that nothing else chooses it: an ssh server is asked over
		// the pure SSH protocol (git-lfs-transfer) when it speaks it, else through
		// git-lfs-authenticate. The check (lfsHeldSSH) negotiates in the same order, so the upload
		// and the check use the same protocol, and a server that speaks only one of them works.
		{"lfs.sshtransfer", "negotiate"},
	}
	if endpoint != "" {
		settings = append(settings, [2]string{"lfs.url", endpoint})
	}
	for _, kv := range settings {
		if _, err := repo.Git(ctx, nil, "config", kv[0], kv[1]); err != nil {
			return "", ptr(rejected(stageUpload, "the LFS upload could not be configured; nothing was pushed",
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
	words := withoutQueries(strings.TrimSpace(stdout.String() + "\n" + stderr.String()))
	if err == nil {
		return words, nil
	}
	reason := "the LFS objects of " + namesOf(objects) + " could not be uploaded"
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		reason += ": the timeout passed"
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, os.ErrNotExist):
		reason += ": this Effector holds no git-lfs at " + program
	default:
		switch why := classify(words, ctx); {
		case why == refusedCredential && c.namesOtherOrigin(words):
			// The helper gave git-lfs no token for that url: say why, not that a token was refused.
			reason += ": a url on another origin asked for a credential, and " + originRule
		case why == refusedCredential, why == "the remote's TLS certificate is not trusted":
			reason += ": " + why
		}
		if last := lastLine(words); last != "" {
			reason += "; git-lfs: " + last
		}
	}
	return words, ptr(rejected(stageUpload, reason+"; nothing was pushed", tail(words)))
}

// namesOtherOrigin reports that the push holds a token (an https push url) and that git-lfs's
// words name an http(s) url whose origin is not the push url's: the credential helper answers no
// such url.
func (c *call) namesOtherOrigin(words string) bool {
	if scheme, _, _ := lfsURLParts(strings.TrimSpace(c.spec.URL)); scheme != gitclean.SchemeHTTPS {
		return false
	}
	for _, u := range httpURL.FindAllString(words, -1) {
		if !c.onPushOrigin(u) {
			return true
		}
	}
	return false
}

var httpURL = regexp.MustCompile(`(?i)\bhttps?://[^\s"'<>]+`)

// urlQuery is the query and the fragment of a url in git-lfs's words.
var urlQuery = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://[^\s?#"'<>]*)[?#][^\s"'<>]*`)

// withoutQueries removes the query and the fragment of each url in git-lfs's words. An upload
// href can carry its credential in its query (a presigned url), and the scrubber does not know
// that value, so the Agent must not read it.
func withoutQueries(words string) string {
	return urlQuery.ReplaceAllString(words, "$1?…")
}

// lastLine is git-lfs's summary of a failure, at most 300 bytes: the last line that says
// "failed" or "error", else the last line that is not its progress.
func lastLine(words string) string {
	last, failed := "", ""
	for line := range strings.FieldsFuncSeq(words, func(r rune) bool { return r == '\n' || r == '\r' }) {
		if line = strings.TrimSpace(line); line == "" || strings.HasPrefix(line, "Uploading LFS objects") {
			continue
		}
		last = line
		if l := strings.ToLower(line); strings.Contains(l, "failed") || strings.Contains(l, "error") {
			failed = line
		}
	}
	if failed != "" {
		last = failed
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
