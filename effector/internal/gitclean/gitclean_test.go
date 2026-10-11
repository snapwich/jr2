package gitclean

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/beneath"
	"github.com/snapwich/jr2/effector/internal/gittest"
)

func newRepo(t *testing.T, p *gittest.Pod) *Repo {
	t.Helper()
	r, err := New(context.Background(), Options{Scratch: filepath.Join(p.Root, "scratch"), Caches: []string{p.Cache},
		Protocols: "file"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	return r
}

func TestImportBringsTheAgentsCommitAndRunsNoPlantedProgram(t *testing.T) {
	p := gittest.NewPod(t, "jr2/work")
	sha := p.Commit("add a file", map[string]string{"src/a.txt": "a\n"})
	p.Plant()

	r := newRepo(t, p)
	gitDir, err := beneath.Dir(p.Root, "work/app/default/.git")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = gitDir.Close() }()
	tip, err := ReadBranch(gitDir, p.Branch)
	if err != nil || tip != sha {
		t.Fatalf("ReadBranch = %q, %v; want %s", tip, err, sha)
	}
	ctx := context.Background()
	have, err := r.CacheTips(ctx, []string{p.Cache})
	if err != nil || len(have) == 0 {
		t.Fatalf("CacheTips = %v, %v", have, err)
	}
	if err := r.Import(ctx, filepath.Join(p.GitDir, "objects"), sha, have, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if got, _ := r.Line(ctx, "cat-file", "-t", sha); got != "commit" {
		t.Fatalf("the commit was not imported: %q", got)
	}
	if ran := p.Ran(); len(ran) != 0 {
		t.Fatalf("planted programs ran: %v", ran)
	}
}

func TestImportRefusesWhatIsNotTheAgentsCommit(t *testing.T) {
	p := gittest.NewPod(t, "work")
	r := newRepo(t, p)
	ctx := context.Background()
	objects := filepath.Join(p.GitDir, "objects")
	var ie *ErrImport
	if err := r.Import(ctx, objects, "not-a-sha", nil, time.Second); !errors.As(err, &ie) {
		t.Fatalf("a non-sha was imported: %v", err)
	}
	if err := r.Import(ctx, objects, strings.Repeat("a", 40), nil, time.Second); !errors.As(err, &ie) {
		t.Fatalf("a missing commit was imported: %v", err)
	}
	tree := gittest.Git(t, p.Tree, "rev-parse", "HEAD^{tree}")
	if err := r.Import(ctx, objects, tree, nil, time.Second); !errors.As(err, &ie) {
		t.Fatalf("a tree was imported as a commit: %v", err)
	}
}

func TestImportHasADeadlineWhenAnObjectIsAFIFO(t *testing.T) {
	p := gittest.NewPod(t, "work")
	sha := p.Commit("one", map[string]string{"f": "x\n"})
	// Replace the commit's loose object with a FIFO: a plain open of it blocks forever.
	obj := filepath.Join(p.GitDir, "objects", sha[:2], sha[2:])
	if err := os.Remove(obj); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(obj, 0o644); err != nil {
		t.Fatal(err)
	}
	r := newRepo(t, p)
	done := make(chan error, 1)
	go func() {
		done <- r.Import(context.Background(), filepath.Join(p.GitDir, "objects"), sha, nil, time.Second)
	}()
	select {
	case err := <-done:
		var ie *ErrImport
		if !errors.As(err, &ie) {
			t.Fatalf("want an import refusal, got %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the import had no deadline")
	}
}

func TestImportRefusesACorruptObject(t *testing.T) {
	p := gittest.NewPod(t, "work")
	// A commit object whose bytes do not hash to its name: the Agent wrote it by hand.
	good := p.Commit("one", map[string]string{"f": "x\n"})
	bad := strings.Repeat("b", 40)
	src := filepath.Join(p.GitDir, "objects", good[:2], good[2:])
	raw, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(p.GitDir, "objects", bad[:2]), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p.GitDir, "objects", bad[:2], bad[2:]), raw, 0o444); err != nil {
		t.Fatal(err)
	}
	r := newRepo(t, p)
	var ie *ErrImport
	err = r.Import(context.Background(), filepath.Join(p.GitDir, "objects"), bad, nil, 5*time.Second)
	if !errors.As(err, &ie) {
		t.Fatalf("a corrupt object was imported: %v", err)
	}
}

func TestReadBranchReadsPackedRefsAndRefusesASymlinkedRef(t *testing.T) {
	p := gittest.NewPod(t, "work")
	sha := p.Commit("one", nil)
	gittest.Git(t, p.Tree, "pack-refs", "--all")
	gitDir, err := beneath.Dir(p.Root, "work/app/default/.git")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = gitDir.Close() }()
	if got, err := ReadBranch(gitDir, "work"); err != nil || got != sha {
		t.Fatalf("packed: %q %v", got, err)
	}
	// A loose ref that is a symlink to a file outside: refused, and packed-refs is read instead.
	outside := filepath.Join(p.Root, "outside")
	if err := os.WriteFile(outside, []byte(strings.Repeat("c", 40)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(p.GitDir, "refs", "heads", "work")); err != nil {
		t.Fatal(err)
	}
	if got, err := ReadBranch(gitDir, "work"); err != nil || got != sha {
		t.Fatalf("the symlinked ref was read: %q %v", got, err)
	}
	for _, bad := range []string{"../x", "/abs", "a..b", "with space", ""} {
		if _, err := ReadBranch(gitDir, bad); err == nil {
			t.Errorf("branch %q was read", bad)
		}
	}
}

func TestTheCleanRepositoryTakesNoConfigFromTheEnvironment(t *testing.T) {
	p := gittest.NewPod(t, "work")
	t.Setenv("GIT_CONFIG_PARAMETERS", "'core.hooksPath'='/planted'")
	t.Setenv("GIT_DIR", p.GitDir)
	r := newRepo(t, p)
	got, err := r.Line(context.Background(), "config", "--get", "core.hooksPath")
	if err != nil || !strings.HasPrefix(got, r.Work) {
		t.Fatalf("core.hooksPath = %q, %v", got, err)
	}
	for _, kv := range r.Env() {
		if strings.HasPrefix(kv, "GIT_CONFIG_PARAMETERS=") || strings.HasPrefix(kv, "GIT_DIR=") {
			t.Fatalf("the clean env carries %s", kv)
		}
	}
}

// Hardening: jr2's own programs run by absolute path from Path, never by the PATH the Effector's
// image set. A PATH whose first directory holds a fake git, ssh-keygen and gpg runs none of them.
func TestJr2sProgramsRunFromPathNeverFromTheInheritedPATH(t *testing.T) {
	fake := t.TempDir()
	marker := filepath.Join(t.TempDir(), "ran")
	for _, name := range []string{"git", "ssh-keygen", "gpg"} {
		script := "#!/bin/sh\necho " + name + " >> '" + marker + "'\nexit 0\n"
		if err := os.WriteFile(filepath.Join(fake, name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", fake+":"+os.Getenv("PATH"))

	for _, name := range []string{"git", "ssh-keygen", "gpg"} {
		path, err := Look(name)
		if err != nil {
			t.Skipf("%s is not in %s on this host: %v", name, Path, err)
		}
		if !filepath.IsAbs(path) || strings.HasPrefix(path, fake) {
			t.Fatalf("Look(%q) = %q, not a program of Path", name, path)
		}
	}
	r, err := New(context.Background(), Options{Scratch: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, err := r.Line(context.Background(), "rev-parse", "--is-bare-repository"); err != nil {
		t.Fatal(err)
	}
	_, _ = Exec(context.Background(), r, nil, "ssh-keygen", "-l", "-f", "/dev/null")
	_, _ = Exec(context.Background(), r, nil, "gpg", "--version")
	if raw, err := os.ReadFile(marker); err == nil {
		t.Fatalf("a program from the inherited PATH ran: %q", raw)
	}
}
