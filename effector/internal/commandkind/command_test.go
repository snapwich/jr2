package commandkind

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/snapwich/jr2/effector/internal/gittest"
	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/wire"
)

const secretValue = "aws-secret-0123456789"

func setup(t *testing.T) (*gittest.Pod, *Runner) {
	t.Helper()
	p := gittest.NewPod(t, "work")
	dir := filepath.Join(p.Root, "secrets")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "aws"), []byte(secretValue), 0o400); err != nil {
		t.Fatal(err)
	}
	held := map[string]string{"aws": secretValue, "other": "other-secret-value"}
	return p, &Runner{
		Secrets:    held,
		SecretsDir: dir,
		WorkRoot:   p.Work,
		ReposRoot:  filepath.Dir(p.Cache),
		Scratch:    filepath.Join(p.Root, "scratch"),
		Scrubber:   scrub.New(held),
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
	// The env is what the author named, plus PATH and HOME — nothing of the Effector's.
	var names []string
	for line := range strings.SplitSeq(tail, "\n") {
		if k, _, ok := strings.Cut(line, "="); ok && strings.ToUpper(k) == k && !strings.ContainsAny(k, " $(") {
			names = append(names, k)
		}
	}
	for _, n := range names {
		switch n {
		case "AWS_SECRET", "AWS_FILE", "PATH", "HOME", "PWD", "SHLVL", "_", "OLDPWD":
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
