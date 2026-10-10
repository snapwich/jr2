// Package gitclean is the one procedure by which the Sandbox Effector touches the Agent's
// repository (ADR-0067, ADR-0068): git NEVER runs with the Agent's repository as its repository.
// Each call gets a new bare repository in the Effector's own scratch, configured by jr2 alone
// under a cleared environment, and the Agent's objects are imported into it as DATA — one
// `pack-objects` over the Agent's object store, with a deadline (a FIFO in place of an object
// blocks an open forever), then `index-pack --strict`, which re-hashes and fscks every object,
// then a connectivity check. So no config, hook, attribute, alternate-refs command or remote of
// the Agent's is read, and no program the Agent's files name runs. Evidence: effector-push.sh,
// run over file, HTTPS and ssh on git 2.43, 2.47 and 2.49, ran 0 of the planted programs.
package gitclean

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/snapwich/jr2/effector/internal/beneath"
)

// Path is the PATH every git call gets: the image's usual places, never the Agent's.
const Path = "/usr/local/bin:/usr/bin:/bin"

// Options configure one clean repository.
type Options struct {
	// Scratch is the Effector's own writable directory ($HOME, an emptyDir). The repository and
	// its home are made under it, and removed by Close.
	Scratch string
	// Caches are the trusted object stores (the node's Repo caches, /repos/<key>, ADR-0051): the
	// clean repository borrows from them as alternates, and their refs are what the Agent's
	// import need not carry.
	Caches []string
	// Protocols are the transports git may use (GIT_ALLOW_PROTOCOL). Default "https:ssh".
	Protocols string
	// Env is added to every git call: a credential file's path, an ssh command's — never a value.
	Env []string
}

// Repo is one clean bare repository, for one call.
type Repo struct {
	// Work is the call's own directory: the repository, its home, and the files jr2 writes.
	Work string
	Dir  string
	env  []string
}

// New makes a clean repository under opts.Scratch.
func New(ctx context.Context, opts Options) (*Repo, error) {
	if err := os.MkdirAll(opts.Scratch, 0o700); err != nil {
		return nil, err
	}
	work, err := os.MkdirTemp(opts.Scratch, "call.")
	if err != nil {
		return nil, err
	}
	r := &Repo{Work: work, Dir: filepath.Join(work, "repo.git")}
	home := filepath.Join(work, "home")
	for _, d := range []string{home, filepath.Join(work, "nohooks")} {
		if err := os.Mkdir(d, 0o700); err != nil {
			r.Close()
			return nil, err
		}
	}
	protocols := opts.Protocols
	if protocols == "" {
		protocols = "https:ssh"
	}
	// The environment of every git call: nothing from the system, the user, or the Agent.
	r.env = append([]string{
		"PATH=" + Path, "HOME=" + home, "LC_ALL=C",
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=/bin/false", "SSH_ASKPASS=/bin/false",
		"GIT_NO_REPLACE_OBJECTS=1", "GIT_PROTOCOL_FROM_USER=0",
		"GIT_ALLOW_PROTOCOL=" + protocols,
	}, opts.Env...)
	if _, err := r.run(ctx, nil, nil, "init", "-q", "--bare", r.Dir); err != nil {
		r.Close()
		return nil, fmt.Errorf("git init: %w", err)
	}
	const yes, no = "true", "false"
	for _, kv := range [][2]string{
		{"core.hooksPath", filepath.Join(work, "nohooks")},
		{"core.fsmonitor", no},
		{"core.commitGraph", no},
		{"core.multiPackIndex", no},
		{"core.alternateRefsCommand", yes},
		{"pack.useBitmaps", no},
		{"gc.auto", "0"},
		{"maintenance.auto", no},
		{"transfer.fsckObjects", yes},
		{"fetch.fsckObjects", yes},
		{"receive.fsckObjects", yes},
		{"protocol.version", "2"},
		{"push.default", "nothing"},
		{"credential.helper", ""},
		// A redirect would take the push, and the helper's credential, to an origin outside the
		// git.credentials entry: the clean repository follows none.
		{"http.followRedirects", no},
	} {
		if _, err := r.Git(ctx, nil, "config", kv[0], kv[1]); err != nil {
			r.Close()
			return nil, fmt.Errorf("git config %s: %w", kv[0], err)
		}
	}
	if len(opts.Caches) > 0 {
		var alt strings.Builder
		for _, c := range opts.Caches {
			alt.WriteString(objectsOf(c) + "\n")
		}
		alternates := filepath.Join(r.Dir, "objects", "info", "alternates")
		if err := os.WriteFile(alternates, []byte(alt.String()), 0o600); err != nil {
			r.Close()
			return nil, err
		}
	}
	return r, nil
}

// objectsOf is a repository's object store: a bare repository's `objects`, or a non-bare one's
// `.git/objects`.
func objectsOf(repo string) string {
	if st, err := os.Stat(filepath.Join(repo, "objects")); err == nil && st.IsDir() {
		return filepath.Join(repo, "objects")
	}
	return filepath.Join(repo, ".git", "objects")
}

// Close removes the call's directory.
func (r *Repo) Close() { _ = os.RemoveAll(r.Work) }

// Env is the environment every git call of this repository gets.
func (r *Repo) Env() []string { return append([]string(nil), r.env...) }

// Error is a git call that exited non-zero, with its stderr.
type Error struct {
	Args   []string
	Stderr string
	Err    error
}

func (e *Error) Error() string {
	return fmt.Sprintf("git %s: %v: %s", strings.Join(e.Args, " "), e.Err, strings.TrimSpace(e.Stderr))
}

func (e *Error) Unwrap() error { return e.Err }

// Git runs git with this repository as its repository.
func (r *Repo) Git(ctx context.Context, stdin io.Reader, args ...string) ([]byte, error) {
	return r.run(ctx, stdin, nil, append([]string{"--git-dir=" + r.Dir}, args...)...)
}

// GitEnv runs git with this repository and extra env.
func (r *Repo) GitEnv(ctx context.Context, stdin io.Reader, env []string, args ...string) ([]byte, error) {
	return r.run(ctx, stdin, env, append([]string{"--git-dir=" + r.Dir}, args...)...)
}

// GitTo runs git with this repository, its stdout into w.
func (r *Repo) GitTo(ctx context.Context, w io.Writer, stdin io.Reader, env []string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", append([]string{"--git-dir=" + r.Dir}, args...)...)
	cmd.Env = append(r.Env(), env...)
	cmd.Dir = r.Work
	cmd.Stdin = stdin
	cmd.Stdout = w
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		return &Error{Args: args, Stderr: stderr.String(), Err: err}
	}
	return nil
}

func (r *Repo) run(ctx context.Context, stdin io.Reader, env []string, args ...string) ([]byte, error) {
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = append(r.Env(), env...)
	cmd.Dir = r.Work
	cmd.Stdin = stdin
	cmd.Stdout = &out
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		return out.Bytes(), &Error{Args: args, Stderr: stderr.String(), Err: err}
	}
	return out.Bytes(), nil
}

// Exec runs one of jr2's own programs (ssh-keygen, gpg) in this repository's call directory, with
// its cleared environment, and answers its stdout.
func Exec(ctx context.Context, r *Repo, stdin io.Reader, argv ...string) ([]byte, error) {
	var out, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = r.Env()
	cmd.Dir = r.Work
	if stdin != nil {
		cmd.Stdin = stdin
	}
	cmd.Stdout, cmd.Stderr = &out, &stderr
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		return out.Bytes(), &Error{Args: argv, Stderr: stderr.String(), Err: err}
	}
	return out.Bytes(), nil
}

// Line runs git and answers its stdout's first line.
func (r *Repo) Line(ctx context.Context, args ...string) (string, error) {
	out, err := r.Git(ctx, nil, args...)
	if err != nil {
		return "", err
	}
	line, _, _ := strings.Cut(string(out), "\n")
	return strings.TrimSpace(line), nil
}

// Lines runs git and answers its stdout's non-empty lines.
func (r *Repo) Lines(ctx context.Context, args ...string) ([]string, error) {
	out, err := r.Git(ctx, nil, args...)
	if err != nil {
		return nil, err
	}
	return fields(string(out)), nil
}

func fields(s string) []string {
	var out []string
	for line := range strings.SplitSeq(s, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out
}

// IsAncestor says whether a is an ancestor of b (or b itself).
func (r *Repo) IsAncestor(ctx context.Context, a, b string) bool {
	_, err := r.Git(ctx, nil, "merge-base", "--is-ancestor", a, b)
	return err == nil
}

// CacheTips are the commits the trusted caches name: what the Agent's import need not carry.
func (r *Repo) CacheTips(ctx context.Context, caches []string) ([]string, error) {
	seen := map[string]bool{}
	var tips []string
	for _, c := range caches {
		// The cache is the node's (ADR-0051), trusted: its refs are read, its config is not run —
		// for-each-ref runs no program.
		out, err := r.run(ctx, nil, nil, "--git-dir="+gitDirOf(c), "for-each-ref", "--format=%(objectname)")
		if err != nil {
			return nil, err
		}
		for _, t := range fields(string(out)) {
			if !seen[t] {
				seen[t] = true
				tips = append(tips, t)
			}
		}
	}
	return tips, nil
}

func gitDirOf(repo string) string {
	if st, err := os.Stat(filepath.Join(repo, "objects")); err == nil && st.IsDir() {
		return repo
	}
	return filepath.Join(repo, ".git")
}

var hex40 = regexp.MustCompile(`^[0-9a-f]{40}$`)

// IsSha says whether s is a full object id.
func IsSha(s string) bool { return hex40.MatchString(s) }

// ErrImport is an import of the Agent's objects that failed: output of the Effect, never a fault
// (the Agent owns those objects, so it can make them fail).
type ErrImport struct{ Reason string }

func (e *ErrImport) Error() string { return e.Reason }

// Import brings the commit sha and every object it reaches that `have` does not into this
// repository, from the Agent's object store, as data: read with a deadline by one pack-objects,
// re-hashed and fscked by `index-pack --strict`, then checked connected without the Agent's store.
func (r *Repo) Import(ctx context.Context, agentObjects, sha string, have []string, deadline time.Duration) error {
	if !IsSha(sha) {
		return &ErrImport{Reason: fmt.Sprintf("%q is not a full commit id", sha)}
	}
	alt := []string{"GIT_ALTERNATE_OBJECT_DIRECTORIES=" + agentObjects}
	read, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	kind, err := r.GitEnv(read, nil, alt, "cat-file", "-t", sha)
	if err != nil || strings.TrimSpace(string(kind)) != "commit" {
		if errors.Is(read.Err(), context.DeadlineExceeded) {
			return &ErrImport{Reason: "reading the Agent's objects passed its deadline"}
		}
		return &ErrImport{Reason: fmt.Sprintf("commit %s is not in the Agent's repository", sha)}
	}
	var revs strings.Builder
	revs.WriteString(sha + "\n--not\n")
	for _, h := range have {
		revs.WriteString(h + "\n")
	}
	pack := filepath.Join(r.Work, "in.pack")
	f, err := os.OpenFile(pack, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	err = r.GitTo(read, f, strings.NewReader(revs.String()), alt, "pack-objects", "-q", "--revs", "--stdout")
	_ = f.Close()
	if err != nil {
		if errors.Is(read.Err(), context.DeadlineExceeded) {
			return &ErrImport{Reason: "reading the Agent's objects passed its deadline"}
		}
		return &ErrImport{Reason: "the Agent's objects of " + sha + " could not be read: " + lastLine(err)}
	}
	in, err := os.Open(pack)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	if _, err := r.Git(ctx, in, "index-pack", "--strict", "--stdin"); err != nil {
		return &ErrImport{Reason: "the Agent's objects were refused by `index-pack --strict`: " + lastLine(err)}
	}
	_ = os.Remove(pack)
	args := append([]string{"rev-list", "--objects", sha, "--not"}, have...)
	if _, err := r.Git(ctx, nil, args...); err != nil {
		return &ErrImport{Reason: "the Agent's objects of " + sha + " are not connected"}
	}
	return nil
}

var branchName = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

// ReadBranch reads refs/heads/<branch> of the Agent's repository as DATA, from its common git
// dir: the loose ref, else packed-refs. Each file is opened beneath the git dir with no symlink,
// bounded, and never by git. The value is only a claim: it is used once Import proved it names a
// commit in the Agent's store.
func ReadBranch(gitDir *os.File, branch string) (string, error) {
	if !branchName.MatchString(branch) || strings.Contains(branch, "..") || strings.HasPrefix(branch, "/") {
		return "", &ErrImport{Reason: fmt.Sprintf("%q is not a branch name jr2 reads", branch)}
	}
	if raw, err := beneath.ReadSmall(gitDir, "refs/heads/"+branch, 128); err == nil {
		sha := strings.TrimSpace(string(raw))
		if IsSha(sha) {
			return sha, nil
		}
		return "", &ErrImport{Reason: fmt.Sprintf("the Agent's branch %s does not hold a commit id", branch)}
	}
	raw, err := beneath.ReadSmall(gitDir, "packed-refs", 64<<20)
	if err != nil {
		return "", &ErrImport{Reason: fmt.Sprintf("the Agent's repository has no branch %s", branch)}
	}
	want := "refs/heads/" + branch
	for line := range strings.SplitSeq(string(raw), "\n") {
		sha, ref, ok := strings.Cut(strings.TrimSpace(line), " ")
		if ok && ref == want && IsSha(sha) {
			return sha, nil
		}
	}
	return "", &ErrImport{Reason: fmt.Sprintf("the Agent's repository has no branch %s", branch)}
}

func lastLine(err error) string {
	var ge *Error
	if errors.As(err, &ge) {
		lines := fields(ge.Stderr)
		if len(lines) > 0 {
			return lines[len(lines)-1]
		}
	}
	return err.Error()
}
