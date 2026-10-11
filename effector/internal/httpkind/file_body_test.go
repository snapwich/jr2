package httpkind

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"

	"github.com/snapwich/jr2/effector/internal/wire"
)

// B19: an http whose body is a Worktree file sends it, opened beneath the Worktree; every path that
// is not a regular file beneath it, with one link and no symlink, is refused with nothing sent.
func TestAFileBodySendsAWorktreeFileAndRefusesEveryPathThatIsNotOneBeneath(t *testing.T) {
	var got atomic.Value
	var sends atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sends.Add(1)
		b, _ := io.ReadAll(r.Body)
		got.Store(r.Method + " " + r.Header.Get("Content-Type") + " " + string(b))
		w.WriteHeader(201)
	}))
	defer srv.Close()

	work := t.TempDir()
	tree := filepath.Join(work, "app", "jr2-work")
	if err := os.MkdirAll(filepath.Join(tree, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tree, "dist", "report.pdf"), []byte("the report"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("TOPSECRET"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(tree, "link")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(tree, "fifo"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(outside, filepath.Join(tree, "hard")); err != nil {
		t.Fatal(err)
	}

	r := runner(t, srv, "jira")
	r.WorkRoot = work
	send := func(path string) wire.Output {
		req := request(srv.URL + "/upload")
		req.Kind = wire.KindHTTP
		req.Method = "PUT"
		req.Auth = &wire.Auth{Bearer: &wire.SecretRef{Secret: "jira"}}
		req.Body = &wire.Body{File: &wire.FileRef{Worktree: "app/jr2-work", Path: path, ContentType: "application/pdf"}}
		if err := req.Validate(); err != nil {
			t.Fatal(err)
		}
		return r.Run(context.Background(), req)
	}
	out := send("dist/report.pdf")
	if out.Outcome != wire.OutcomeResponse || out.Response.Status != 201 {
		t.Fatalf("got %+v", out)
	}
	if got.Load() != "PUT application/pdf the report" {
		t.Fatalf("the server got %q", got.Load())
	}
	before := sends.Load()
	for _, bad := range []string{"link", "fifo", "hard", "../../../etc/passwd", "/etc/passwd", "dist", "missing"} {
		out := send(bad)
		if out.Outcome != wire.OutcomeRefused || !strings.Contains(out.Reason, "nothing was sent") {
			t.Errorf("%q: got %+v", bad, out)
		}
		if strings.Contains(out.Reason, "TOPSECRET") {
			t.Errorf("%q: the reason holds the file's content", bad)
		}
	}
	if sends.Load() != before {
		t.Fatal("a refused file body was sent")
	}
	// The Instance Effector has no Worktree: a file body there is refused, not read.
	r.WorkRoot = ""
	if out := send("dist/report.pdf"); out.Outcome != wire.OutcomeRefused {
		t.Fatalf("got %+v", out)
	}
}
