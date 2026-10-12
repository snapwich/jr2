package commandkind

import (
	"context"
	"encoding/base32"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/snapwich/jr2/effector/internal/confine"
	"github.com/snapwich/jr2/effector/internal/gitclean"
	"github.com/snapwich/jr2/effector/internal/gittest"
	"github.com/snapwich/jr2/effector/internal/reaper"
	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/wire"
)

const secretValue = "aws-secret-0123456789"
const keyValue = "an-effector-placement-key-0123456789abcdef"
const otherValue = "other-secret-value"
const gitKeyValue = "-----BEGIN OPENSSH PRIVATE KEY----- push"

// The test binary doubles as the confiner (`effector confine`), as the Effector's own binary does
// in a pod. Landlock is real here: the host's kernel.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "keep" {
		// syscall.Exit, not os.Exit: under -coverprofile the test binary's exit hook writes
		// "GOCOVERDIR not set" to stderr, into the output the test reads. The Effector's binary has no such hook.
		syscall.Exit(reaper.Keep(os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "confine" {
		// syscall.Exit, not os.Exit: under -coverprofile the test binary's exit hook writes
		// "GOCOVERDIR not set" to stderr, into the output the test reads. The Effector's binary has no such hook.
		syscall.Exit(confine.Main(os.Args[2:]))
	}
	os.Exit(m.Run())
}

// setup is a Sandbox Effector's mount around a pod: its key, two secrets (the command names one),
// a push key at @git, and its scratch.
func setup(t *testing.T) (*gittest.Pod, *Runner) {
	t.Helper()
	p := gittest.NewPod(t, "work")
	dir := filepath.Join(p.Root, "secrets")
	keyDir := filepath.Join(p.Root, "effector")
	for _, d := range []string{filepath.Join(dir, "@git", "jr2-git-push-1"), keyDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for file, value := range map[string]string{
		filepath.Join(dir, "aws"):                                secretValue,
		filepath.Join(dir, "other"):                              otherValue,
		filepath.Join(dir, "@git", "jr2-git-push-1", "identity"): gitKeyValue,
		filepath.Join(keyDir, "key"):                             keyValue,
	} {
		if err := os.WriteFile(file, []byte(value), 0o400); err != nil {
			t.Fatal(err)
		}
	}
	held := map[string]string{"aws": secretValue, "other": otherValue}
	scratch := filepath.Join(p.Root, "scratch")
	return p, &Runner{
		Secrets:    held,
		SecretsDir: dir,
		WorkRoot:   p.Work,
		ReposRoot:  filepath.Dir(p.Cache),
		Scratch:    scratch,
		Scrubber:   scrub.New(held),
		Confiner:   os.Args[0],
		Deny:       []string{keyDir, dir, p.Work, filepath.Dir(p.Cache), scratch},
	}
}

func request(t *testing.T, p *gittest.Pod, script string, pin string) *wire.StartRequest {
	t.Helper()
	if pin == "" {
		pin = p.Tip()
	}
	req := &wire.StartRequest{Kind: wire.KindCommand, TimeoutMs: 30_000, Command: &wire.CommandSpec{
		Repo:   wire.RepoRef{GitDir: "app/default/.git", Worktree: "app/work", Cache: "app-key"},
		Branch: p.Branch,
		Pin:    pin,
		Argv:   []string{"sh", "-c", script},
		Env:    map[string]wire.EnvRef{"AWS_SECRET": {Secret: "aws"}, "AWS_FILE": {Secret: "aws", Path: true}},
		Tail:   4096,
	}}
	if err := req.Validate(); err != nil {
		t.Fatal(err)
	}
	return req
}

func TestACommandReadsItsSecretFromEnvAndPathAndItsOutputIsScrubbed(t *testing.T) {
	p, r := setup(t)
	p.Commit("one", map[string]string{"a.txt": "committed\n"})
	out := r.Run(context.Background(), request(t, p, `echo "env=$AWS_SECRET"; echo "file=$(cat "$AWS_FILE")"; `+
		`printf %s "$AWS_SECRET" | base64; env | sort`, ""))
	if out.Outcome != wire.OutcomeExited || *out.Command.Code != 0 {
		t.Fatalf("got %+v %+v", out, out.Command)
	}
	tail := out.Command.Tail
	if strings.Contains(tail, "aws-secret") || strings.Contains(tail, "YXdzLXNlY3JldC") {
		t.Fatalf("the secret reached the output: %s", tail)
	}
	if !strings.Contains(tail, "env=[secret:aws]") || !strings.Contains(tail, "file=[secret:aws]") {
		t.Fatalf("the command did not read its secret: %s", tail)
	}
	// The env is what the author named, plus PATH, HOME and TMPDIR — nothing of the Effector's.
	var names []string
	for line := range strings.SplitSeq(tail, "\n") {
		if k, _, ok := strings.Cut(line, "="); ok && strings.ToUpper(k) == k && !strings.ContainsAny(k, " $(") {
			names = append(names, k)
		}
	}
	for _, n := range names {
		switch n {
		case "AWS_SECRET", "AWS_FILE", "PATH", "HOME", "TMPDIR", "PWD", "SHLVL", "_", "OLDPWD":
		default:
			t.Errorf("the child's env holds %s", n)
		}
	}
	if entries, _ := os.ReadDir(r.Scratch); len(entries) != 0 {
		t.Fatalf("the scratch was left: %v", entries)
	}
}

func TestACommandRunsAgainstThePinnedCommitAndSaysDirty(t *testing.T) {
	p, r := setup(t)
	first := p.Commit("one", map[string]string{"a.txt": "committed\n"})
	// Clean: not dirty.
	clean := r.Run(context.Background(), request(t, p, "cat a.txt", ""))
	if clean.Outcome != wire.OutcomeExited || clean.Command.Dirty || clean.Command.Tail != "committed\n" {
		t.Fatalf("clean: %+v %+v", clean, clean.Command)
	}
	// An edit the Agent did not commit: never seen, and the answer says dirty.
	if err := os.WriteFile(filepath.Join(p.Tree, "a.txt"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dirty := r.Run(context.Background(), request(t, p, "cat a.txt", ""))
	if !dirty.Command.Dirty || dirty.Command.Tail != "committed\n" {
		t.Fatalf("dirty: %+v %+v", dirty, dirty.Command)
	}
	// A pin names an earlier commit: the run sees it, not the tip.
	if err := os.WriteFile(filepath.Join(p.Tree, "a.txt"), []byte("committed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	p.Commit("two", map[string]string{"a.txt": "second\n"})
	pinned := r.Run(context.Background(), request(t, p, "cat a.txt", first))
	if pinned.Command.Tail != "committed\n" {
		t.Fatalf("pinned: %+v", pinned.Command)
	}
	// An untracked file is an uncommitted edit too.
	if err := os.WriteFile(filepath.Join(p.Tree, "new.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out := r.Run(context.Background(), request(t, p, "true", "")); !out.Command.Dirty {
		t.Fatal("an untracked file was not dirty")
	}
}

func TestTheJr2StepsRunNoPlantedProgram(t *testing.T) {
	p, r := setup(t)
	p.Commit("one", map[string]string{"a.txt": "a\n"})
	p.Plant()
	if err := os.WriteFile(filepath.Join(p.Tree, "a.txt"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := r.Run(context.Background(), request(t, p, "true", ""))
	if out.Outcome != wire.OutcomeExited || !out.Command.Dirty {
		t.Fatalf("got %+v %+v", out, out.Command)
	}
	if ran := p.Ran(); len(ran) != 0 {
		t.Fatalf("planted programs ran: %v", ran)
	}
}

func TestACommandsTimeoutKillsItsGroupAndASignalIsKilled(t *testing.T) {
	p, r := setup(t)
	p.Commit("one", nil)
	req := request(t, p, "sleep 30 & sleep 30", "")
	req.TimeoutMs = 300
	if out := r.Run(context.Background(), req); out.Outcome != wire.OutcomeTimeout {
		t.Fatalf("got %+v", out)
	}
	if out := r.Run(context.Background(), request(t, p, "kill -TERM $$", "")); out.Outcome != wire.OutcomeKilled ||
		out.Command.Signal != "SIGTERM" {
		t.Fatalf("got %+v %+v", out, out.Command)
	}
	if out := r.Run(context.Background(), request(t, p, "exit 3", "")); out.Outcome != wire.OutcomeExited ||
		*out.Command.Code != 3 {
		t.Fatalf("got %+v", out)
	}
}

// A secret that straddles the cut to the tail is scrubbed whole: the stream is scrubbed before it
// is cut (ADR-0068's scrub claim). With the cut first, the secret's last characters left.
func TestASecretThatStraddlesTheTailsCutLeavesNoPart(t *testing.T) {
	p, r := setup(t)
	p.Commit("one", nil)
	req := request(t, p, `printf '%s' "$AWS_SECRET"; printf 'abcdefghijklmnopqrst'`, "")
	req.Command.Tail = 30
	out := r.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeExited {
		t.Fatalf("got %+v", out)
	}
	tail := out.Command.Tail
	// Any end of the secret of 4 characters or more is a leak.
	for i := 0; i+4 <= len(secretValue); i++ {
		if strings.Contains(tail, secretValue[i:]) {
			t.Fatalf("the tail holds the secret's end %q: %q", secretValue[i:], tail)
		}
	}
	if !strings.HasSuffix(tail, "abcdefghijklmnopqrst") {
		t.Fatalf("the tail lost the output's end: %q", tail)
	}
}

// With `pin` naming an earlier approved commit and a clean Worktree, the answer is not dirty: the
// Worktree is compared with its own HEAD, never with the pin.
func TestAPinnedCommandOverACleanWorktreeIsNotDirty(t *testing.T) {
	p, r := setup(t)
	first := p.Commit("one", map[string]string{"a.txt": "one\n"})
	p.Commit("two", map[string]string{"b.txt": "two\n"})
	out := r.Run(context.Background(), request(t, p, "ls", first))
	if out.Outcome != wire.OutcomeExited || out.Command.Dirty {
		t.Fatalf("a clean Worktree read dirty: %+v %+v", out, out.Command)
	}
	if strings.Contains(out.Command.Tail, "b.txt") {
		t.Fatalf("the run saw a commit after the pin: %q", out.Command.Tail)
	}
	if err := os.WriteFile(filepath.Join(p.Tree, "b.txt"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out := r.Run(context.Background(), request(t, p, "true", first)); !out.Command.Dirty {
		t.Fatal("an uncommitted edit after the pin was not dirty")
	}
}

// The child's PATH is the Effector's own (its image's), and argv[0] is looked up there: a tool
// the author's image keeps outside the usual places runs. The tool must lie under the image's
// system paths, which the child may run (a test directory under /tmp may not be, by ADR-0068 rule 3),
// so it is one this host keeps in /usr/sbin alone.
func TestACommandFindsItsToolInTheEffectorsPath(t *testing.T) {
	p, r := setup(t)
	p.Commit("one", nil)
	const tool = "nologin"
	if _, err := os.Stat(filepath.Join("/usr/sbin", tool)); err != nil {
		t.Skipf("this host keeps no %s in /usr/sbin", tool)
	}
	if _, err := gitclean.Look(tool); err == nil {
		t.Skipf("this host keeps %s in %s too, so the test cannot tell the two PATHs apart", tool, gitclean.Path)
	}
	r.Path = "/usr/sbin:/usr/bin:/bin"
	req := request(t, p, "", "")
	req.Command.Argv = []string{tool}
	out := r.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeExited || out.Command.Code == nil || *out.Command.Code == 127 ||
		!strings.Contains(out.Command.Tail, "not available") {
		t.Fatalf("got %+v %+v", out, out.Command)
	}
	req = request(t, p, "", "")
	req.Command.Argv = []string{"sh", "-c", `echo "$PATH"`}
	if out := r.Run(context.Background(), req); out.Command == nil || out.Command.Tail != r.Path+"\n" {
		t.Fatalf("got %+v %+v", out, out.Command)
	}
}

// The child of a credentialed command is confined (ADR-0068): a committed script — the
// Agent's code, run by the author's argv — that reads the placement key, a secret the command does
// not name or the push key at @git, or writes into the Worktree, ends with a permission error, and
// the answer carries no secret. A child of the child inherits the confinement.
func TestTheChildCannotReachTheKeyAnUnnamedSecretGitOrTheWorktree(t *testing.T) {
	p, r := setup(t)
	p.Commit("one", map[string]string{"a.txt": "a\n"})
	key := filepath.Join(p.Root, "effector", "key")
	for name, script := range map[string]string{
		"the placement key":            "cat " + key,
		"the key, base32":              "base32 -w0 < " + key,
		"an unnamed secret":            "cat " + filepath.Join(r.SecretsDir, "other"),
		"the push key at @git":         "cat " + filepath.Join(r.SecretsDir, "@git", "jr2-git-push-1", "identity"),
		"a write into the Worktree":    "echo x > " + filepath.Join(p.Tree, "planted.txt"),
		"the key from a grandchild":    "sh -c 'sh -c \"cat " + key + "\"'",
		"the Effector's scratch above": "ls " + r.Scratch,
	} {
		out := r.Run(context.Background(), request(t, p, script, ""))
		if out.Outcome != wire.OutcomeExited || out.Command.Code == nil || *out.Command.Code == 0 {
			t.Errorf("%s: the child succeeded: %+v %+v", name, out, out.Command)
			continue
		}
		tail := out.Command.Tail
		if !strings.Contains(tail, "Permission denied") {
			t.Errorf("%s: no permission error: %q", name, tail)
		}
		for _, v := range []string{keyValue, otherValue, gitKeyValue, base32.StdEncoding.EncodeToString([]byte(keyValue))[:16]} {
			if strings.Contains(tail, v) {
				t.Errorf("%s: the answer carries a secret: %q", name, tail)
			}
		}
	}
	if _, err := os.Stat(filepath.Join(p.Tree, "planted.txt")); !os.IsNotExist(err) {
		t.Fatal("the child wrote into the Worktree")
	}
}

// What the command names it reads, from env and from its file, and so does its child; it works in
// its own scratch.
func TestTheChildReadsItsNamedSecretAndWritesItsScratch(t *testing.T) {
	p, r := setup(t)
	p.Commit("one", map[string]string{"a.txt": "a\n"})
	out := r.Run(context.Background(), request(t, p, `sh -c 'cat "$AWS_FILE"' > got && test "$(cat got)" = "$AWS_SECRET" `+
		`&& echo ok > "$HOME/x" && cat "$HOME/x" && cat a.txt`, ""))
	if out.Outcome != wire.OutcomeExited || *out.Command.Code != 0 || out.Command.Tail != "ok\na\n" {
		t.Fatalf("got %+v %+v", out, out.Command)
	}
}

// A node whose kernel cannot confine the child runs no credentialed command: the start is refused.
func TestAnUnconfinableNodeRefusesTheCommand(t *testing.T) {
	p, r := setup(t)
	p.Commit("one", nil)
	r.Unconfinable = "landlock: unavailable on node n1 (the kernel has no Landlock (ENOSYS))"
	if got := r.Missing(request(t, p, "true", "")); !strings.Contains(got, "landlock: unavailable on node n1") {
		t.Fatalf("got %q", got)
	}
}
