/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

// Package uploadpack is the program behind `origin`'s fetch url inside a
// Sandbox (ADR-0053). The attach sets that url to git's built-in `ext::`
// transport —
//
//	ext::/opt/jr2/bin/jr2-upload-pack %S github.com/acme/app
//
// — so every read of the remote inside the pod runs this program: `git fetch`,
// `git pull`, `git ls-remote origin`, `git fetch --dry-run`, and
// `git archive --remote=origin`. It owes no remote-helper protocol, because git
// bridges stdio and speaks its ordinary protocol to whatever is on the other
// end. The program asks the Adapter on `localhost` for a fetch of this Repo,
// waits for the landing, then execs the git server subcommand the service
// names (`upload-pack`, or `upload-archive`) against the cache and gets out of
// the way: refs update once, at the end, and what the caller sees is a fetch on
// a slow handshake.
//
// The ask never fails a fetch. A remote fetch that fails or outruns its budget
// falls through to the objects the cache already holds — ADR-0051's stance for
// attach — and writes one line to stderr, which git passes through verbatim.
// Freshness degrades, absence does not, and the caller is told.
//
// It is a static binary, the `work-acl` rule (ADR-0037): it executes on a libc
// jr2 does not control, in the Harness container, in the User Container, and in
// whatever a Sandbox Image brings.
package uploadpack

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"
)

const (
	// ServiceUploadPack serves a fetch: `git fetch`, `git pull`,
	// `git ls-remote origin`, `git fetch --dry-run`. Git substitutes the
	// service for `%S`.
	ServiceUploadPack = "git-upload-pack"
	// ServiceUploadArchive serves `git archive --remote=origin`, the other
	// read git asks a remote for. It reads the same cache directory, so
	// serving it keeps a capability the path url had (ADR-0053); a fetch of
	// the remote is asked for first, as it is for a fetch, so an archive is
	// taken of the remote's now.
	ServiceUploadArchive = "git-upload-archive"
	// DefaultAdapterURL is the Adapter on the pod's loopback — the pod's only
	// route out (ADR-0013). A composition that moved the Adapter's port passes
	// its own url as the third argument.
	DefaultAdapterURL = "http://127.0.0.1:8081"
	// askTimeout bounds the whole ask. The budget belongs to the cache agent
	// and the Orchestrator's wait (ADR-0053); this is the outermost backstop,
	// slack past theirs, so that a hung answer degrades to the cache instead
	// of hanging git forever.
	askTimeout = 90 * time.Second
	// unknownTime stands in the warning where a timestamp would be, for a
	// cache the answer could not date — because nothing has ever fetched it,
	// or because nothing answered.
	unknownTime = "an unknown time"
	// maxBodyBytes caps what is read from the Adapter's answer. The answer is
	// two fields; anything larger is a misconfiguration, and the reason text
	// lands in a human's terminal.
	maxBodyBytes = 64 << 10
	// gitBinary is looked up on PATH — the caller is git itself, so git is there,
	// and the Harness seat's PATH carries /opt/jr2/bin besides.
	gitBinary = "git"
)

// services maps a service git asks for to the git subcommand that serves it
// against a local repository. A push is not here and never will be: the push
// url is the real remote, with the caller's own credential (ADR-0005).
var services = map[string]string{
	ServiceUploadPack:    "upload-pack",
	ServiceUploadArchive: "upload-archive",
}

// repoScopedGitEnv are the variables that name the repository git is CURRENTLY
// working in. Git runs this program with `GIT_DIR` set and the worktree as
// cwd; the server git subcommand must serve the CACHE, so the caller's repo
// location is dropped from the environment it is exec'd with.
//
// `GIT_PROTOCOL` is not here because it names no repository, not because git
// hands one over: git sets `GIT_DIR`, `GIT_PREFIX`, `GIT_EXEC_PATH` and
// `GIT_EXT_SERVICE*` for an `ext::` program and nothing else, so a fetch
// through this bridge negotiates protocol v0 and pays a full ref
// advertisement of a cache that mirrors every branch and tag. Passing an
// inherited one through is what a caller who exported it asked for — git's own
// `discover_version` reads whichever version the server answers in.
var repoScopedGitEnv = []string{
	"GIT_DIR",
	"GIT_COMMON_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_INDEX_VERSION",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
	"GIT_NAMESPACE",
	"GIT_QUARANTINE_PATH",
	"GIT_SHALLOW_FILE",
	"GIT_GRAFT_FILE",
	"GIT_INTERNAL_SUPER_PREFIX",
}

// ExecFunc replaces this process with another — the real one is syscall.Exec,
// which is why nothing in this package runs after it. The seam exists so a
// test can see the argv and the environment the program would have handed the
// git server subcommand.
type ExecFunc func(path string, argv []string, env []string) error

// Options is everything the program reads from the world. Every field has a
// default, so main passes only the arguments.
type Options struct {
	// Args is argv[1:]: `<service> <identity> [adapter-url]`.
	Args []string
	// Dir is the working directory git ran the program in — the worktree
	// whose cache is being served. Defaults to the process's own.
	Dir string
	// Env is the environment to hand the git server subcommand. Defaults to
	// the process's own.
	Env []string
	// Getenv reads the fallback adapter url (`JR2_ADAPTER_URL`). Defaults to
	// os.Getenv.
	Getenv func(string) string
	// Stderr carries the one warning line git passes through. Defaults to
	// os.Stderr.
	Stderr io.Writer
	// Client asks the Adapter. Defaults to one bounded by askTimeout.
	Client *http.Client
	// Exec is the last thing the program does. Defaults to syscall.Exec.
	Exec ExecFunc
}

// Run is the program. It returns an exit code — and on the ordinary path it
// does not return at all, because Exec replaced the process.
func Run(o Options) int {
	fill(&o)

	if len(o.Args) < 2 {
		say(o, "usage: jr2-upload-pack <service> <identity> [adapter-url]\n")
		return 1
	}
	service, identity := o.Args[0], o.Args[1]
	subcommand, served := services[service]
	if !served {
		say(o, "jr2: %q is not a service this program serves — only %s and %s (a push goes to the remote's own url, ADR-0005)\n",
			service, ServiceUploadPack, ServiceUploadArchive)
		return 1
	}

	// The cache is discovered from the checkout, never from the url: the clone
	// is `--shared` off `/repos/<key>`, so its alternates file names the one
	// object store this worktree already borrows from. A url can be edited by
	// hand; the alternates cannot, without breaking the checkout itself.
	cache, err := CacheDir(o.Dir)
	if err != nil {
		say(o, "jr2: %v\n", err)
		return 1
	}

	// The ask, and then the same exec either way (ADR-0053).
	if reason, asOf := ask(o, identity); reason != "" {
		say(o, "warning: jr2: remote fetch failed (%s); serving the cache as of %s\n", oneLine(reason), asOf)
	}

	git, err := exec.LookPath(gitBinary)
	if err != nil {
		say(o, "jr2: git is not on PATH, so the cache at %s cannot be served: %v\n", cache, err)
		return 1
	}
	if err := o.Exec(git, []string{gitBinary, subcommand, cache}, servingEnv(o.Env)); err != nil {
		say(o, "jr2: could not exec %s %s %s: %v\n", git, subcommand, cache, err)
		return 1
	}
	return 0
}

// say writes ONE line to stderr — the program's whole output surface, and what
// git relays to the caller verbatim. A stderr that cannot be written to is not
// a reason to fail a fetch, so the error goes nowhere.
func say(o Options, format string, args ...any) {
	_, _ = fmt.Fprintf(o.Stderr, format, args...)
}

// ask POSTs the Adapter's `/fetch` and waits for the landing. It returns the
// empty string when the remote was fetched; otherwise the reason to warn with
// and the time the cache is as of. Every failure — transport, status, timeout,
// a stale answer — is a reason, never an error: the ask cannot fail a fetch.
func ask(o Options, identity string) (reason, asOf string) {
	body, err := json.Marshal(struct {
		Identity string `json:"identity"`
	}{identity})
	if err != nil {
		return err.Error(), unknownTime
	}
	ctx, cancel := context.WithTimeout(context.Background(), askTimeout)
	defer cancel()

	endpoint := strings.TrimSuffix(adapterURL(o), "/") + "/fetch"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err.Error(), unknownTime
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := o.Client.Do(req)
	if err != nil {
		return err.Error(), unknownTime
	}
	defer func() { _ = resp.Body.Close() }()
	read, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return fmt.Sprintf("the adapter's answer could not be read: %v", err), unknownTime
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("the adapter answered %s: %s", resp.Status, strings.TrimSpace(string(read))), unknownTime
	}
	var a answer
	if err := json.Unmarshal(read, &a); err != nil {
		return fmt.Sprintf("the adapter's answer is not the shape jr2 speaks: %v", err), unknownTime
	}
	switch {
	case a.Fetched != "":
		return "", ""
	case a.Stale != "":
		return a.Stale, timeOrUnknown(a.AsOf)
	default:
		return "the adapter's answer named neither a fetch nor a staleness", timeOrUnknown(a.AsOf)
	}
}

// answer is what the Adapter relays from the Orchestrator: one of `fetched` or
// `stale`, and for a stale one the time the cache is as of — null when nothing
// has ever fetched it.
type answer struct {
	Fetched string  `json:"fetched"`
	Stale   string  `json:"stale"`
	AsOf    *string `json:"asOf"`
}

func timeOrUnknown(ts *string) string {
	if ts == nil || strings.TrimSpace(*ts) == "" {
		return unknownTime
	}
	return *ts
}

// adapterURL: the third argument if git was given one, else `JR2_ADAPTER_URL`,
// else the loopback default. The attach passes the argument only when the
// composition moved the Adapter's port, so the ordinary url stays short.
func adapterURL(o Options) string {
	if len(o.Args) > 2 && strings.TrimSpace(o.Args[2]) != "" {
		return strings.TrimSpace(o.Args[2])
	}
	if v := strings.TrimSpace(o.Getenv("JR2_ADAPTER_URL")); v != "" {
		return v
	}
	return DefaultAdapterURL
}

// CacheDir is `/repos/<key>` for the checkout at `dir`: the common git dir's
// first alternate is the cache's object store, and the cache is its parent.
// A pod-local clone is `git clone --shared /repos/<key>` (ADR-0004), and a
// linked worktree shares that common dir, so every seat in the Project layout
// answers the same.
func CacheDir(dir string) (string, error) {
	common, err := gitCommonDir(dir)
	if err != nil {
		return "", err
	}
	alternates := filepath.Join(common, "objects", "info", "alternates")
	contents, err := os.ReadFile(alternates)
	if err != nil {
		return "", fmt.Errorf("this checkout borrows from no node cache (%s): %w", alternates, err)
	}
	objects := firstLine(string(contents))
	if objects == "" {
		return "", fmt.Errorf("this checkout borrows from no node cache (%s names none)", alternates)
	}
	// An alternate may be written relative to the borrowing repository's own
	// `objects/` directory; `git clone --shared` writes it absolute.
	if !filepath.IsAbs(objects) {
		objects = filepath.Join(common, "objects", objects)
	}
	return filepath.Dir(filepath.Clean(objects)), nil
}

// gitCommonDir asks git where the repository's shared directory is — the one
// that holds `objects/`, which for a linked worktree is NOT its own git dir.
// git is asked rather than guessed, because git is the only thing that knows
// how `.git` was spelled here (a directory, a file pointing elsewhere, or
// GIT_DIR in the environment git ran this program with).
func gitCommonDir(dir string) (string, error) {
	cmd := exec.Command(gitBinary, "rev-parse", "--git-common-dir")
	cmd.Dir = dir
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(errOut.String())
		if detail == "" {
			detail = err.Error()
		}
		return "", fmt.Errorf("%s is not a git checkout: %s", dir, oneLine(detail))
	}
	common := strings.TrimSpace(out.String())
	if common == "" {
		return "", fmt.Errorf("%s is not a git checkout: git named no common directory", dir)
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(dir, common)
	}
	return common, nil
}

// servingEnv is the environment `git upload-pack` is exec'd with: the caller's,
// minus the variables that point at the caller's own repository.
func servingEnv(env []string) []string {
	kept := make([]string, 0, len(env))
	for _, entry := range env {
		name, _, ok := strings.Cut(entry, "=")
		if ok && slices.Contains(repoScopedGitEnv, name) {
			continue
		}
		kept = append(kept, entry)
	}
	return kept
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return strings.TrimSpace(strings.TrimSuffix(line, "\r"))
}

// oneLine keeps the warning ONE line: git prints what this program writes to
// stderr verbatim, and a reason carrying a newline would read as two warnings.
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func fill(o *Options) {
	if o.Stderr == nil {
		o.Stderr = os.Stderr
	}
	if o.Getenv == nil {
		o.Getenv = os.Getenv
	}
	if o.Dir == "" {
		wd, err := os.Getwd()
		if err != nil {
			wd = "."
		}
		o.Dir = wd
	}
	if o.Env == nil {
		o.Env = os.Environ()
	}
	if o.Client == nil {
		o.Client = &http.Client{Timeout: askTimeout}
	}
	if o.Exec == nil {
		o.Exec = execProcess
	}
}

// execProcess is the real last act: this process BECOMES the git server
// subcommand, so git on the other end of the pipe talks to it directly and
// stdio needs no relay. It returns only when the exec itself failed.
func execProcess(path string, argv []string, env []string) error {
	return syscall.Exec(path, argv, env)
}
