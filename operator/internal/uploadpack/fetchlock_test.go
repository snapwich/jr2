/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package uploadpack

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// noHolder leaves no process behind. The lock ends when lockFetches closes the
// file, so a test binary never runs as a holder.
func noHolder(*os.File, process) error { return nil }

// thisProcess stands in for the fetch in a test that runs the program in
// process, where no `git remote-ext` is the parent.
func thisProcess() (process, bool) {
	self, err := readProcess(os.Getpid())
	return self, err == nil
}

func lockPath(p pod) string { return filepath.Join(p.dflt, ".git", fetchLockFile) }

func tryLock(t *testing.T, path string) bool {
	t.Helper()
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o666)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err != nil && !errors.Is(err, syscall.EWOULDBLOCK) {
		t.Fatal(err)
	}
	return err == nil
}

func holdFile(t *testing.T, path string) *os.File {
	t.Helper()
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o666)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	return f
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("after 5s: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func runWith(t *testing.T, p pod, service string, wait time.Duration, held func(*os.File, process) error) *exec1 {
	t.Helper()
	return runAs(t, p, service, wait, thisProcess, held)
}

func runAs(t *testing.T, p pod, service string, wait time.Duration, fetch func() (process, bool), held func(*os.File, process) error) *exec1 {
	t.Helper()
	server, _ := custodian(t, http.StatusOK, map[string]any{keyFetched: someTime})
	e := &exec1{}
	code := Run(Options{
		Args: []string{service, identity, server.URL}, Dir: p.worktree,
		Getenv: func(string) string { return "" }, Stderr: &bytes.Buffer{}, Client: server.Client(),
		Exec: e.fn, Hold: held, Fetch: fetch, LockWait: wait,
	})
	if code != 0 || !e.ran {
		t.Fatalf("exit %d, exec'd %v: the lock must not fail a fetch", code, e.ran)
	}
	return e
}

func TestAFetchTakesTheLockInTheCommonDirAndLeavesItWithTheHolder(t *testing.T) {
	p := layout(t)
	var held atomic.Int32
	runWith(t, p, ServiceUploadPack, time.Second, func(lock *os.File, fetch process) error {
		held.Add(1)
		if lock.Name() != lockPath(p) {
			t.Errorf("the lock is %q, want %q", lock.Name(), lockPath(p))
		}
		if tryLock(t, lockPath(p)) {
			t.Error("the lock was free when the holder got it")
		}
		return nil
	})
	if held.Load() != 1 {
		t.Fatalf("the holder started %d times, want 1", held.Load())
	}
}

func TestAnArchiveTakesNoLock(t *testing.T) {
	p := layout(t)
	runWith(t, p, ServiceUploadArchive, time.Second, func(*os.File, process) error {
		t.Error("an archive writes no refs, so it needs no lock")
		return nil
	})
}

func TestAFetchThatCannotTakeTheLockStillServes(t *testing.T) {
	refuse := func(t *testing.T) func(*os.File, process) error {
		return func(*os.File, process) error {
			t.Error("no lock was taken, so nothing is held")
			return nil
		}
	}
	t.Run("the wait ends", func(t *testing.T) {
		p := layout(t)
		holdFile(t, lockPath(p))
		runWith(t, p, ServiceUploadPack, 30*time.Millisecond, refuse(t))
	})
	t.Run("the lock file does not open", func(t *testing.T) {
		p := layout(t)
		if err := os.Mkdir(lockPath(p), 0o755); err != nil {
			t.Fatal(err)
		}
		runWith(t, p, ServiceUploadPack, time.Second, refuse(t))
	})
	t.Run("the holder does not start", func(t *testing.T) {
		p := layout(t)
		runWith(t, p, ServiceUploadPack, time.Second, func(*os.File, process) error {
			return errors.New("no fork")
		})
		if !tryLock(t, lockPath(p)) {
			t.Fatal("a holder that did not start must leave the lock free")
		}
	})
}

// This test binary's parent is no `git remote-ext`, so the real fetchProcess
// finds no fetch, as for an orphan or a direct run. A holder of such a process
// would watch a process that can live forever.
func TestAProgramWithNoFetchAboveItTakesNoLock(t *testing.T) {
	p := layout(t)
	runAs(t, p, ServiceUploadPack, time.Second, nil, func(*os.File, process) error {
		t.Error("there is no fetch to end the lock")
		return nil
	})
}

// blockingCustodian answers no ask until the test calls release, as for a dead
// remote. Each ask sends on the channel when it arrives.
func blockingCustodian(t *testing.T) (*httptest.Server, <-chan struct{}, func()) {
	t.Helper()
	asked := make(chan struct{}, 1)
	released := make(chan struct{})
	release := sync.OnceFunc(func() { close(released) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		asked <- struct{}{}
		<-released
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"fetched":"` + someTime + `"}`))
	}))
	t.Cleanup(server.Close)
	t.Cleanup(release)
	return server, asked, release
}

func awaitAsk(t *testing.T, asked <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-asked:
	case <-time.After(5 * time.Second):
		t.Fatal(what)
	}
}

// A dead remote must not make coders wait in line, so a fetch asks while another
// fetch holds the lock, and joins the line only when the ask has ended.
func TestAFetchAsksBeforeItWaitsInLine(t *testing.T) {
	p := layout(t)
	line := holdFile(t, lockPath(p))
	server, asked, release := blockingCustodian(t)
	var held atomic.Int32
	done := make(chan int, 1)
	go func() {
		done <- Run(Options{
			Args: []string{ServiceUploadPack, identity, server.URL}, Dir: p.worktree,
			Getenv: func(string) string { return "" }, Stderr: &bytes.Buffer{}, Client: server.Client(),
			Exec: (&exec1{}).fn, Fetch: thisProcess, LockWait: lockWait,
			Hold: func(*os.File, process) error { held.Add(1); return nil },
		})
	}()
	awaitAsk(t, asked, "the ask waited behind the lock")
	release()
	_ = line.Close()
	if code := <-done; code != 0 {
		t.Fatalf("exit %d", code)
	}
	if held.Load() != 1 {
		t.Fatalf("the holder started %d times, want 1", held.Load())
	}
}

func TestTheStatLineIsReadPastAnyCommandName(t *testing.T) {
	tail := strings.Repeat(" 0", 12) + " 4242 0 0"
	got, err := parseStat(7, []byte("7 (a b) (c)) S 3 7 7 0 -1 0"+tail+"\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got.state != "S" || got.ppid != 3 || got.start != "4242" {
		t.Fatalf("parsed %+v", got)
	}
	if _, err := parseStat(7, []byte("7 (x) S 3")); err == nil {
		t.Fatal("a short line must be an error")
	}
}

func TestOnlyGitParentsNameTheFetch(t *testing.T) {
	for argv, want := range map[string]bool{
		"git\x00remote-ext\x00origin":      true,
		"/usr/bin/git\x00remote-ext":       true,
		"/usr/lib/git-core/git-remote-ext": true,
		"git\x00fetch":                     false,
		"node\x00remote-ext":               false,
	} {
		if got := isRemoteExt(strings.Split(argv, "\x00")); got != want {
			t.Errorf("isRemoteExt(%q) = %v", argv, got)
		}
	}
}

func TestThePollSeesAnExitAndAZombieAndALaterProcess(t *testing.T) {
	self, err := readProcess(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if !self.alive() {
		t.Fatal("this process is alive")
	}
	if (process{pid: self.pid, start: "1"}).alive() {
		t.Fatal("another start time is another process")
	}
	cmd := exec.Command("true")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Wait() }()
	child := process{pid: cmd.Process.Pid}
	if child, err = readProcess(child.pid); err != nil {
		t.Skip("the child was gone before the read")
	}
	eventually(t, "a zombie must not count as alive", func() bool { return !child.alive() })
	pollExit(child)
}

// The built program, so each test below runs what a pod runs.
func buildProgram(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "jr2-upload-pack")
	build := exec.Command("go", "build", "-o", bin, "../../cmd/jr2-upload-pack")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("the program does not build: %v\n%s", err, out)
	}
	return bin
}

// startedHolder runs the built program as the holder of the lock of a process
// that stands in for the fetch. On return, only the holder has the lock. The
// channel gets the result of the holder's exit.
func startedHolder(t *testing.T, p pod, bin string) (fetch *exec.Cmd, holder *exec.Cmd, ended <-chan error) {
	t.Helper()
	fetch = exec.Command("sleep", "60")
	if err := fetch.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fetch.Process.Kill(); _ = fetch.Wait() })
	seen, err := readProcess(fetch.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	lock := holdFile(t, lockPath(p))
	holder = exec.Command(bin, HoldCommand, strconv.Itoa(seen.pid), seen.start)
	holder.ExtraFiles = []*os.File{lock}
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = holder.Process.Kill() })
	done := make(chan error, 1)
	go func() { done <- holder.Wait() }()
	_ = lock.Close()
	return fetch, holder, done
}

func TestTheHolderEndsWhenTheFetchDies(t *testing.T) {
	p := layout(t)
	fetch, _, ended := startedHolder(t, p, buildProgram(t))

	time.Sleep(100 * time.Millisecond)
	if tryLock(t, lockPath(p)) {
		t.Fatal("the lock was free while the fetch ran")
	}
	if err := fetch.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-ended:
		if err != nil {
			t.Fatalf("the holder: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the holder outlived the fetch")
	}
	if !tryLock(t, lockPath(p)) {
		t.Fatal("the lock outlived the holder")
	}
}

// Each fetch in line waits for the holder of the fetch before it, so a slow wake
// costs seconds under load. The kill comes well after the holder starts, so a
// poll with a period of a second wakes far past the bound, in each round. The
// best round is the one that counts: a loaded host can delay any one round.
func TestTheLockIsFreeSoonAfterTheFetchEnds(t *testing.T) {
	const rounds, bound = 5, 300 * time.Millisecond
	p := layout(t)
	bin := buildProgram(t)
	best := time.Hour
	for range rounds {
		fetch, _, ended := startedHolder(t, p, bin)
		time.Sleep(100 * time.Millisecond)
		killed := time.Now()
		if err := fetch.Process.Kill(); err != nil {
			t.Fatal(err)
		}
		eventually(t, "the lock must end with the fetch", func() bool { return tryLock(t, lockPath(p)) })
		best = min(best, time.Since(killed))
		<-ended
	}
	if best > bound {
		t.Fatalf("the lock was free %v after the kill at best, want at most %v", best, bound)
	}
}

// mover is the remote and the node cache as one repository, behind the program's
// real ask. A cache that many coders push to moves all the time, so the commits
// land from their own loop and not from the ask.
type mover struct {
	t     *testing.T
	cache string
	asks  atomic.Int32
	tag   sync.Once
	tags  bool
	moved int
}

func (m *mover) out(dir string, args ...string) string {
	m.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_AUTHOR_NAME=jr2", "GIT_AUTHOR_EMAIL=jr2@example.invalid",
		"GIT_COMMITTER_NAME=jr2", "GIT_COMMITTER_EMAIL=jr2@example.invalid")
	out, err := cmd.CombinedOutput()
	if err != nil {
		m.t.Errorf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func (m *mover) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	m.asks.Add(1)
	if m.tags {
		m.tag.Do(func() {
			// Tags on a commit that is not a tip: with no alternates, git would
			// follow them on a second connection.
			m.commit("main")
			m.out(m.cache, "tag", "v1", "main")
			m.out(m.cache, "tag", "-a", "-m", "v2", "v2", "main")
			m.commit("main")
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"fetched":"` + someTime + `"}`))
}

func (m *mover) commit(branches ...string) {
	m.moved++
	var updates strings.Builder
	tree := m.out(m.cache, "rev-parse", "main^{tree}")
	commit := m.out(m.cache, "commit-tree", tree, "-m", fmt.Sprintf("move %d", m.moved))
	for _, branch := range branches {
		fmt.Fprintf(&updates, "update refs/heads/%s %s\n", branch, commit)
	}
	cmd := exec.Command("git", "update-ref", "--stdin")
	cmd.Dir = m.cache
	cmd.Stdin = strings.NewReader(updates.String())
	if out, err := cmd.CombinedOutput(); err != nil {
		m.t.Errorf("update-ref: %v\n%s", err, out)
	}
}

// churn moves the branches until the context ends.
func (m *mover) churn(ctx context.Context, branches []string) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ctx.Err() == nil {
			m.commit(branches...)
		}
	}()
	return done
}

// fetchThrough sets the clone's fetch url to the built program, as the attach
// does, and returns the environment for a fetch.
func fetchThrough(t *testing.T, p pod, custodianURL string) []string {
	t.Helper()
	bin := buildProgram(t)
	git(t, p.dflt, "config", "protocol.ext.allow", "user")
	git(t, p.dflt, "remote", "set-url", "origin", "ext::"+bin+" %S "+identity+" "+custodianURL)
	return []string{"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null"}
}

func movingClone(t *testing.T, tag bool) (pod, *mover, []string) {
	t.Helper()
	p := layout(t)
	m := &mover{t: t, cache: p.cache, tags: tag}
	server := httptest.NewServer(m)
	t.Cleanup(server.Close)
	return p, m, fetchThrough(t, p, server.URL)
}

func fetchIn(ctx context.Context, dir string, env []string, flags ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"fetch", "--prune", "origin"}, flags...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	// A process that keeps the output open after the fetch ends cannot stop a
	// test: this ends the wait.
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	return out.Bytes(), err
}

func TestOverlappingFetchesOnAMovingRemoteDoNotLoseARace(t *testing.T) {
	const coders, rounds = 8, 6
	p, m, env := movingClone(t, false)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	trees := make([]string, coders)
	for i := range trees {
		trees[i] = filepath.Join(filepath.Dir(p.dflt), fmt.Sprintf("coder-%d", i))
		git(t, p.dflt, "worktree", "add", "-q", trees[i], "-b", fmt.Sprintf("coder-%d", i))
	}
	branches := make([]string, 40)
	for i := range branches {
		branches[i] = fmt.Sprintf("topic-%d", i)
	}
	churning, stop := context.WithCancel(ctx)
	defer stop()
	stopped := m.churn(churning, branches)

	var wg sync.WaitGroup
	failures := make(chan string, coders*rounds)
	for _, tree := range trees {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range rounds {
				if out, err := fetchIn(ctx, tree, env); err != nil {
					failures <- fmt.Sprintf("%v: %s", err, out)
				}
			}
		}()
	}
	wg.Wait()
	stop()
	<-stopped
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
	if got, want := int(m.asks.Load()), coders*rounds; got < want {
		t.Fatalf("%d asks, want at least %d: the fetches did not run through the program", got, want)
	}
	eventually(t, "the last holder must end with the last fetch", func() bool { return tryLock(t, lockPath(p)) })
}

// A fetch that takes a pack ends the connection, so `git upload-pack` and
// `git remote-ext` have ended when it writes its refs. The lock must outlive
// them. A depth forces a pack, because the alternates otherwise hold each object
// and git then keeps the connection open to the end. A hook pauses the fetch at
// its ref write.
func TestTheLockLastsUntilTheFetchHasWrittenItsRefs(t *testing.T) {
	p, m, env := movingClone(t, false)
	m.commit("main")
	reached := filepath.Join(t.TempDir(), "reached")
	release := filepath.Join(t.TempDir(), "release")
	hook := "#!/bin/sh\ncat >/dev/null\n[ \"$1\" = prepared ] || exit 0\n: >" + reached +
		"\nwhile [ ! -e " + release + " ]; do sleep 0.01; done\n"
	if err := os.WriteFile(filepath.Join(p.dflt, ".git", "hooks", "reference-transaction"), []byte(hook), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), lockWait)
	defer cancel()
	ended := make(chan error, 1)
	go func() {
		out, err := fetchIn(ctx, p.worktree, env, "--depth=1")
		if err != nil {
			err = fmt.Errorf("%w: %s", err, out)
		}
		ended <- err
	}()
	eventually(t, "the fetch must reach its ref write", func() bool {
		_, err := os.Stat(reached)
		return err == nil
	})
	free := tryLock(t, lockPath(p))
	// The fetch's stdout and stderr are pipes whose readers wait for the end, so
	// the holder must keep neither of them, nor the program's.
	stdio := holderStdio(t, lockPath(p))
	if err := os.WriteFile(release, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := <-ended; err != nil {
		t.Fatal(err)
	}
	if free {
		t.Fatal("the lock was free while the fetch wrote its refs")
	}
	for fd, target := range stdio {
		if target != os.DevNull {
			t.Errorf("the holder keeps descriptor %d open on %q", fd, target)
		}
	}
	eventually(t, "the lock must end with the fetch", func() bool { return tryLock(t, lockPath(p)) })
}

// holderStdio reads where descriptors 0 to 2 of the holder of a lock file go. The
// lock file is in a temp dir of this test, so descriptor 3 names one process.
func holderStdio(t *testing.T, lock string) []string {
	t.Helper()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		argv := argvOf(pid)
		if len(argv) < 2 || argv[1] != HoldCommand {
			continue
		}
		fd := fmt.Sprintf("/proc/%d/fd/", pid)
		if target, err := os.Readlink(fd + "3"); err != nil || target != lock {
			continue
		}
		stdio := make([]string, 3)
		for i := range stdio {
			if stdio[i], err = os.Readlink(fd + strconv.Itoa(i)); err != nil {
				t.Fatal(err)
			}
		}
		return stdio
	}
	t.Fatal("no holder has the lock")
	return nil
}

func childOf(t *testing.T, parent int, match func(argv []string) bool) process {
	t.Helper()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		if child, err := readProcess(pid); err == nil && child.ppid == parent && match(argvOf(pid)) {
			return child
		}
	}
	t.Fatalf("process %d has no such child", parent)
	return process{}
}

// A kill of the git processes can reach `git fetch`, with or without
// `git remote-ext`, and not this program, which an init process then adopts or
// which then has an orphan as its parent. The program must not give the lock to a
// holder that watches that init process: the lock would stay taken for the life of
// the pod, and each later fetch would wait out lockWait. The lock is also free for
// all of the ask, which the built program shows here.
func TestALockDoesNotOutliveAFetchThatDiesInTheAsk(t *testing.T) {
	for name, kill := range map[string]func(t *testing.T, fetch *exec.Cmd, remoteExt process){
		"with its remote-ext": func(t *testing.T, fetch *exec.Cmd, remoteExt process) {
			if err := syscall.Kill(remoteExt.pid, syscall.SIGKILL); err != nil {
				t.Fatal(err)
			}
			if err := fetch.Process.Kill(); err != nil {
				t.Fatal(err)
			}
		},
		// The orphan is a `git remote-ext` whose parent is the init process, so
		// the program must also look at the parent of that orphan.
		"alone": func(t *testing.T, fetch *exec.Cmd, remoteExt process) {
			if err := fetch.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			eventually(t, "the fetch must leave an orphan", func() bool {
				now, err := readProcess(remoteExt.pid)
				return err == nil && now.ppid != fetch.Process.Pid
			})
			if !remoteExt.alive() {
				t.Fatal("the remote-ext ended with the fetch, so this case shows nothing")
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			p := layout(t)
			server, asked, release := blockingCustodian(t)
			env := fetchThrough(t, p, server.URL)
			fetch := exec.Command("git", "fetch", "origin")
			fetch.Dir = p.worktree
			fetch.Env = append(os.Environ(), env...)
			if err := fetch.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = fetch.Process.Kill(); _ = fetch.Wait() }()
			awaitAsk(t, asked, "the fetch must reach the ask")
			if !tryLock(t, lockPath(p)) {
				t.Fatal("the lock was taken during the ask")
			}

			remoteExt := childOf(t, fetch.Process.Pid, isRemoteExt)
			program := childOf(t, remoteExt.pid, func([]string) bool { return true })
			kill(t, fetch, remoteExt)
			release()
			eventually(t, "the program must end", func() bool { return !program.alive() })
			eventually(t, "the lock must not outlive the fetch", func() bool { return tryLock(t, lockPath(p)) })
		})
	}
}

// A cut fetches while it holds its own lock, and a fetch never takes that lock.
func TestAFetchRunsUnderTheCutsLock(t *testing.T) {
	p, _, env := movingClone(t, false)
	holdFile(t, filepath.Join(p.dflt, ".git", "jr2-cut.lock"))
	ctx, cancel := context.WithTimeout(context.Background(), lockWait)
	defer cancel()
	if out, err := fetchIn(ctx, p.worktree, env); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
}

// A second connection of one fetch would wait behind its own lock until
// lockWait. The alternates hold each object that the cache advertises, so git
// follows these tags on the first connection. This test fails if a git version
// changes that.
func TestAFetchThatFollowsATagOpensOneConnection(t *testing.T) {
	p, m, env := movingClone(t, true)
	ctx, cancel := context.WithTimeout(context.Background(), lockWait)
	defer cancel()

	if out, err := fetchIn(ctx, p.worktree, env); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if got := m.asks.Load(); got != 1 {
		t.Fatalf("%d asks, want 1: a second connection waits behind the first", got)
	}
	git(t, p.dflt, "rev-parse", "--verify", "refs/tags/v1")
	git(t, p.dflt, "rev-parse", "--verify", "refs/tags/v2")
}
