// Package commandkind runs a credentialed `command` in the Sandbox Effector (ADR-0067): a
// command whose env names a secret. It runs against a pinned commit — the Agent's branch tip
// when it starts, or the commit `pin` names — checked out into a fresh scratch of its own by the
// push's import procedure (package gitclean), never in the live Worktree. So the Agent's
// uncommitted edits are never seen; the answer says `dirty` when there were some.
//
// What jr2 claims for this kind is three things, and not the push's fourth: the Agent never reads
// or spends the secret (the Effector is a container it cannot exec in); the tool sees a pinned
// commit and not the live Worktree; the output is scrubbed (ADR-0068). The Agent's files are the
// author's choice to run — a tool's plugins, a `local-exec`, a `credential_process` — so "no
// program the Agent's files name runs" is not claimed here.
//
// The child's env is what the author named — a secret's value, or its file's path — plus PATH and
// HOME, and nothing else: not the Effector's key, not another secret. HOME is the scratch's own.
// The scratch is removed once the outcome is read. Every outcome is output: `exited`, `timeout`,
// `killed`, `unknown`.
package commandkind

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/snapwich/jr2/effector/internal/beneath"
	"github.com/snapwich/jr2/effector/internal/gitclean"
	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// Runner runs credentialed commands for one Sandbox Effector.
type Runner struct {
	Secrets map[string]string
	// SecretsDir is where each secret is a file (/run/jr2/secrets): `.path` names a file here.
	SecretsDir string
	// WorkRoot, ReposRoot, Scratch: the Agent's work volume (read-only here), the node caches, and
	// this Effector's own writable dir.
	WorkRoot, ReposRoot, Scratch string
	Scrubber                     *scrub.Scrubber
	// ImportDeadline bounds every read of the Agent's objects. Default 120 s.
	ImportDeadline time.Duration
}

// Missing names a secret the command names that the Effector does not hold, or "".
func (r *Runner) Missing(req *wire.StartRequest) string {
	for _, name := range req.Secrets() {
		if _, ok := r.Secrets[name]; !ok {
			return name
		}
	}
	return ""
}

// Run checks the commit out, runs argv, and answers the outcome scrubbed.
func (r *Runner) Run(ctx context.Context, req *wire.StartRequest) wire.Output {
	spec := req.Command
	out := r.run(ctx, spec, time.Duration(req.TimeoutMs)*time.Millisecond)
	s := r.Scrubber
	out.Reason = s.String(out.Reason)
	if out.Command != nil {
		out.Command.Tail = s.String(out.Command.Tail)
	}
	return out
}

func unknown(reason string) wire.Output {
	return wire.Output{Outcome: wire.OutcomeUnknown, Reason: reason + "; it did not run"}
}

func (r *Runner) run(ctx context.Context, spec *wire.CommandSpec, timeout time.Duration) wire.Output {
	sha := spec.Pin
	if sha == "" {
		return unknown("the command has no pinned commit")
	}
	cache := filepath.Join(r.ReposRoot, spec.Repo.Cache)
	repo, err := gitclean.New(ctx, gitclean.Options{Scratch: r.Scratch, Caches: []string{cache}, Protocols: "none"})
	if err != nil {
		return unknown("a clean repository could not be made: " + err.Error())
	}
	// The scratch goes once the outcome is read: nothing carries to the next run.
	defer repo.Close()

	have, err := repo.CacheTips(ctx, []string{cache})
	if err != nil {
		return unknown("the Repo cache's refs could not be read")
	}
	deadline := r.ImportDeadline
	if deadline == 0 {
		deadline = 120 * time.Second
	}
	if err := repo.Import(ctx, filepath.Join(r.WorkRoot, spec.Repo.GitDir, "objects"), sha, have, deadline); err != nil {
		return unknown(err.Error())
	}
	dirty := r.dirty(ctx, repo, spec)
	tree := filepath.Join(repo.Work, "tree")
	if err := os.Mkdir(tree, 0o700); err != nil {
		return unknown(err.Error())
	}
	if _, err := repo.Git(ctx, nil, "--work-tree="+tree, "checkout", "-q", "-f", "--detach", sha); err != nil {
		return unknown("the pinned commit could not be checked out")
	}
	home := filepath.Join(repo.Work, "home")
	env := []string{"PATH=" + gitclean.Path, "HOME=" + home}
	for _, name := range slices.Sorted(maps.Keys(spec.Env)) {
		ref := spec.Env[name]
		if ref.Path {
			env = append(env, name+"="+filepath.Join(r.SecretsDir, ref.Secret))
		} else {
			env = append(env, name+"="+r.Secrets[ref.Secret])
		}
	}
	out := execute(ctx, spec.Argv, tree, env, timeout, spec.Tail)
	if out.Command != nil {
		out.Command.Dirty = dirty
	}
	return out
}

// execute runs argv in its own process group; on its timeout the group is killed.
func execute(ctx context.Context, argv []string, dir string, env []string, timeout time.Duration,
	tailLen int) wire.Output {
	cmd := exec.Command(argv[0], argv[1:]...)
	if !strings.Contains(argv[0], "/") {
		// The child's PATH is what it was given, not the Effector's.
		if p, err := lookPath(argv[0], gitclean.Path); err == nil {
			cmd.Path = p
			cmd.Err = nil
		}
	}
	cmd.Dir = dir
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var stream tailBuffer
	stream.limit = 4 * tailLen
	cmd.Stdout, cmd.Stderr = &stream, &stream
	if err := cmd.Start(); err != nil {
		return wire.Output{Outcome: wire.OutcomeExited, Command: &wire.CommandResult{Code: new(127),
			Tail: fmt.Sprintf("%s: %v\n", argv[0], err)}}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var err error
	timedOut := false
	select {
	case err = <-done:
	case <-timer.C:
		timedOut = true
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		err = <-done
	case <-ctx.Done():
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		return wire.Output{Outcome: wire.OutcomeUnknown, Reason: "the Effector stopped while it ran"}
	}
	// What the group left behind goes too.
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	tail := stream.tail(tailLen)
	if timedOut {
		return wire.Output{Outcome: wire.OutcomeTimeout, Command: &wire.CommandResult{Tail: tail}}
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		if ws, ok := exit.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return wire.Output{Outcome: wire.OutcomeKilled, Command: &wire.CommandResult{
				Signal: signalName(ws.Signal()), Tail: tail}}
		}
		code := exit.ExitCode()
		return wire.Output{Outcome: wire.OutcomeExited, Command: &wire.CommandResult{Code: &code, Tail: tail}}
	}
	if err != nil {
		return wire.Output{Outcome: wire.OutcomeUnknown, Reason: "the command's end could not be read: " + err.Error()}
	}
	return wire.Output{Outcome: wire.OutcomeExited, Command: &wire.CommandResult{Code: new(0), Tail: tail}}
}

var signalNames = map[syscall.Signal]string{
	syscall.SIGKILL: "SIGKILL", syscall.SIGTERM: "SIGTERM", syscall.SIGINT: "SIGINT", syscall.SIGHUP: "SIGHUP",
	syscall.SIGSEGV: "SIGSEGV", syscall.SIGABRT: "SIGABRT", syscall.SIGPIPE: "SIGPIPE", syscall.SIGQUIT: "SIGQUIT",
}

func signalName(s syscall.Signal) string {
	if n, ok := signalNames[s]; ok {
		return n
	}
	return fmt.Sprintf("signal %d", int(s))
}

func lookPath(name, path string) (string, error) {
	for dir := range strings.SplitSeq(path, ":") {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", exec.ErrNotFound
}

// tailBuffer keeps the end of the stream, bounded.
type tailBuffer struct {
	buf   []byte
	limit int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.limit; t.limit > 0 && over > 0 {
		t.buf = t.buf[over:]
	}
	return len(p), nil
}

// tail is the last n characters of the stream, as valid UTF-8.
func (t *tailBuffer) tail(n int) string {
	s := strings.ToValidUTF8(string(t.buf), string(utf8.RuneError))
	if r := []rune(s); len(r) > n {
		s = string(r[len(r)-n:])
	}
	return s
}

// dirty says whether the Agent's Worktree held edits that were not committed: a `git status`
// in the clean repository, over a copy of the Worktree's index, read as data. The clean config
// names no filter, no fsmonitor and no hook, so the Worktree's attributes name programs that do
// not exist here. When it cannot tell, it says dirty: the answer must not claim a clean tree it
// did not see.
func (r *Runner) dirty(ctx context.Context, repo *gitclean.Repo, spec *wire.CommandSpec) bool {
	index := filepath.Join(repo.Dir, "index")
	// The checkout that follows writes an index of its own.
	defer func() { _ = os.Remove(index) }()
	worktree, err := beneath.Dir(r.WorkRoot, spec.Repo.Worktree)
	if err != nil {
		return true
	}
	defer func() { _ = worktree.Close() }()
	gitDir, err := beneath.Dir(r.WorkRoot, spec.Repo.GitDir)
	if err != nil {
		return true
	}
	defer func() { _ = gitDir.Close() }()
	// The Worktree's `.git` file names its private git dir: worktrees/<name> under the common one.
	link, err := beneath.ReadSmall(worktree, ".git", 4096)
	if err != nil {
		return true
	}
	target := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(link)), "gitdir:"))
	common := filepath.Join(r.WorkRoot, spec.Repo.GitDir)
	rel, err := filepath.Rel(common, target)
	if err != nil || !strings.HasPrefix(rel, "worktrees/") || strings.Contains(rel, "..") {
		return true
	}
	raw, err := beneath.ReadSmall(gitDir, rel+"/index", 512<<20)
	if err != nil {
		return true
	}
	if err := os.WriteFile(index, raw, 0o600); err != nil {
		return true
	}
	if _, err := repo.Git(ctx, nil, "update-ref", "--no-deref", "HEAD", spec.Pin); err != nil {
		return true
	}
	out, err := repo.Git(ctx, nil, "--work-tree="+filepath.Join(r.WorkRoot, spec.Repo.Worktree),
		"-c", "core.untrackedCache=false", "-c", "status.showUntrackedFiles=normal",
		"status", "--porcelain=v1", "--ignore-submodules=all", "--no-renames")
	if err != nil {
		return true
	}
	return len(bytes.TrimSpace(out)) > 0
}
