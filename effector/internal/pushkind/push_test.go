package pushkind

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/gitclean"
	"github.com/snapwich/jr2/effector/internal/gittest"
	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// TestMain lets the test binary be the credential helper, as the Effector binary is in a pod.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "git-credential" {
		// syscall.Exit, not os.Exit: under -coverprofile the test binary's exit hook writes
		// "GOCOVERDIR not set" to stderr, into the output the test reads. The Effector's binary has no such hook.
		syscall.Exit(Helper(os.Args[2:], os.Stdin, os.Stdout))
	}
	os.Exit(m.Run())
}

const (
	signerName  = "jr2 bot"
	signerEmail = "bot@example.test"
)

type fixture struct {
	t      *testing.T
	pod    *gittest.Pod
	runner *Runner
	signer string // the signing key's public half
}

func newFixture(t *testing.T, sign string) *fixture {
	t.Helper()
	p := gittest.NewPod(t, "jr2/work")
	gitRoot := filepath.Join(p.Root, "git")
	entry := secrets.GitEntry{Match: "*", Push: &secrets.GitAuth{Token: "push"}}
	f := &fixture{t: t, pod: p}
	if err := os.MkdirAll(filepath.Join(gitRoot, "push"), 0o700); err != nil {
		t.Fatal(err)
	}
	switch sign {
	case "ssh":
		dir := filepath.Join(gitRoot, "sign")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		run(t, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", signerEmail, "-f", filepath.Join(dir, secrets.SignSSHFile))
		// A Secret mount's mode: group-readable, which ssh-keygen refuses unless the key is copied.
		if err := os.Chmod(filepath.Join(dir, secrets.SignSSHFile), 0o440); err != nil {
			t.Fatal(err)
		}
		pub, _ := os.ReadFile(filepath.Join(dir, secrets.SignSSHFile+".pub"))
		f.signer = strings.TrimSpace(string(pub))
		entry.Sign = &secrets.GitSign{SSHKey: "sign", Name: signerName, Email: signerEmail}
	case "gpg", "gpg-passphrase":
		// The agents this test starts — its own key's, and each push's — leave no socket directory.
		gittest.SweepSocketDirs(t)
		dir := filepath.Join(gitRoot, "sign")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		home := filepath.Join(p.Root, "gpg-home")
		if err := os.MkdirAll(home, 0o700); err != nil {
			t.Fatal(err)
		}
		pass := ""
		if sign == "gpg-passphrase" {
			pass = "a passphrase"
		}
		// Made a day ago: a key made at the host's clock now is "created in the future" once the clock
		// steps back (a WSL2 host steps it back every half minute), and gpg then refuses to sign.
		run(t, "gpg", "--batch", "--homedir", home, "--pinentry-mode", "loopback", "--passphrase", pass,
			"--faked-system-time", gittest.ADayAgo(), "--ignore-time-conflict",
			"--quick-gen-key", signerName+" <"+signerEmail+">", "ed25519", "sign", "never")
		out := run(t, "gpg", "--batch", "--homedir", home, "--pinentry-mode", "loopback", "--passphrase", pass,
			"--armor", "--export-secret-keys", signerEmail)
		if err := os.WriteFile(filepath.Join(dir, secrets.SignGPGFile), []byte(out), 0o400); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { gittest.RemoveSocketDir(home) })
		entry.Sign = &secrets.GitSign{GPGKey: "sign", Name: signerName, Email: signerEmail}
	}
	f.runner = &Runner{
		Config:    &secrets.Config{Version: 1, Placement: "sandbox", Git: []secrets.GitEntry{entry}},
		WorkRoot:  p.Work,
		ReposRoot: filepath.Dir(p.Cache),
		GitRoot:   gitRoot,
		Scratch:   filepath.Join(p.Root, "scratch"),
		Helper:    os.Args[0],
		Scrubber:  scrub.New(nil),
		// The tests' remotes are local paths.
		AllowLocal: true,
		Now:        func() time.Time { return time.Unix(1800000000, 0) },
	}
	return f
}

func run(t *testing.T, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v: %s", name, args, err, out)
	}
	return string(out)
}

func (f *fixture) request(sign bool, pairs []wire.Pair) *wire.StartRequest {
	f.t.Helper()
	spec := &wire.PushSpec{
		Repo:       wire.RepoRef{GitDir: "app/default/.git", Worktree: "app/jr2-work", Cache: "app-key"},
		URL:        f.pod.Remote,
		Branch:     f.pod.Branch,
		Credential: "*",
		Sign:       sign,
		Pairs:      pairs,
	}
	req := &wire.StartRequest{Kind: wire.KindPush, Push: spec, TimeoutMs: 60_000}
	if err := req.Validate(); err != nil {
		f.t.Fatal(err)
	}
	if msg := f.runner.Check(req); msg != "" {
		f.t.Fatal(msg)
	}
	pin, err := Pin(f.runner.WorkRoot, spec.Repo, spec.Branch)
	if err != nil {
		f.t.Fatal(err)
	}
	spec.Pin = pin
	return req
}

func (f *fixture) push(sign bool, pairs []wire.Pair) wire.Output {
	f.t.Helper()
	return f.runner.Run(context.Background(), f.request(sign, pairs))
}

func remoteRef(f *fixture) string { return f.pod.RemoteTip("refs/heads/" + f.pod.Branch) }

func TestAnUnsignedPushPublishesTheAgentsTipAndRunsNoPlantedProgram(t *testing.T) {
	f := newFixture(t, "")
	sha := f.pod.Commit("work", map[string]string{"a.txt": "a\n"})
	f.pod.Plant()
	out := f.push(false, nil)
	if out.Outcome != wire.OutcomePushed || out.Push.Published != sha || out.Push.Source != sha {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != sha {
		t.Fatalf("the remote holds %q", remoteRef(f))
	}
	if ran := f.pod.Ran(); len(ran) != 0 {
		t.Fatalf("planted programs ran: %v", ran)
	}
	// Nothing new: the remote holds it, nothing is sent.
	again := f.push(false, nil)
	if again.Outcome != wire.OutcomePushed || !again.Push.Unchanged {
		t.Fatalf("again: %+v %+v", again, again.Push)
	}
	if entries, _ := os.ReadDir(f.runner.Scratch); len(entries) != 0 {
		t.Fatalf("the call's directory was left: %v", entries)
	}
}

func TestAnUnsignedPushThatIsNotAFastForwardIsRejected(t *testing.T) {
	f := newFixture(t, "")
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	if out := f.push(false, nil); out.Outcome != wire.OutcomePushed {
		t.Fatalf("first: %+v", out)
	}
	before := remoteRef(f)
	gittest.Git(t, f.pod.Tree, "commit", "-q", "--amend", "-m", "rewritten")
	out := f.push(false, nil)
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "push" || !strings.Contains(out.Reason, "non-fast-forward") {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != before {
		t.Fatal("the remote moved")
	}
}

func allowedSigners(t *testing.T, f *fixture) string {
	t.Helper()
	file := filepath.Join(f.pod.Root, "allowed_signers")
	if err := os.WriteFile(file, []byte(signerEmail+" namespaces=\"git\" "+f.signer+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

func verify(t *testing.T, f *fixture, commit string) {
	t.Helper()
	cmd := exec.Command("git", "--git-dir="+f.pod.Remote, "-c", "gpg.ssh.allowedSignersFile="+allowedSigners(t, f),
		"verify-commit", commit)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("verify-commit %s: %v: %s", commit, err, out)
	}
}

func remoteGit(t *testing.T, f *fixture, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"--git-dir=" + f.pod.Remote}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

func TestASignedSSHPushPublishesSignedCopiesWithTheAgentsAuthorAndTheSignersCommitter(t *testing.T) {
	f := newFixture(t, "ssh")
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	sha := f.pod.Commit("two", map[string]string{"b.txt": "b\n"})
	f.pod.Plant()
	out := f.push(true, nil)
	if out.Outcome != wire.OutcomePushed || out.Push.Source != sha || out.Push.Published == sha {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	pub := remoteRef(f)
	if pub != out.Push.Published {
		t.Fatalf("the remote holds %q, the output says %q", pub, out.Push.Published)
	}
	for c := range strings.FieldsSeq(remoteGit(t, f, "rev-list", pub, "--not", "main")) {
		verify(t, f, c)
		if got := remoteGit(t, f, "log", "-1", "--format=%an <%ae> %at|%cn <%ce> %ct", c); got !=
			"Agent <agent@example.test> 1700000000|"+signerName+" <"+signerEmail+"> 1800000000" {
			t.Fatalf("commit %s: %s", c, got)
		}
	}
	if remoteGit(t, f, "rev-parse", pub+"^{tree}") != gittest.Git(t, f.pod.Tree, "rev-parse", sha+"^{tree}") {
		t.Fatal("the published tree is not the Agent's")
	}
	if n := remoteGit(t, f, "rev-list", "--count", pub, "--not", "main"); n != "2" {
		t.Fatalf("%s commits published, want 2", n)
	}
	if out.Push.Bundle == "" {
		t.Fatal("no sync bundle")
	}
	if out.Push.Squashed != "" {
		t.Fatalf("signed copies read as a squash: %q", out.Push.Squashed)
	}
	if _, err := base64.StdEncoding.DecodeString(out.Push.Bundle); err != nil {
		t.Fatal(err)
	}
	if ran := f.pod.Ran(); len(ran) != 0 {
		t.Fatalf("planted programs ran: %v", ran)
	}
}

func TestAPushAfterASignedPushWithNoSyncPairsByTheLedgerOrByCherry(t *testing.T) {
	for _, mode := range []string{"pair", "cherry"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t, "ssh")
			f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
			first := f.push(true, nil)
			if first.Outcome != wire.OutcomePushed {
				t.Fatalf("first: %+v", first)
			}
			// The sync did not run: the Agent's branch still holds its unsigned commit, and the Agent
			// adds one.
			sha := f.pod.Commit("three", map[string]string{"c.txt": "c\n"})
			var pairs []wire.Pair
			if mode == "pair" {
				pairs = []wire.Pair{{Published: first.Push.Published, Source: first.Push.Source}}
			}
			out := f.push(true, pairs)
			if out.Outcome != wire.OutcomePushed || out.Push.Via != mode {
				t.Fatalf("got %+v %+v", out, out.Push)
			}
			if n := remoteGit(t, f, "rev-list", "--count", remoteRef(f), "--not", first.Push.Published); n != "1" {
				t.Fatalf("%s new commits, want 1", n)
			}
			if remoteGit(t, f, "rev-parse", remoteRef(f)+"^{tree}") != gittest.Git(t, f.pod.Tree, "rev-parse", sha+"^{tree}") {
				t.Fatal("the published tree is not the Agent's")
			}
			verify(t, f, remoteRef(f))
		})
	}
}

func TestAPushAfterTheAgentRewroteHistoryIsDivergedAndPushesNothing(t *testing.T) {
	f := newFixture(t, "ssh")
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	first := f.push(true, nil)
	if first.Outcome != wire.OutcomePushed {
		t.Fatalf("first: %+v", first)
	}
	gittest.Git(t, f.pod.Tree, "commit", "-q", "--amend", "-m", "reworded")
	pairs := []wire.Pair{{Published: first.Push.Published, Source: first.Push.Source}}
	out := f.push(true, pairs)
	if out.Outcome != wire.OutcomeDiverged || out.Push.Published != first.Push.Published {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != first.Push.Published {
		t.Fatal("the remote moved")
	}
}

func TestAPushWhoseRemoteAlreadyHoldsItIsUnchanged(t *testing.T) {
	f := newFixture(t, "ssh")
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	first := f.push(true, nil)
	pairs := []wire.Pair{{Published: first.Push.Published, Source: first.Push.Source}}
	again := f.push(true, pairs)
	if again.Outcome != wire.OutcomePushed || !again.Push.Unchanged || again.Push.Published != first.Push.Published {
		t.Fatalf("got %+v %+v", again, again.Push)
	}
}

func TestAGPGSignedPushVerifiesAndAPassphrasedKeyIsRefusedByName(t *testing.T) {
	if _, err := exec.LookPath("gpg"); err != nil {
		t.Skip("no gpg")
	}
	f := newFixture(t, "gpg")
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	out := f.push(true, nil)
	if out.Outcome != wire.OutcomePushed {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	raw := remoteGit(t, f, "cat-file", "commit", remoteRef(f))
	if !strings.Contains(raw, "-----BEGIN PGP SIGNATURE-----") {
		t.Fatalf("not signed: %s", raw)
	}

	p := newFixture(t, "gpg-passphrase")
	p.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	refused := p.push(true, nil)
	if refused.Outcome != wire.OutcomeRejected || refused.Push.Stage != "sign" ||
		!strings.Contains(refused.Reason, "passphrase") || !strings.Contains(refused.Reason, "sign") {
		t.Fatalf("got %+v %+v", refused, refused.Push)
	}
	if remoteRef(p) != "" {
		t.Fatal("something was pushed unsigned")
	}
}

// toolset makes jr2's programs a directory that holds only the named ones, linked to the host's,
// for the rest of the test: an image that carries those and nothing else.
func toolset(t *testing.T, names ...string) {
	t.Helper()
	dir := t.TempDir()
	for _, name := range names {
		path, err := gitclean.Look(name)
		if err != nil {
			t.Skipf("no %s on this host", name)
		}
		if err := os.Symlink(path, filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	old := gitclean.Path
	gitclean.Path = dir
	t.Cleanup(func() { gitclean.Path = old })
}

// agentsOf lists the gpg-agent processes whose home is under scratch.
func agentsOf(scratch string) []string {
	var found []string
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		raw, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil {
			continue
		}
		cmdline := strings.ReplaceAll(string(raw), "\x00", " ")
		if strings.Contains(cmdline, "gpg-agent") && strings.Contains(cmdline, scratch) {
			found = append(found, e.Name()+": "+cmdline)
		}
	}
	return found
}

// A GPG-signed push runs gpg and gpg-agent alone (ADR-0068): the agent is ready when its launcher
// exits 0, and the push stops it with SIGTERM to its process group. An image with no gpgconf signs,
// and no agent outlives the push.
func TestAGPGSignedPushNeedsNoGpgconf(t *testing.T) {
	if _, err := exec.LookPath("gpg"); err != nil {
		t.Skip("no gpg")
	}
	f := newFixture(t, "gpg")
	toolset(t, "git", "gpg", "gpg-agent")
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	out := f.push(true, nil)
	if out.Outcome != wire.OutcomePushed {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if raw := remoteGit(t, f, "cat-file", "commit", remoteRef(f)); !strings.Contains(raw, "-----BEGIN PGP SIGNATURE-----") {
		t.Fatalf("not signed: %s", raw)
	}
	if left := agentsOf(f.runner.Scratch); len(left) != 0 {
		t.Fatalf("a gpg-agent outlived the push: %v", left)
	}
}

// An image with gpg and no gpg-agent cannot sign with GPG, and the reason names the program.
func TestAGPGSignedPushWithNoGpgAgentNamesIt(t *testing.T) {
	if _, err := exec.LookPath("gpg"); err != nil {
		t.Skip("no gpg")
	}
	f := newFixture(t, "gpg")
	toolset(t, "git", "gpg")
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	out := f.push(true, nil)
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "sign" || !strings.Contains(out.Reason, "gpg-agent") {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != "" {
		t.Fatal("something was pushed")
	}
}

func TestCheckRefusesAPushThisEffectorCannotSpend(t *testing.T) {
	f := newFixture(t, "")
	req := f.request(false, nil)
	req.Push.Credential = "github.com/other/"
	if msg := f.runner.Check(req); !strings.Contains(msg, "does not hold") {
		t.Fatalf("got %q", msg)
	}
	req.Push.Credential = "*"
	req.Push.Sign = true
	if msg := f.runner.Check(req); !strings.Contains(msg, "no sign field") {
		t.Fatalf("got %q", msg)
	}
	f.runner.Config.Git[0].Match = "github.com/ourorg/"
	req.Push.Credential, req.Push.Sign = "github.com/ourorg/", false
	if msg := f.runner.Check(req); !strings.Contains(msg, "not under") {
		t.Fatalf("got %q", msg)
	}
}

// ADR-0067: a signed push that cannot pair cleanly is `diverged`, and nothing is pushed — with `force` too. Force
// replaces a remote branch that moved; it never stands in for a pairing.
func TestASignedForcePushThatCannotPairIsDivergedAndPushesNothing(t *testing.T) {
	f := newFixture(t, "ssh")
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	first := f.push(true, nil)
	if first.Outcome != wire.OutcomePushed {
		t.Fatalf("first: %+v", first)
	}
	gittest.Git(t, f.pod.Tree, "commit", "-q", "--amend", "-m", "reworded")
	req := f.request(true, []wire.Pair{{Published: first.Push.Published, Source: first.Push.Source}})
	req.Push.Force = true
	out := f.runner.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeDiverged {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != first.Push.Published {
		t.Fatal("the remote moved")
	}
}

// Nothing unsigned leaves: every commit the remote lacks is one the call signed. A merge whose
// second parent is an Agent commit that the pair does not map would carry that unsigned commit
// to the remote; the push is `diverged` instead.
func TestASignedPushThatWouldPublishAnUnsignedCommitIsDiverged(t *testing.T) {
	f := newFixture(t, "ssh")
	one := f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	two := f.pod.Commit("two", map[string]string{"b.txt": "b\n"})
	first := f.push(true, nil)
	if first.Outcome != wire.OutcomePushed {
		t.Fatalf("first: %+v", first)
	}
	// The sync did not run. The Agent writes a merge of its tip and its own first commit.
	tree := gittest.Git(t, f.pod.Tree, "rev-parse", two+"^{tree}")
	merge := gittest.Git(t, f.pod.Tree, "commit-tree", tree, "-p", two, "-p", one, "-m", "merge")
	gittest.Git(t, f.pod.Tree, "update-ref", "refs/heads/"+f.pod.Branch, merge)
	out := f.push(true, []wire.Pair{{Published: first.Push.Published, Source: first.Push.Source}})
	if out.Outcome != wire.OutcomeDiverged || !strings.Contains(out.Reason, "unsigned") {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != first.Push.Published {
		t.Fatal("the remote moved")
	}
	if err := exec.Command("git", "--git-dir="+f.pod.Remote, "cat-file", "-e", one).Run(); err == nil {
		t.Fatal("the Agent's unsigned commit reached the remote")
	}
}

// A local url is never pushed to outside the tests: git's local transport runs that repository's
// config and hooks, and a local path in the pod can be the Agent's own repository.
func TestAPushToALocalPathIsRefusedOutsideTheTests(t *testing.T) {
	f := newFixture(t, "")
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	f.pod.Plant()
	f.runner.AllowLocal = false
	out := f.push(false, nil)
	if out.Outcome != wire.OutcomeRejected || !strings.Contains(out.Reason, "local path") {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != "" {
		t.Fatal("something was pushed")
	}
	if ran := f.pod.Ran(); len(ran) != 0 {
		t.Fatalf("planted programs ran: %v", ran)
	}
}

// ADR-0068: a push keeps ssh's own stderr beside git's, so its reason names ssh's line and not only
// "the remote could not be reached" — here, a connection ssh itself reports refused.
func TestAnSSHPushThatCannotConnectNamesSSHsOwnLine(t *testing.T) {
	if _, err := gitclean.Look("ssh"); err != nil {
		t.Skip("no ssh in " + gitclean.Path)
	}
	f := newFixture(t, "")
	dir := filepath.Join(f.runner.GitRoot, "push")
	if err := os.WriteFile(filepath.Join(dir, secrets.PushKeyFile), []byte("not a key\n"), 0o400); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, secrets.KnownHostsFile), []byte(""), 0o400); err != nil {
		t.Fatal(err)
	}
	f.runner.Config.Git[0].Push = &secrets.GitAuth{SSHKey: "push"}
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	req := f.request(false, nil)
	// Nothing listens on port 1 of the loopback: ssh says so, git says only that it could not read.
	req.Push.URL = "ssh://git@127.0.0.1:1/app.git"
	out := f.runner.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "fetch" {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if !strings.Contains(out.Reason, "the remote could not be reached: ssh: ") ||
		!strings.Contains(out.Reason, "port 1") {
		t.Fatalf("the reason does not name ssh's line: %q", out.Reason)
	}
	if !strings.Contains(out.Push.Detail, "Could not read from remote repository") ||
		!strings.Contains(out.Push.Detail, "ssh:\n") {
		t.Fatalf("the detail does not keep git's and ssh's words: %q", out.Push.Detail)
	}
}
