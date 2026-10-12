// Package commandkind runs a credentialed `command` in the Sandbox Effector (ADR-0067): a
// command whose env names a secret. It runs against a pinned commit — the Agent's branch tip
// when it starts, or the commit `pin` names — checked out into a fresh scratch of its own by the
// push's import procedure (package gitclean), never in the live Worktree. So the Agent's
// uncommitted edits are never seen; the answer says `dirty` when there were some.
//
// The child runs as the Effector's uid, beside the Effector's key, the secrets the command does
// not name and the push credentials; its program is often the Agent's code. So it is confined
// with Landlock before execve (package confine; ADR-0068): the Effector runs its own binary
// as the confiner, under the Effect's keeper, and the child may read and run the image's system
// paths, read and write its own scratch, and read the secret files it names — nothing else; not
// /tmp, which every child would share (ADR-0068 rule 3). The tool sees a pinned commit and not the
// live Worktree, and the output is scrubbed. The Agent's files are the author's
// choice to run — a tool's plugins, a `local-exec`, a `credential_process` — so "no program the
// Agent's files name runs" is not claimed here.
//
// The child's env is what the author named — a secret's value, or its file's path — plus PATH,
// HOME and TMPDIR, and nothing else: not the Effector's key, not another secret. PATH is the
// Effector's own, which its image set (the tools are the author's); HOME and TMPDIR are the
// scratch's own. The child runs under a keeper of its Effect's own, which starts its own session,
// registered with its Effect's process groups, and is the subreaper of what the child starts
// (package reaper): a daemon the child starts is its Effect's while that Effect is live, and when
// the Effect settles, no descendant of it is left.
// A stop (`DELETE /effects/<id>`: its state exited) cancels the run with wire.ErrStopped: the
// group gets SIGTERM, then SIGKILL past StopGrace, and the outcome is `exited` with the signal.
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
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/snapwich/jr2/effector/internal/beneath"
	"github.com/snapwich/jr2/effector/internal/confine"
	"github.com/snapwich/jr2/effector/internal/gitclean"
	"github.com/snapwich/jr2/effector/internal/reaper"
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
	// Path is the child's PATH, and where argv[0] is looked up: the Effector's own, as its image
	// set it. Default gitclean.Path.
	Path string
	// ImportDeadline bounds every read of the Agent's objects. Default 120 s.
	ImportDeadline time.Duration
	// Confiner is the binary that confines the child and execs it (`<Confiner> confine ...`): the
	// Effector's own.
	Confiner string
	// Deny is what the child may not reach, beside what no rule names: the Effector's key and
	// config, its secrets and push credentials, the Worktree, the node caches, its whole scratch.
	Deny []string
	// Unconfinable, when set, is why this node cannot confine a child (the Landlock probe's
	// answer): a credentialed command is then refused before it runs.
	Unconfinable string
}

// Missing names a secret the command names that the Effector does not hold, or why no child can
// run here, or "".
func (r *Runner) Missing(req *wire.StartRequest) string {
	if r.Unconfinable != "" {
		return "a credentialed command, whose child this node cannot confine: " + r.Unconfinable
	}
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
	// The scratch goes once the outcome is read: nothing of it carries to the next run — the
	// child's TMPDIR included, which is in it (ADR-0068 rule 3).
	defer repo.Close()

	have, err := repo.CacheTips(ctx, []string{cache})
	if err != nil {
		return unknown("the Repo cache's refs could not be read")
	}
	deadline := r.ImportDeadline
	if deadline == 0 {
		deadline = 120 * time.Second
	}
	objects := filepath.Join(r.WorkRoot, spec.Repo.GitDir, "objects")
	if err := repo.Import(ctx, objects, sha, have, deadline); err != nil {
		return unknown(err.Error())
	}
	dirty := r.dirty(ctx, repo, spec, func(head string) error {
		return repo.Import(ctx, objects, head, append(slices.Clone(have), sha), deadline)
	})
	tree := filepath.Join(repo.Work, "tree")
	if err := os.Mkdir(tree, 0o700); err != nil {
		return unknown(err.Error())
	}
	if _, err := repo.Git(ctx, nil, "--work-tree="+tree, "checkout", "-q", "-f", "--detach", sha); err != nil {
		return unknown("the pinned commit could not be checked out")
	}
	home := filepath.Join(repo.Work, "home")
	tmp := filepath.Join(repo.Work, "tmp")
	if err := os.Mkdir(tmp, 0o700); err != nil {
		return unknown(err.Error())
	}
	path := r.Path
	if path == "" {
		path = gitclean.Path
	}
	env := []string{"PATH=" + path, "HOME=" + home, "TMPDIR=" + tmp}
	var named []string
	for _, name := range slices.Sorted(maps.Keys(spec.Env)) {
		ref := spec.Env[name]
		file := filepath.Join(r.SecretsDir, ref.Secret)
		named = append(named, file)
		if ref.Path {
			env = append(env, name+"="+file)
		} else {
			env = append(env, name+"="+r.Secrets[ref.Secret])
		}
	}
	rules, err := confine.ForCommand(realPaths(r.Deny), realPath(repo.Work), named)
	if err != nil {
		return unknown("the child's confinement could not be read: " + err.Error())
	}
	out := execute(ctx, r.Confiner, rules, spec.Argv, tree, env, path, timeout, spec.Tail, r.Scrubber)
	if out.Command != nil {
		out.Command.Dirty = dirty
	}
	return out
}

// realPaths is each path with its links resolved, as a Landlock rule sees it; one that does not
// exist is kept as written.
func realPaths(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		out = append(out, realPath(p))
	}
	return out
}

func realPath(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	return p
}

// execute runs argv, confined by rules, under its Effect's own keeper (package reaper, ADR-0068 rule 1):
// the keeper leads a session and process group of its own, registered with the Effect's, and is
// the subreaper of everything argv starts, so a daemon argv leaves behind is the keeper's while
// the Effect is live and never another Effect's stray. The confiner is the process the keeper
// starts: it restricts itself and execs argv, so no instruction of argv runs unconfined. On the
// timeout the group is killed; what the keeper held is then the Effector's, and the settle kills
// it. A descendant that holds the stream open does not hold the outcome: past WaitDelay the
// stream is closed. The stream is scrubbed as it arrives, across chunk borders, BEFORE it is cut
// to its tail: a secret that straddles the cut was replaced whole before the cut could split it.
func execute(ctx context.Context, confiner string, rules confine.Rules, argv []string, dir string, env []string,
	path string, timeout time.Duration, tailLen int, scrubber *scrub.Scrubber) wire.Output {
	if errors.Is(context.Cause(ctx), wire.ErrStopped) {
		return unknown("its state exited before the command started")
	}
	program := argv[0]
	if !strings.Contains(program, "/") {
		// Looked up in the PATH the child is given.
		p, err := lookPath(program, path)
		if err != nil {
			return wire.Output{Outcome: wire.OutcomeExited, Command: &wire.CommandResult{Code: new(127),
				Tail: fmt.Sprintf("%s: %v\n", program, err)}}
		}
		program = p
	}
	confined := append([]string{confiner, "confine"}, rules.Args(program, argv)...)
	cmd := exec.Command(confiner, reaper.KeepArgs(confiner, confined)...)
	cmd.Dir = dir
	cmd.Env = env
	stream := &tailBuffer{limit: 4 * tailLen, scrub: scrubber.Stream()}
	cmd.Stdout, cmd.Stderr = stream, stream
	cmd.WaitDelay = time.Second
	report, status, err := os.Pipe()
	if err != nil {
		return unknown("the command's status pipe could not be made: " + err.Error())
	}
	defer func() { _ = report.Close() }()
	cmd.ExtraFiles = []*os.File{status}
	err = reaper.Start(ctx, cmd)
	_ = status.Close()
	if err != nil {
		return wire.Output{Outcome: wire.OutcomeExited, Command: &wire.CommandResult{Code: new(127),
			Tail: fmt.Sprintf("%s: %v\n", argv[0], err)}}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	timedOut := false
	// stopped is the last signal a stop sent the group (the stop route, ADR-0067), or "".
	stopped := ""
	select {
	case err = <-done:
	case <-timer.C:
		timedOut = true
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		err = <-done
	case <-ctx.Done():
		if !errors.Is(context.Cause(ctx), wire.ErrStopped) {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			<-done
			return wire.Output{Outcome: wire.OutcomeUnknown, Reason: "the Effector stopped while it ran"}
		}
		stopped, err = stop(cmd.Process.Pid, done)
	}
	// What the group left behind goes too.
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	tail := stream.tail(tailLen)
	if timedOut {
		return wire.Output{Outcome: wire.OutcomeTimeout, Command: &wire.CommandResult{Tail: tail}}
	}
	// The child's own end, as its keeper read it; a keeper that wrote none was killed, and its own
	// end is the answer.
	ws, kept := reaper.KeptStatus(report)
	if !kept {
		var exit *exec.ExitError
		switch {
		case errors.As(err, &exit):
			ws, kept = exit.Sys().(syscall.WaitStatus)
		case err != nil && !errors.Is(err, exec.ErrWaitDelay):
			return wire.Output{Outcome: wire.OutcomeUnknown, Reason: "the command's end could not be read: " + err.Error()}
		}
	}
	if !kept {
		return wire.Output{Outcome: wire.OutcomeUnknown, Reason: "the command's end could not be read"}
	}
	if stopped != "" {
		return stoppedOutput(ws, stopped, tail)
	}
	if ws.Signaled() {
		return wire.Output{Outcome: wire.OutcomeKilled, Command: &wire.CommandResult{
			Signal: signalName(ws.Signal()), Tail: tail}}
	}
	code := ws.ExitStatus()
	return wire.Output{Outcome: wire.OutcomeExited, Command: &wire.CommandResult{Code: &code, Tail: tail}}
}

// StopGrace is how long a stopped command's group has, after SIGTERM, before SIGKILL.
const StopGrace = 5 * time.Second

// stop ends a command whose state exited (the stop route, ADR-0067): SIGTERM to the keeper's
// process group — the child's to answer; the keeper catches it and waits, so the child's own end is
// still reported — then SIGKILL to the group if it still runs after StopGrace. It answers the
// last signal it sent and the keeper's end; the Effect's settle then ends whatever left the group.
func stop(pgid int, done <-chan error) (string, error) {
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	grace := time.NewTimer(StopGrace)
	defer grace.Stop()
	select {
	case err := <-done:
		return signalName(syscall.SIGTERM), err
	case <-grace.C:
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		return signalName(syscall.SIGKILL), <-done
	}
}

// stoppedOutput is a stopped command's outcome (ADR-0067): `exited` with the signal the stop sent
// last — SIGTERM, or SIGKILL past the grace — and the program's code when it caught SIGTERM and
// exited with one.
func stoppedOutput(ws syscall.WaitStatus, signal, tail string) wire.Output {
	r := &wire.CommandResult{Signal: signal, Tail: tail}
	if !ws.Signaled() {
		code := ws.ExitStatus()
		r.Code = &code
	}
	return wire.Output{Outcome: wire.OutcomeExited, Command: r}
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

// tailBuffer keeps the end of the stream, bounded, scrubbed before it is bounded. Stdout and
// stderr are one writer, which exec serializes only when they are the same value: it takes a
// lock all the same.
type tailBuffer struct {
	mu    sync.Mutex
	buf   []byte
	limit int
	scrub *scrub.Stream
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.keep(t.scrub.Write(p))
	return len(p), nil
}

func (t *tailBuffer) keep(p []byte) {
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.limit; t.limit > 0 && over > 0 {
		t.buf = t.buf[over:]
	}
}

// tail is the last n characters of the stream, as valid UTF-8: what the scrubber held back is
// scrubbed and kept first.
func (t *tailBuffer) tail(n int) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.keep(t.scrub.Flush())
	s := strings.ToValidUTF8(string(t.buf), string(utf8.RuneError))
	if r := []rune(s); len(r) > n {
		s = string(r[len(r)-n:])
	}
	return s
}

// dirty says whether the Agent's Worktree held edits that were not committed: a `git status`
// in the clean repository, over a copy of the Worktree's index, against the Worktree's OWN HEAD
// (read as data, and imported by importHead when it is not the pinned commit) — never against the
// pin, so the commits the Agent made after an approved one are not edits. The clean config names
// no filter, no fsmonitor and no hook, so the Worktree's attributes name programs that do not
// exist here. When it cannot tell, it says dirty: the answer must not claim a clean tree it did
// not see.
func (r *Runner) dirty(ctx context.Context, repo *gitclean.Repo, spec *wire.CommandSpec,
	importHead func(head string) error) bool {
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
	head, err := worktreeHead(gitDir, rel)
	if err != nil {
		return true
	}
	if head != spec.Pin {
		if err := importHead(head); err != nil {
			return true
		}
	}
	raw, err := beneath.ReadSmall(gitDir, rel+"/index", 512<<20)
	if err != nil {
		return true
	}
	if err := os.WriteFile(index, raw, 0o600); err != nil {
		return true
	}
	if _, err := repo.Git(ctx, nil, "update-ref", "--no-deref", "HEAD", head); err != nil {
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

// worktreeHead reads the Worktree's HEAD as data, from its private git dir: a commit id, or the
// branch it names, read as ReadBranch reads one.
func worktreeHead(gitDir *os.File, private string) (string, error) {
	raw, err := beneath.ReadSmall(gitDir, private+"/HEAD", 512)
	if err != nil {
		return "", err
	}
	line := strings.TrimSpace(string(raw))
	if ref, ok := strings.CutPrefix(line, "ref: refs/heads/"); ok {
		return gitclean.ReadBranch(gitDir, ref)
	}
	if gitclean.IsSha(line) {
		return line, nil
	}
	return "", errors.New("the Worktree's HEAD names no commit")
}
