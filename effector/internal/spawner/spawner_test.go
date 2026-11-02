package spawner

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/confine"
)

// The test binary doubles as the confiner and the spawner, as /opt/jr2/bin/effector does in a pod.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "confine" {
		syscall.Exit(confine.Main(os.Args[2:]))
	}
	if len(os.Args) > 1 && os.Args[1] == "spawner" {
		syscall.Exit(Main(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	os.Exit(m.Run())
}

// harness is the test's side of one spawner's channel.
type harness struct {
	t      *testing.T
	cmd    *exec.Cmd
	in     *os.File
	stderr *lockedBuffer
	frames chan map[string]any
	// held are frames that arrived while the test waited for another id.
	held []map[string]any
	// ended is closed when the spawner has ended; err is then its exit.
	ended chan struct{}
	err   error
}

// lockedBuffer is the spawner's stderr, which os/exec writes while a test reads it.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// wait is the spawner's exit, or false when it has not ended within d.
func (h *harness) wait(d time.Duration) (error, bool) {
	select {
	case <-h.ended:
		return h.err, true
	case <-time.After(d):
		return nil, false
	}
}

// socketPair is one end for the test and one for the spawner, as Node's `stdio: "pipe"` makes.
func socketPair(t *testing.T) (mine, theirs *os.File) {
	t.Helper()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	return os.NewFile(uintptr(fds[0]), "mine"), os.NewFile(uintptr(fds[1]), "theirs")
}

// start runs the spawner, confined by rules when rules has any.
func start(t *testing.T, rules *confine.Rules) *harness {
	t.Helper()
	args := []string{"spawner"}
	if rules != nil {
		args = append([]string{"confine"}, rules.Args(os.Args[0], []string{os.Args[0], "spawner"})...)
	}
	inMine, inTheirs := socketPair(t)
	outMine, outTheirs := socketPair(t)
	h := &harness{t: t, in: inMine, stderr: &lockedBuffer{}, frames: make(chan map[string]any, 1024),
		ended: make(chan struct{})}
	h.cmd = exec.Command(os.Args[0], args...)
	h.cmd.Stdin, h.cmd.Stdout, h.cmd.Stderr = inTheirs, outTheirs, h.stderr
	if err := h.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = inTheirs.Close()
	_ = outTheirs.Close()
	go func() {
		r := bufio.NewReader(outMine)
		for {
			line, err := r.ReadBytes('\n')
			if len(line) > 0 {
				var f map[string]any
				if err := json.Unmarshal(line, &f); err != nil {
					h.frames <- map[string]any{"op": "bad-json", "line": string(line)}
				} else {
					h.frames <- f
				}
			}
			if err != nil {
				close(h.frames)
				return
			}
		}
	}()
	go func() {
		h.err = h.cmd.Wait()
		close(h.ended)
	}()
	t.Cleanup(func() {
		_ = h.in.Close()
		if _, ok := h.wait(5 * time.Second); !ok {
			_ = h.cmd.Process.Kill()
		}
	})
	return h
}

func (h *harness) send(frame any) {
	h.t.Helper()
	var b []byte
	if s, ok := frame.(string); ok {
		b = []byte(s)
	} else {
		var err error
		if b, err = json.Marshal(frame); err != nil {
			h.t.Fatal(err)
		}
	}
	if _, err := h.in.Write(append(b, '\n')); err != nil {
		h.t.Fatal(err)
	}
}

// next is the next frame for id, within 10 s. A frame for another id is held for its own call.
func (h *harness) next(id string) map[string]any {
	h.t.Helper()
	for i, f := range h.held {
		if f["id"] == id {
			h.held = append(h.held[:i], h.held[i+1:]...)
			return f
		}
	}
	deadline := time.After(10 * time.Second)
	for {
		select {
		case f, ok := <-h.frames:
			if !ok {
				h.t.Fatalf("the channel ended while waiting for %s; stderr: %s", id, h.stderr.String())
			}
			if f["id"] == id {
				return f
			}
			h.held = append(h.held, f)
		case <-deadline:
			h.t.Fatalf("no frame for %s; stderr: %s", id, h.stderr.String())
		}
	}
}

// result is a spawn's whole answer: its pid, its output and its exit frame.
type result struct {
	pid            int
	stdout, stderr string
	exit           map[string]any
}

// collect reads the frames of spawn id up to its exit frame.
func (h *harness) collect(id string) result {
	h.t.Helper()
	var r result
	f := h.next(id)
	if f["op"] != "started" {
		h.t.Fatalf("%s: got %v, not started", id, f)
	}
	r.pid = int(f["pid"].(float64))
	for {
		f := h.next(id)
		switch f["op"] {
		case "out":
			b, err := base64.StdEncoding.DecodeString(f["data"].(string))
			if err != nil {
				h.t.Fatal(err)
			}
			if f["stream"] == "stdout" {
				r.stdout += string(b)
			} else {
				r.stderr += string(b)
			}
		case "exit":
			r.exit = f
			return r
		default:
			h.t.Fatalf("%s: unexpected frame %v", id, f)
		}
	}
}

var path = "/usr/local/bin:/usr/bin:/bin"

func spawnFrame(id string, argv ...string) map[string]any {
	return map[string]any{"op": "spawn", "id": id, "argv": argv, "env": map[string]string{"PATH": path}, "cwd": "/"}
}

func gone(pid int) bool {
	for range 100 {
		if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
			return true
		}
		if b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat"); err == nil {
			fields := strings.Fields(string(b[bytes.LastIndexByte(b, ')')+1:]))
			if len(fields) > 0 && fields[0] == "Z" {
				return true
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// A spawn runs argv with exactly the env it names, in its cwd, and answers started, its output on
// each stream, and its exit code.
func TestASpawnRunsArgvWithItsEnvAndCwdAndAnswersItsOutputAndExit(t *testing.T) {
	h := start(t, nil)
	dir := t.TempDir()
	h.send(map[string]any{"op": "spawn", "id": "1", "argv": []string{"sh", "-c", "env | sort; pwd; echo err >&2; exit 3"},
		"env": map[string]string{"PATH": path, "A_NAME": "a value"}, "cwd": dir})
	r := h.collect("1")
	want := "A_NAME=a value\nPATH=" + path + "\n"
	if !strings.HasPrefix(r.stdout, want) || !strings.Contains(r.stdout, dir+"\n") || r.stderr != "err\n" {
		t.Fatalf("stdout %q stderr %q", r.stdout, r.stderr)
	}
	if lines := strings.Split(strings.TrimSpace(r.stdout), "\n"); len(lines) != 4 {
		// sh itself adds PWD; nothing else of the spawner's own env.
		t.Fatalf("the child's env is not the frame's: %q", r.stdout)
	}
	if r.exit["code"] != float64(3) || r.exit["signal"] != nil {
		t.Fatalf("exit %v", r.exit)
	}
}

// The out frames keep the order in which the child wrote to its two streams: a write to stdout
// that comes before a write to stderr is never sent after it. (When both pipes hold output at one
// read, no reader can know the order; the spawner sends stdout first.) Many spawns at once load
// the host, as a loaded test run does.
func TestOutFramesKeepTheOrderOfTheTwoStreams(t *testing.T) {
	h := start(t, nil)
	const n = 30
	for i := range n {
		h.send(spawnFrame(strconv.Itoa(i), "sh", "-c", "echo out; echo err >&2"))
	}
	for i := range n {
		id := strconv.Itoa(i)
		if f := h.next(id); f["op"] != "started" {
			t.Fatalf("%s: got %v, not started", id, f)
		}
		var order []string
		for {
			f := h.next(id)
			if f["op"] == "exit" {
				break
			}
			b, _ := base64.StdEncoding.DecodeString(f["data"].(string))
			order = append(order, f["stream"].(string)+":"+string(b))
		}
		if got := strings.Join(order, ""); got != "stdout:out\nstderr:err\n" {
			t.Fatalf("%s: the frames are out of order: %q", id, got)
		}
	}
}

// stdin: a spawn with stdin true reads what the stdin frames send, and ends at stdin-end; one with
// stdin false reads /dev/null.
func TestStdinFramesReachTheChild(t *testing.T) {
	h := start(t, nil)
	f := spawnFrame("cat", "cat")
	f["stdin"] = true
	h.send(f)
	h.send(map[string]any{"op": "stdin", "id": "cat", "data": base64.StdEncoding.EncodeToString([]byte("one "))})
	h.send(map[string]any{"op": "stdin", "id": "cat", "data": base64.StdEncoding.EncodeToString([]byte("two"))})
	h.send(map[string]any{"op": "stdin-end", "id": "cat"})
	if r := h.collect("cat"); r.stdout != "one two" || r.exit["code"] != float64(0) {
		t.Fatalf("%+v", r)
	}
	h.send(spawnFrame("null", "cat"))
	if r := h.collect("null"); r.stdout != "" || r.exit["code"] != float64(0) {
		t.Fatalf("%+v", r)
	}
}

// Each spawn leads its own process group, and a signal frame reaches the whole group: the shell and
// the process that it started.
func TestASignalReachesTheSpawnsProcessGroup(t *testing.T) {
	h := start(t, nil)
	h.send(spawnFrame("g", "sh", "-c", "sleep 100 & echo $!; wait"))
	started := h.next("g")
	pid := int(started["pid"].(float64))
	if pgid, err := syscall.Getpgid(pid); err != nil || pgid != pid {
		t.Fatalf("the child does not lead its own group: pgid %d %v", pgid, err)
	}
	out := h.next("g")
	b, _ := base64.StdEncoding.DecodeString(out["data"].(string))
	sleeper, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		t.Fatalf("%v: %q", err, b)
	}
	h.send(map[string]any{"op": "signal", "id": "g", "signal": "SIGTERM"})
	if exit := h.next("g"); exit["op"] != "exit" || exit["signal"] != "SIGTERM" || exit["code"] != nil {
		t.Fatalf("exit %v", exit)
	}
	if !gone(sleeper) {
		t.Fatal("the process the shell started is alive")
	}
}

// A process that the spawn leaves running holds the pipes open; exit still comes, and the group can
// be signalled by the spawn's id after it.
func TestExitComesWhileABackgroundProcessHoldsThePipes(t *testing.T) {
	h := start(t, nil)
	h.send(spawnFrame("bg", "sh", "-c", "sleep 100 & echo $!"))
	began := time.Now()
	r := h.collect("bg")
	if time.Since(began) > 5*time.Second || r.exit["code"] != float64(0) {
		t.Fatalf("exit %v after %v", r.exit, time.Since(began))
	}
	sleeper, err := strconv.Atoi(strings.TrimSpace(r.stdout))
	if err != nil {
		t.Fatal(err)
	}
	if syscall.Kill(sleeper, 0) != nil {
		t.Fatal("the background process ended with the shell")
	}
	h.send(map[string]any{"op": "signal", "id": "bg", "signal": "SIGKILL"})
	if !gone(sleeper) {
		t.Fatal("a signal after exit did not reach the group")
	}
}

// What cannot start answers error with its errno, and the spawner goes on.
func TestASpawnThatCannotStartAnswersItsErrno(t *testing.T) {
	h := start(t, nil)
	h.send(spawnFrame("missing", "no-such-program-jr2"))
	if f := h.next("missing"); f["op"] != "error" || f["code"] != "ENOENT" {
		t.Fatalf("%v", f)
	}
	f := spawnFrame("cwd", "true")
	f["cwd"] = "/no/such/folder"
	h.send(f)
	if f := h.next("cwd"); f["op"] != "error" || f["code"] != "ENOENT" {
		t.Fatalf("%v", f)
	}
	h.send(spawnFrame("ok", "true"))
	if r := h.collect("ok"); r.exit["code"] != float64(0) {
		t.Fatalf("%+v", r)
	}
}

// read, write, stat, readdir and unlink: a write makes the missing folders; a read answers the
// bytes; a stat answers the kind, the size and the real path; a readdir answers the sorted names; an
// unlink removes a link's own name and not what it names, and removes no folder; a failure answers
// the errno.
func TestFileOps(t *testing.T) {
	h := start(t, nil)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "a", "b", "f.txt")
	data := []byte("bytes \x00\xff of a file\n")
	h.send(map[string]any{"op": "write", "id": "w", "path": file, "data": base64.StdEncoding.EncodeToString(data)})
	if f := h.next("w"); f["op"] != "ok" {
		t.Fatalf("%v", f)
	}
	h.send(map[string]any{"op": "read", "id": "r", "path": file})
	f := h.next("r")
	if got, _ := base64.StdEncoding.DecodeString(fmt.Sprint(f["data"])); f["op"] != "ok" || !bytes.Equal(got, data) {
		t.Fatalf("%v", f)
	}
	if err := os.Symlink(file, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	h.send(map[string]any{"op": "stat", "id": "s", "path": filepath.Join(dir, "link")})
	if f := h.next("s"); f["op"] != "ok" || f["kind"] != "file" || f["size"] != float64(len(data)) ||
		f["realpath"] != file || f["mtimeMs"] == nil {
		t.Fatalf("%v", f)
	}
	h.send(map[string]any{"op": "stat", "id": "d", "path": dir})
	if f := h.next("d"); f["kind"] != "directory" {
		t.Fatalf("%v", f)
	}
	h.send(map[string]any{"op": "readdir", "id": "ls", "path": dir})
	if f := h.next("ls"); f["op"] != "ok" || fmt.Sprint(f["names"]) != "[a link]" {
		t.Fatalf("%v", f)
	}
	h.send(map[string]any{"op": "readdir", "id": "ls-empty", "path": filepath.Join(dir, "a", "b", "c")})
	if f := h.next("ls-empty"); f["op"] != "error" || f["code"] != "ENOENT" {
		t.Fatalf("%v", f)
	}
	h.send(map[string]any{"op": "unlink", "id": "rm-link", "path": filepath.Join(dir, "link")})
	if f := h.next("rm-link"); f["op"] != "ok" {
		t.Fatalf("%v", f)
	}
	if _, err := os.Lstat(filepath.Join(dir, "link")); !os.IsNotExist(err) {
		t.Fatal("the link is still there")
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("the unlink of a link removed what it names: %v", err)
	}
	for id, frame := range map[string]map[string]any{
		"ENOENT":  {"op": "read", "path": filepath.Join(dir, "none")},
		"EISDIR":  {"op": "read", "path": dir},
		"EINVAL":  {"op": "stat", "path": "relative/path"},
		"ENOTDIR": {"op": "readdir", "path": file},
		// unlink(2) of a folder: Linux answers EISDIR; the folder stays.
		"unlink-dir":     {"op": "unlink", "path": filepath.Join(dir, "a")},
		"unlink-missing": {"op": "unlink", "path": filepath.Join(dir, "none")},
		"unlink-rel":     {"op": "unlink", "path": "relative"},
		"readdir-rel":    {"op": "readdir", "path": "relative"},
	} {
		frame["id"] = id
		h.send(frame)
		want := map[string]string{"unlink-dir": "EISDIR", "unlink-missing": "ENOENT", "unlink-rel": "EINVAL",
			"readdir-rel": "EINVAL"}[id]
		if want == "" {
			want = id
		}
		if f := h.next(id); f["op"] != "error" || f["code"] != want || f["message"] == "" {
			t.Errorf("%s: %v", id, f)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "a", "b", "f.txt")); err != nil {
		t.Fatalf("the unlink of a folder removed it: %v", err)
	}
}

// A frame with an id and a wrong op or field answers EINVAL and the channel goes on; a second spawn
// with an id in use is refused. A frame that is not JSON, or has no id, ends the spawner: the two
// sides no longer agree.
func TestAnInvalidFrame(t *testing.T) {
	h := start(t, nil)
	for id, frame := range map[string]map[string]any{
		"op":     {"op": "fly"},
		"argv":   {"op": "spawn", "argv": []string{}},
		"signal": {"op": "signal", "signal": "SIGNOPE"},
		"data":   {"op": "write", "path": "/x", "data": "not base64!"},
	} {
		frame["id"] = id
		h.send(frame)
		if f := h.next(id); f["op"] != "error" || f["code"] != "EINVAL" {
			t.Errorf("%s: %v", id, f)
		}
	}
	h.send(spawnFrame("dup", "sleep", "1"))
	h.next("dup")
	h.send(spawnFrame("dup", "true"))
	if f := h.next("dup"); f["op"] != "error" || f["code"] != "EINVAL" {
		t.Fatalf("a second spawn with an id in use: %v", f)
	}
	for _, bad := range []any{"this is not json", map[string]any{"op": "read", "path": "/x"},
		map[string]any{"op": "read", "id": 7, "path": "/x"}} {
		h := start(t, nil)
		h.send(bad)
		err, ok := h.wait(5 * time.Second)
		if !ok {
			t.Fatalf("%v: the spawner went on", bad)
		}
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 2 {
			t.Fatalf("%v: the spawner ended with %v", bad, err)
		}
	}
}

// A child holds no fd of the channel: its open fds are its own pipes and /dev/null, and none is a
// socket. And a process of the domain cannot open the spawner's channel through /proc.
func TestAChildHoldsNoFdOfTheChannelAndCannotOpenIt(t *testing.T) {
	h := start(t, nil)
	h.send(spawnFrame("fds", "sh", "-c", `for f in /proc/$$/fd/*; do echo "$f $(readlink "$f")"; done`))
	r := h.collect("fds")
	if strings.Contains(r.stdout, "socket:") || r.exit["code"] != float64(0) {
		t.Fatalf("the child holds a socket: %q", r.stdout)
	}
	if n := len(strings.Split(strings.TrimSpace(r.stdout), "\n")); n > 4 {
		// 0, 1, 2 and the one the glob read, at most.
		t.Fatalf("the child holds more fds than its own: %q", r.stdout)
	}
	spawner := h.cmd.Process.Pid
	for _, fd := range []string{"0", "1"} {
		p := "/proc/" + strconv.Itoa(spawner) + "/fd/" + fd
		id := "open-" + fd
		h.send(spawnFrame(id, "sh", "-c", "echo injected > "+p+" || exit 7; cat "+p))
		if r := h.collect(id); r.exit["code"] == float64(0) {
			t.Fatalf("a child opened %s: %+v", p, r)
		}
	}
}

// The spawner refuses a channel that is a pipe, which a process of the domain could open again
// through /proc/<pid>/fd and so put a frame on.
func TestTheSpawnerRefusesAPipe(t *testing.T) {
	cmd := exec.Command(os.Args[0], "spawner")
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	cmd.Stdin = r
	var out bytes.Buffer
	cmd.Stderr = &out
	err = cmd.Run()
	_ = r.Close()
	if err == nil || !strings.Contains(out.String(), "is not a socket") {
		t.Fatalf("%v: %q", err, out.String())
	}
}

// When the channel ends, the spawner ends with 0, and what it started runs on.
func TestWhatTheSpawnerStartedRunsOnAfterIt(t *testing.T) {
	h := start(t, nil)
	h.send(spawnFrame("long", "sleep", "100"))
	pid := int(h.next("long")["pid"].(float64))
	t.Cleanup(func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })
	_ = h.in.Close()
	err, ok := h.wait(5 * time.Second)
	if !ok {
		t.Fatal("the spawner did not end with its channel")
	}
	if err != nil {
		t.Fatalf("the spawner ended with %v: %s", err, h.stderr.String())
	}
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("the process ended with the spawner: %v", err)
	}
}

// In the Harness's domain (ADR-0076): two spawns are one domain, so a later call reads the /proc
// of a process that an earlier call started and ends it; the file ops and the children reach
// nothing under the denied path, by its name or through a link.
func TestInTheDomainSpawnsShareItAndReachNothingDenied(t *testing.T) {
	if _, err := confine.Probe(); err != nil {
		t.Fatalf("these tests need Landlock on the host: %v", err)
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	denied := filepath.Join(root, "run-jr2")
	work := filepath.Join(root, "work")
	for _, d := range []string{filepath.Join(denied, "control"), work} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	standin := filepath.Join(denied, "control", "standin")
	if err := os.WriteFile(standin, []byte("control-stand-in-value"), 0o400); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(standin, filepath.Join(work, "link")); err != nil {
		t.Fatal(err)
	}
	rules, err := confine.ForHarness("/", []string{denied})
	if err != nil {
		t.Fatal(err)
	}
	h := start(t, &rules)

	server := spawnFrame("server", "sleep", "100")
	server["env"] = map[string]string{"PATH": path, "JR2_TEST_MARK": "the server"}
	h.send(server)
	pid := int(h.next("server")["pid"].(float64))
	h.send(spawnFrame("later", "sh", "-c", fmt.Sprintf(
		"tr '\\0' '\\n' < /proc/%d/environ | grep -x 'JR2_TEST_MARK=the server' && readlink /proc/%d/cwd && kill %d",
		pid, pid, pid)))
	if r := h.collect("later"); r.exit["code"] != float64(0) || !strings.Contains(r.stdout, "JR2_TEST_MARK=the server\n/\n") {
		t.Fatalf("a later call cannot reach an earlier call's process: %+v", r)
	}
	if exit := h.next("server"); exit["op"] != "exit" || exit["signal"] != "SIGTERM" {
		t.Fatalf("the server: %v", exit)
	}

	h.send(spawnFrame("cat", "cat", standin))
	if r := h.collect("cat"); r.exit["code"] == float64(0) || strings.Contains(r.stdout, "stand-in") {
		t.Fatalf("a child read the Stand-in: %+v", r)
	}
	for id, frame := range map[string]map[string]any{
		"read":         {"op": "read", "path": standin},
		"read-link":    {"op": "read", "path": filepath.Join(work, "link")},
		"write":        {"op": "write", "path": filepath.Join(denied, "control", "new"), "data": ""},
		"write-link":   {"op": "write", "path": filepath.Join(work, "link"), "data": "eA=="},
		"write-folder": {"op": "write", "path": filepath.Join(denied, "made", "f"), "data": ""},
		"unlink":       {"op": "unlink", "path": standin},
	} {
		frame["id"] = id
		h.send(frame)
		if f := h.next(id); f["op"] != "error" || f["code"] != "EACCES" {
			t.Errorf("%s: %v", id, f)
		}
	}
	h.send(map[string]any{"op": "write", "id": "ok", "path": filepath.Join(work, "deep", "f"), "data": "eA=="})
	if f := h.next("ok"); f["op"] != "ok" {
		t.Fatalf("a write in the Worktree: %v", f)
	}
	// The domain lists the names under the denied path (READ_DIR on the root), and no more.
	h.send(map[string]any{"op": "readdir", "id": "ls-denied", "path": filepath.Join(denied, "control")})
	if f := h.next("ls-denied"); f["op"] != "ok" || fmt.Sprint(f["names"]) != "[standin]" {
		t.Fatalf("a readdir of the denied path: %v", f)
	}
	h.send(map[string]any{"op": "unlink", "id": "rm-ok", "path": filepath.Join(work, "deep", "f")})
	if f := h.next("rm-ok"); f["op"] != "ok" {
		t.Fatalf("an unlink in the Worktree: %v", f)
	}
	if b, _ := os.ReadFile(standin); string(b) != "control-stand-in-value" {
		t.Fatalf("the Stand-in changed: %q", b)
	}
}

// Many spawns at once each answer their own output and exit, and the frames of one never carry
// another's bytes.
func TestConcurrentSpawnsKeepTheirOwnFrames(t *testing.T) {
	h := start(t, nil)
	const n = 20
	for i := range n {
		h.send(spawnFrame("c"+strconv.Itoa(i), "sh", "-c", fmt.Sprintf("for j in 1 2 3; do echo %d-$j; done", i)))
	}
	var mu sync.Mutex
	got := map[string]string{}
	exits := 0
	deadline := time.After(20 * time.Second)
	for exits < n {
		select {
		case f := <-h.frames:
			id := fmt.Sprint(f["id"])
			switch f["op"] {
			case "out":
				b, _ := base64.StdEncoding.DecodeString(f["data"].(string))
				mu.Lock()
				got[id] += string(b)
				mu.Unlock()
			case "exit":
				exits++
			}
		case <-deadline:
			t.Fatalf("%d exits of %d", exits, n)
		}
	}
	for i := range n {
		id := "c" + strconv.Itoa(i)
		want := fmt.Sprintf("%d-1\n%d-2\n%d-3\n", i, i, i)
		if got[id] != want {
			t.Errorf("%s: %q", id, got[id])
		}
	}
}
