package beneath

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The e6 experiment's cases, as tests: a Worktree the Agent planted beside a secret outside it.
func plant(t *testing.T) (work, worktree string) {
	t.Helper()
	base := t.TempDir()
	work = filepath.Join(base, "work")
	worktree = filepath.Join(work, "app", "jr2-branch")
	secret := filepath.Join(base, "secrets", "token")
	must(t, os.MkdirAll(filepath.Join(worktree, "dist"), 0o755))
	must(t, os.MkdirAll(filepath.Dir(secret), 0o700))
	must(t, os.WriteFile(secret, []byte("TOPSECRET"), 0o600))
	must(t, os.WriteFile(filepath.Join(worktree, "dist", "report.pdf"), []byte("the report"), 0o644))
	link := func(target, name string) { must(t, os.Symlink(target, filepath.Join(worktree, name))) }
	link(secret, "abs-secret")
	link("../../../secrets/token", "rel-secret")
	link("/proc/self/environ", "proc-env")
	link("dist/report.pdf", "inner")
	must(t, os.Symlink("/", filepath.Join(worktree, "dist", "sub")))
	must(t, syscall.Mkfifo(filepath.Join(worktree, "fifo"), 0o644))
	must(t, os.Link(secret, filepath.Join(worktree, "hard-secret")))
	return work, worktree
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestOpenReadsARegularFileInTheWorktree(t *testing.T) {
	work, _ := plant(t)
	dir, err := Dir(work, "app/jr2-branch")
	must(t, err)
	defer func() { _ = dir.Close() }()
	f, err := Open(dir, "dist/report.pdf")
	must(t, err)
	defer func() { _ = f.Close() }()
	got, _ := io.ReadAll(f)
	if string(got) != "the report" || f.Size != int64(len("the report")) {
		t.Fatalf("read %q size %d", got, f.Size)
	}
}

func TestOpenRefusesEveryPathThatIsNotOneRegularFileBeneath(t *testing.T) {
	work, _ := plant(t)
	dir, err := Dir(work, "app/jr2-branch")
	must(t, err)
	defer func() { _ = dir.Close() }()
	cases := map[string]string{
		"abs-secret":                     "symlink",
		"rel-secret":                     "symlink",
		"proc-env":                       "symlink",
		"inner":                          "symlink", // a symlink that stays inside is refused too
		"dist/sub/etc/passwd":            "symlink",
		"../../../secrets/token":         "`..`",
		"dist/../dist/report.pdf":        "`..`",
		"/etc/passwd":                    "absolute",
		"fifo":                           "FIFO",
		"dist":                           "directory",
		".":                              "directory",
		"hard-secret":                    "hard links",
		"":                               "empty",
		"dist/report.pdf\x00x":           "NUL",
		"missing":                        "does not exist",
		"dist/report.pdf/x":              "not a directory",
		"dist/sub":                       "symlink",
		"../jr2-branch/dist/report.pdf":  "`..`",
		"./dist/./report.pdf/../x":       "`..`",
		"abs-secret/":                    "symlink",
		"dist/report.pdf/":               "not a directory",
		"dist//report.pdf/..":            "`..`",
		"proc-env/../dist/report.pdf":    "`..`",
		"dist/sub/proc/self/environ":     "symlink",
		"dist/sub/../../../secrets/tok":  "`..`",
		"inner/../dist/report.pdf":       "`..`",
		"rel-secret/../dist/report.pdf":  "`..`",
		"hard-secret/../dist/report.pdf": "`..`",
	}
	for path, want := range cases {
		done := make(chan error, 1)
		go func() {
			f, err := Open(dir, path)
			if err == nil {
				_ = f.Close()
			}
			done <- err
		}()
		select {
		case err := <-done:
			var refused *Refused
			if !errors.As(err, &refused) {
				t.Errorf("%q: want a refusal naming %q, got %v", path, want, err)
				continue
			}
			if !strings.Contains(refused.Reason, want) {
				t.Errorf("%q: the reason %q does not name %q", path, refused.Reason, want)
			}
			if strings.Contains(refused.Reason, "TOPSECRET") {
				t.Errorf("%q: the reason holds the secret's content", path)
			}
		case <-time.After(5 * time.Second):
			// A FIFO with no writer blocks a plain open forever: the opener must not.
			t.Fatalf("%q: the open blocked", path)
		}
	}
}

func TestDirRefusesASymlinkedWorktree(t *testing.T) {
	work, worktree := plant(t)
	// The Agent replaces its Worktree with a symlink to a directory outside /work.
	outside := t.TempDir()
	must(t, os.WriteFile(filepath.Join(outside, "f"), []byte("x"), 0o644))
	must(t, os.Rename(worktree, worktree+".gone"))
	must(t, os.Symlink(outside, worktree))
	var refused *Refused
	if _, err := Dir(work, "app/jr2-branch"); !errors.As(err, &refused) {
		t.Fatalf("a symlinked Worktree was opened: %v", err)
	}
	if _, err := Dir(work, "../"+filepath.Base(outside)); err == nil {
		t.Fatal("`..` out of the work root was opened")
	}
}

func TestReadSmallBoundsTheRead(t *testing.T) {
	work, worktree := plant(t)
	must(t, os.WriteFile(filepath.Join(worktree, "big"), []byte(strings.Repeat("x", 200)), 0o644))
	dir, err := Dir(work, "app/jr2-branch")
	must(t, err)
	defer func() { _ = dir.Close() }()
	if _, err := ReadSmall(dir, "big", 100); err == nil || !strings.Contains(err.Error(), "over the 100") {
		t.Fatalf("a long file was read: %v", err)
	}
	got, err := ReadSmall(dir, "dist/report.pdf", 100)
	must(t, err)
	if string(got) != "the report" {
		t.Fatalf("read %q", got)
	}
}
