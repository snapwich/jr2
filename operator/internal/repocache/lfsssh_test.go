/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package repocache

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

// TestMain lets the test binary be a git-lfs-transfer server, which a test's ssh runs.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "lfs-transfer" {
		os.Exit(serveTransfer(os.Args[2:], os.Stdin, os.Stdout))
	}
	os.Exit(m.Run())
}

// serveTransfer is a git-lfs-transfer server for one download session, written to git-lfs's
// docs/proposals/ssh_adapter.md: the capability advertisement, `version 1`, `batch`, `get-object`
// and `quit`. It runs as `lfs-transfer <store> <operation>`. An object is the file <store>/<oid>.
// Each command is logged in <store>/log as `<operation> <command>`.
func serveTransfer(args []string, in io.Reader, out io.Writer) int {
	if len(args) != 2 {
		return 2
	}
	store, op := args[0], args[1]
	r, w := bufio.NewReader(in), bufio.NewWriter(out)
	text := func(s string) { _, _ = fmt.Fprintf(w, "%04x%s\n", len(s)+5, s) }
	flush := func() { _, _ = w.WriteString("0000"); _ = w.Flush() }
	delim := func() { _, _ = w.WriteString("0001") }
	status := func(code int, msg string) {
		text("status " + strconv.Itoa(code))
		if msg != "" {
			delim()
			text(msg)
		}
		flush()
	}
	logf := func(s string) {
		f, err := os.OpenFile(filepath.Join(store, "log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err == nil {
			_, _ = fmt.Fprintf(f, "%s %s\n", op, s)
			_ = f.Close()
		}
	}
	read := func() (head, lines []string, ok bool) {
		seenDelim := false
		for {
			var n4 [4]byte
			if _, err := io.ReadFull(r, n4[:]); err != nil {
				return nil, nil, false
			}
			n, err := strconv.ParseUint(string(n4[:]), 16, 16)
			if err != nil {
				return nil, nil, false
			}
			switch n {
			case 0:
				return head, lines, true
			case 1:
				seenDelim = true
				continue
			}
			body := make([]byte, n-4)
			if _, err := io.ReadFull(r, body); err != nil {
				return nil, nil, false
			}
			if seenDelim {
				lines = append(lines, strings.TrimSuffix(string(body), "\n"))
			} else {
				head = append(head, strings.TrimSuffix(string(body), "\n"))
			}
		}
	}
	text("version=1")
	flush()
	for {
		head, lines, ok := read()
		if !ok || len(head) == 0 {
			return 0
		}
		command, arg, _ := strings.Cut(head[0], " ")
		logf(command)
		switch command {
		case "version":
			status(200, "")
		case "quit":
			status(200, "")
			return 0
		case "batch":
			text("status 200")
			delim()
			for _, line := range lines {
				f := strings.Fields(line)
				if len(f) < 2 {
					continue
				}
				action := "noop"
				if _, err := os.Stat(filepath.Join(store, f[0])); err == nil && op == "download" {
					action = "download"
				}
				text(f[0] + " " + f[1] + " " + action)
			}
			flush()
		case "get-object":
			body, err := os.ReadFile(filepath.Join(store, filepath.Base(arg)))
			if err != nil || op != "download" {
				status(404, "no such object")
				continue
			}
			text("status 200")
			text("size=" + strconv.Itoa(len(body)))
			delim()
			for chunk := range slices.Chunk(body, 1000) {
				_, _ = fmt.Fprintf(w, "%04x", len(chunk)+4)
				_, _ = w.Write(chunk)
			}
			flush()
		default:
			status(400, "unknown command")
		}
	}
}

// An ssh Repo whose LFS server speaks only the pure SSH protocol: git-lfs, which the agent runs
// with lfs.sshtransfer=negotiate, gets the object over git-lfs-transfer, through the Repo's own
// ssh command (its key, batch mode) to the Repo url's host. No git-lfs-authenticate is needed.
func TestAnSSHRepoGetsItsObjectsFromAPureSSHServer(t *testing.T) {
	requireGitLFS(t)
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("no bash")
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	store := t.TempDir()
	content := "a large file over ssh\n"
	obj := put(t, t.TempDir(), content)
	if err := os.WriteFile(filepath.Join(store, obj.OID), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	tools := t.TempDir()
	sshLog := filepath.Join(t.TempDir(), "ssh.log")
	script := fmt.Sprintf(`#!%s
echo "ARGV: $*" >> %q
while [ $# -gt 0 ]; do
  case "$1" in
    -F|-i|-o|-p|-l|-c|-E|-S|-O|-b|-e|-D|-L|-R|-W|-J|-Q|-m) shift 2;;
    --) shift; break;;
    -*) shift;;
    *) break;;
  esac
done
host="$1"; shift
cmd="$*"
case "$cmd" in
  git-lfs-transfer*) exec %q lfs-transfer %q "${cmd##* }";;
esac
echo "$cmd: command not found" >&2
exit 127
`, bash, sshLog, self, store)
	if err := os.WriteFile(filepath.Join(tools, "ssh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", tools+":"+os.Getenv("PATH"))
	// git-lfs makes its ssh multiplexing folders (sock-*) in XDG_RUNTIME_DIR, else in TMPDIR: the
	// test reads that none stays.
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	t.Setenv("XDG_RUNTIME_DIR", tmp)

	r := repo(1, corev1alpha1.RepoNodeStatus{
		Node: node, Present: true, Synced: true, Attempted: corev1alpha1.RepoAttemptFetch,
		ObservedGeneration: 1, LastAttempt: ts(fixedNow), LastFetched: ts(fixedNow),
	})
	r.Spec.URL = "git@lfs-host.test:acme/app.git"
	r.Spec.SecretRef = &corev1.LocalObjectReference{Name: "git"}
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "git", Namespace: ns},
		Data:       map[string][]byte{secretKeyIdentity: []byte("a fake key\n")},
	}
	git := &recGit{inner: ExecGit()}
	a := newAgent(t, &fakeGit{}, r, secret, asking("sb", askJSON(at1, "", obj)))
	a.Git = git
	a.LFSTimeout = time.Minute
	src := filepath.Join(t.TempDir(), "src")
	gitT(t, "", "init", "-q", "-b", "main", src)
	gitT(t, src, "commit", "-q", "--allow-empty", "-m", "init")
	gitT(t, "", "clone", "-q", "--bare", "file://"+src, a.dir(key))

	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	raw, _ := os.ReadFile(sshLog)
	served, _ := os.ReadFile(filepath.Join(store, "log"))
	if it := items(t, a); len(it) != 1 || it[0].Error != "" || !a.hasLFS(a.dir(key), obj.OID) {
		t.Fatalf("the object must land over git-lfs-transfer, got %+v\nssh log:\n%s\nserver log:\n%s", it, raw, served)
	}
	if got, _ := os.ReadFile(lfsObjectPath(a.dir(key), obj.OID)); string(got) != content {
		t.Fatalf("the cache holds %q", got)
	}
	if !strings.Contains(string(served), "download get-object") {
		t.Fatalf("the server did not serve get-object:\n%s", served)
	}
	identity := filepath.Join(a.Home, ".ssh", key)
	for l := range strings.SplitSeq(strings.TrimSpace(string(raw)), "\n") {
		if strings.Contains(l, "git-lfs-authenticate") {
			t.Errorf("git-lfs-authenticate ran though the server speaks git-lfs-transfer: %s", l)
		}
		if !strings.Contains(l, "-i "+identity+" ") || !strings.Contains(l, "BatchMode=yes") ||
			!strings.Contains(l, "git@lfs-host.test ") {
			t.Errorf("an ssh call without the Repo's key, batch mode or host: %s", l)
		}
	}
	for _, c := range git.calls {
		if slices.Contains(c, "lfs") && !slices.Contains(c, "lfs.sshtransfer=negotiate") {
			t.Errorf("git-lfs ran with no pinned lfs.sshtransfer: %v", c)
		}
	}
	// The agent lives as long as its node: an ssh LFS fetch leaves no folder in TMPDIR.
	if left, _ := filepath.Glob(filepath.Join(tmp, "sock-*")); len(left) != 0 {
		t.Errorf("the ssh LFS fetch left %v", left)
	}
	if strings.Contains(string(raw), "ControlMaster") {
		t.Errorf("git-lfs multiplexed its ssh sessions:\n%s", raw)
	}
}
