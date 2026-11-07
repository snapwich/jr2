package pushkind

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/snapwich/jr2/effector/internal/gitclean"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// serveTransfer is a git-lfs-transfer server for one session, written to git-lfs's
// docs/proposals/ssh_adapter.md: the capability advertisement, `version 1`, `batch`,
// `put-object`, `verify-object` and `quit`. The test binary runs it (TestMain) as
// `lfs-transfer <store> <modes> <operation>`, where the test's ssh sends git-lfs-transfer. An
// object is the file <store>/<oid>; a put-object writes <store>/pending-<oid>, and its
// verify-object makes it the object. Each command is logged in <store>/log as
// `<operation> <command>`. modes is a comma list:
//   - refuse-put: every put-object answers 422.
//   - always-upload: an upload batch gives every object `upload`, held or not.
//   - drop: a put-object and its verify-object answer 200 and store nothing.
func serveTransfer(args []string, in io.Reader, out io.Writer) int {
	if len(args) != 3 {
		return 2
	}
	s := &transferServer{store: args[0], modes: strings.Split(args[1], ","), op: args[2],
		r: bufio.NewReader(in), w: bufio.NewWriter(out)}
	s.text("version=1")
	s.flush()
	for {
		head, data, ok := s.read()
		if !ok || len(head) == 0 {
			return 0
		}
		command, arg, _ := strings.Cut(head[0], " ")
		s.log(command)
		switch command {
		case "version":
			s.status(200, "")
		case "quit":
			s.status(200, "")
			return 0
		case "batch":
			s.batch(head[1:], data)
		case "put-object":
			s.put(arg, head[1:], data)
		case "verify-object":
			s.verify(arg)
		default:
			s.status(400, "unknown command")
		}
	}
}

// transferServer is one session of serveTransfer.
type transferServer struct {
	store string
	modes []string
	op    string
	r     *bufio.Reader
	w     *bufio.Writer
}

func (s *transferServer) text(t string) { _, _ = fmt.Fprintf(s.w, "%04x%s\n", len(t)+5, t) }
func (s *transferServer) flush()        { _, _ = s.w.WriteString("0000"); _ = s.w.Flush() }
func (s *transferServer) delim()        { _, _ = s.w.WriteString("0001") }
func (s *transferServer) mode(m string) bool {
	return slices.Contains(s.modes, m)
}

func (s *transferServer) status(code int, msg string) {
	s.text("status " + strconv.Itoa(code))
	if msg != "" {
		s.delim()
		s.text(msg)
	}
	s.flush()
}

func (s *transferServer) log(command string) {
	f, err := os.OpenFile(filepath.Join(s.store, "log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err == nil {
		_, _ = fmt.Fprintf(f, "%s %s\n", s.op, command)
		_ = f.Close()
	}
}

func (s *transferServer) held(oid string) bool {
	_, err := os.Stat(filepath.Join(s.store, oid))
	return err == nil
}

// read reads one message: its text packets before a delimiter, and the raw bytes after it.
func (s *transferServer) read() (head []string, data []byte, ok bool) {
	seenDelim := false
	for {
		var n4 [4]byte
		if _, err := io.ReadFull(s.r, n4[:]); err != nil {
			return nil, nil, false
		}
		n, err := strconv.ParseUint(string(n4[:]), 16, 16)
		if err != nil {
			return nil, nil, false
		}
		switch n {
		case 0:
			return head, data, true
		case 1:
			seenDelim = true
			continue
		}
		body := make([]byte, n-4)
		if _, err := io.ReadFull(s.r, body); err != nil {
			return nil, nil, false
		}
		if seenDelim {
			data = append(data, body...)
		} else {
			head = append(head, strings.TrimSuffix(string(body), "\n"))
		}
	}
}

func (s *transferServer) batch(args []string, data []byte) {
	if !slices.Contains(args, "hash-algo=sha256") {
		s.status(400, "no hash-algo=sha256")
		return
	}
	s.text("status 200")
	s.delim()
	for line := range strings.SplitSeq(strings.TrimSpace(string(data)), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		action := "noop"
		switch {
		case s.op == "download" && s.held(f[0]):
			action = "download"
		case s.op == "upload" && (!s.held(f[0]) || s.mode("always-upload")):
			action = "upload"
		}
		s.text(f[0] + " " + f[1] + " " + action)
	}
	s.flush()
}

func (s *transferServer) put(oid string, args []string, data []byte) {
	sum := sha256.Sum256(data)
	switch {
	case s.op != "upload":
		s.status(405, "not an upload session")
	case s.mode("refuse-put"):
		s.status(422, "the test server refuses the object")
	case hex.EncodeToString(sum[:]) != oid || !slices.Contains(args, "size="+strconv.Itoa(len(data))):
		s.status(400, "the object does not match its oid or its size")
	case s.mode("drop"):
		s.status(200, "")
	default:
		tmp := filepath.Join(s.store, "tmp-"+oid+"-"+strconv.Itoa(os.Getpid()))
		if os.WriteFile(tmp, data, 0o600) != nil || os.Rename(tmp, filepath.Join(s.store, "pending-"+oid)) != nil {
			s.status(500, "the store failed")
			return
		}
		s.status(200, "")
	}
}

func (s *transferServer) verify(oid string) {
	switch {
	case s.mode("drop"):
		s.status(200, "")
	case os.Rename(filepath.Join(s.store, "pending-"+oid), filepath.Join(s.store, oid)) == nil || s.held(oid):
		s.status(200, "")
	default:
		s.status(404, "no such object")
	}
}

// sshServer is what the test's ssh serves on the LFS host: git-lfs-transfer from store with
// modes ("" serves none: `command not found`), and git-lfs-authenticate with href ("" serves
// none).
type sshServer struct {
	store, modes, href string
}

// sshServerTools is sshTools with a git-lfs-transfer server: a program folder with git and sh from
// the host, and an ssh that logs each call and serves git's and git-lfs's remote commands.
func sshServerTools(t *testing.T, srv sshServer) (logFile string) {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"git", "sh"} {
		p, err := exec.LookPath(name)
		if err != nil {
			t.Skip("no " + name)
		}
		if err := os.Symlink(p, filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("no bash")
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	logFile = filepath.Join(t.TempDir(), "ssh.log")
	transfer := `echo "git-lfs-transfer: command not found" >&2; exit 127`
	if srv.store != "" {
		transfer = fmt.Sprintf(`exec %q lfs-transfer %q %q "${cmd##* }"`, self, srv.store, srv.modes+",")
	}
	authenticate := `echo "git-lfs-authenticate: command not found" >&2; exit 127`
	if srv.href != "" {
		authenticate = fmt.Sprintf(`printf '{"href":"%s","header":{"%s":"from-authenticate"}}\n'; exit 0`, srv.href,
			hrefHeader)
	}
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
  git-lfs-transfer*) %s;;
  git-lfs-authenticate*) %s;;
  git-receive-pack*|git-upload-pack*) exec sh -c "$cmd";;
esac
echo "unknown command" >&2
exit 1
`, bash, logFile, transfer, authenticate)
	if err := os.WriteFile(filepath.Join(dir, "ssh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	old := gitclean.Path
	gitclean.Path = dir
	t.Cleanup(func() { gitclean.Path = old })
	return logFile
}

// sshPush makes f push over ssh to lfs-host.test with a push key, and answers the request. The
// request pins the Agent's branch, so it is made after the test's commits.
func sshPush(t *testing.T, f *fixture) *wire.StartRequest {
	t.Helper()
	dir := filepath.Join(f.runner.GitRoot, "push")
	for name, body := range map[string]string{secrets.PushKeyFile: "a fake key\n", secrets.KnownHostsFile: ""} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o400); err != nil {
			t.Fatal(err)
		}
	}
	f.runner.Config.Git[0].Push = &secrets.GitAuth{SSHKey: "push"}
	req := f.lfsRequest(false)
	req.Push.URL = "ssh://git@lfs-host.test" + f.pod.Remote
	return req
}

// transferLog is the commands that the transfer server saw, as `<operation> <command>`.
func transferLog(t *testing.T, store string) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(store, "log"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return strings.Fields(strings.ReplaceAll(strings.TrimSpace(string(raw)), " ", "_"))
}

// A server that speaks only the pure SSH protocol: git-lfs uploads over git-lfs-transfer, the
// check asks over git-lfs-transfer with a download batch, and the push is `pushed`.
func TestAPureSSHServerTakesThePush(t *testing.T) {
	f := lfsFixture(t, "")
	store := t.TempDir()
	log := sshServerTools(t, sshServer{store: store})
	content := "over the pure ssh protocol\n"
	sha, oid := largeFile(t, f, "big.bin", content, true)
	req := sshPush(t, f)

	out := f.runner.Run(t.Context(), req)
	raw, _ := os.ReadFile(log)
	if out.Outcome != wire.OutcomePushed || out.Push.Published != sha {
		t.Fatalf("got %+v %+v; ssh log:\n%s\ntransfer log: %v", out, out.Push, raw, transferLog(t, store))
	}
	if got, _ := os.ReadFile(filepath.Join(store, oid)); string(got) != content {
		t.Fatalf("the server holds %q", got)
	}
	seen := transferLog(t, store)
	for _, want := range []string{"upload_put-object", "upload_verify-object", "download_batch"} {
		if !slices.Contains(seen, want) {
			t.Errorf("the server never saw %s: %v", want, seen)
		}
	}
	if slices.Contains(seen, "download_put-object") {
		t.Errorf("the check sent an object: %v", seen)
	}
	for l := range strings.SplitSeq(strings.TrimSpace(string(raw)), "\n") {
		if strings.Contains(l, "git-lfs-authenticate") {
			t.Errorf("git-lfs-authenticate ran though the server speaks git-lfs-transfer: %s", l)
		}
		if !strings.Contains(l, "/push-key ") || !strings.Contains(l, "StrictHostKeyChecking=yes") ||
			!strings.Contains(l, "BatchMode=yes") || !strings.Contains(l, "git@lfs-host.test") {
			t.Errorf("an ssh call without the call's command: %s", l)
		}
	}
	// Pushed again with a new commit that keeps the file: no pointer is new, so nothing is asked.
	n := len(transferLog(t, store))
	f.pod.Commit("small", map[string]string{"notes.txt": "n\n"})
	req = f.lfsRequest(false)
	req.Push.URL = "ssh://git@lfs-host.test" + f.pod.Remote
	if next := f.runner.Run(t.Context(), req); next.Outcome != wire.OutcomePushed {
		t.Fatalf("next: %+v %+v", next, next.Push)
	}
	if len(transferLog(t, store)) != n {
		t.Fatal("a push of no new pointer spoke to the LFS server")
	}
}

// A pure SSH server that refuses the object: git-lfs fails, the push is `rejected` at stage
// `upload`, and no ref moves.
func TestAPureSSHServerThatRefusesTheObjectIsRejected(t *testing.T) {
	f := lfsFixture(t, "")
	store := t.TempDir()
	sshServerTools(t, sshServer{store: store, modes: "refuse-put"})
	before := remoteRef(f)
	_, oid := largeFile(t, f, "big.bin", "refused over ssh\n", true)
	req := sshPush(t, f)

	out := f.runner.Run(t.Context(), req)
	t.Logf("%s | %s", out.Reason, out.Push.Detail)
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "upload" || !strings.Contains(out.Reason, "big.bin") ||
		!strings.Contains(out.Reason, "nothing was pushed") {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != before {
		t.Fatal("the branch moved")
	}
	if _, err := os.Stat(filepath.Join(store, oid)); err == nil {
		t.Fatal("the server holds the object")
	}
}

// A pure SSH server whose put-object and verify-object answer 200 and store nothing: git-lfs
// exits 0, and the check, a download batch over git-lfs-transfer, sees that the server lacks the
// object. The push is `rejected`, and no ref moves.
func TestAPureSSHServerThatDropsTheObjectIsRejectedByTheCheck(t *testing.T) {
	f := lfsFixture(t, "")
	store := t.TempDir()
	sshServerTools(t, sshServer{store: store, modes: "drop"})
	before := remoteRef(f)
	largeFile(t, f, "big.bin", "dropped over ssh\n", true)
	req := sshPush(t, f)

	out := f.runner.Run(t.Context(), req)
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "upload" ||
		!strings.Contains(out.Reason, "does not hold the objects of big.bin") {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != before {
		t.Fatal("the branch moved")
	}
}

// Q20 over the pure SSH protocol: an object that no local store holds is pushed when a download
// batch says that the server holds it, and is rejected when it says that the server lacks it.
func TestAPureSSHServerThatHoldsAnObjectNeedsNoLocalCopy(t *testing.T) {
	for _, onServer := range []bool{true, false} {
		// The name is in the remote's path, which an ssh url holds: no "=".
		name := map[bool]string{true: "held", false: "lacking"}[onServer]
		t.Run(name, func(t *testing.T) {
			f := lfsFixture(t, "")
			store := t.TempDir()
			sshServerTools(t, sshServer{store: store, modes: "always-upload"})
			before := remoteRef(f)
			content := "only on the server\n"
			sha, oid := largeFile(t, f, "held.bin", content, false)
			req := sshPush(t, f)
			if onServer {
				if err := os.WriteFile(filepath.Join(store, oid), []byte(content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			out := f.runner.Run(t.Context(), req)
			seen := transferLog(t, store)
			if onServer {
				if out.Outcome != wire.OutcomePushed || out.Push.Published != sha {
					t.Fatalf("got %+v %+v", out, out.Push)
				}
				if slices.ContainsFunc(seen, func(s string) bool { return strings.HasPrefix(s, "upload_") }) {
					t.Fatalf("an upload session ran: %v", seen)
				}
				return
			}
			if out.Outcome != wire.OutcomeRejected || !strings.Contains(out.Reason, "held.bin") ||
				!strings.Contains(out.Reason, "in neither") || remoteRef(f) != before {
				t.Fatalf("got %+v %+v", out, out.Push)
			}
		})
	}
}

// A server with git-lfs-authenticate and no git-lfs-transfer still works: the check, as git-lfs,
// falls back to git-lfs-authenticate after git-lfs-transfer fails, and asks a download batch.
func TestAnSSHServerWithOnlyGitLFSAuthenticateStillTakesThePush(t *testing.T) {
	f := lfsFixture(t, "")
	lfs := newLFSServer(t, f)
	srv := httptestServer(t, lfs)
	log := sshServerTools(t, sshServer{href: srv + "/lfs"})
	content := "through git-lfs-authenticate\n"
	sha, oid := largeFile(t, f, "big.bin", content, true)
	req := sshPush(t, f)

	out := f.runner.Run(t.Context(), req)
	raw, _ := os.ReadFile(log)
	if out.Outcome != wire.OutcomePushed || out.Push.Published != sha || string(lfs.held(oid)) != content {
		t.Fatalf("got %+v %+v; ssh log:\n%s", out, out.Push, raw)
	}
	var transfer, authenticate bool
	for l := range strings.SplitSeq(string(raw), "\n") {
		transfer = transfer || strings.Contains(l, "git-lfs-transfer")
		authenticate = authenticate || strings.Contains(l, "git-lfs-authenticate")
	}
	if !transfer || !authenticate {
		t.Fatalf("the negotiation did not try git-lfs-transfer, then git-lfs-authenticate:\n%s", raw)
	}
}

// The client of the pure SSH protocol reads what a server may send: arguments after the status,
// an oid listed once per action, an oid that was not asked, and a status with a message.
func TestTheTransferClientReadsABatchAnswer(t *testing.T) {
	a, b := strings.Repeat("a", 64), strings.Repeat("b", 64)
	pkt := func(s string) string { return fmt.Sprintf("%04x%s\n", len(s)+5, s) }
	for _, tc := range []struct {
		name, answer string
		want         map[string]lfsState
		err          string
	}{
		{"held and not", pkt("status 200") + pkt("hash-algo=sha256") + "0001" + pkt(a+" 3 download id=x") +
			pkt(b+" 4 noop") + pkt(strings.Repeat("c", 64)+" 1 download") + "0000",
			map[string]lfsState{a: {held: true}, b: {}}, ""},
		{"refused", pkt("status 403") + "0001" + pkt("not yours") + "0000", nil, "403 (not yours)"},
		{"another hash", pkt("status 200") + pkt("hash-algo=sha512") + "0001" + "0000", nil, "sha512"},
		{"a short line", pkt("status 200") + "0001" + pkt(a+" 3") + "0000", nil, "not `oid size action`"},
		{"cut", pkt("status 200") + "0001" + pkt(a+" 3 download"), nil, "ended the session"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &lfsTransfer{w: nopWriteCloser{io.Discard}, r: bufio.NewReader(strings.NewReader(tc.answer))}
			got, err := s.batch([]lfsObject{{oid: a, size: 3}, {oid: b, size: 4}})
			if tc.err != "" {
				if err == nil || !strings.Contains(err.Error(), tc.err) {
					t.Fatalf("got %v, want an error with %q", err, tc.err)
				}
				return
			}
			if err != nil || len(got) != len(tc.want) || got[a] != tc.want[a] || got[b] != tc.want[b] {
				t.Fatalf("got %+v, %v", got, err)
			}
		})
	}
}

func httptestServer(t *testing.T, h http.Handler) string {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv.URL
}

type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }
