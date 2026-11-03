// Package spawner is `effector spawner` (ADR-0076): the one process of the Harness's Landlock
// domain that the Harness talks to. The Harness starts it once, confined
// (`effector confine <harness-rules> -- effector spawner`), and asks it to start each process that a
// model drives and to do each file tool's I/O. A process inherits its parent's domain, so every
// program of every Agent of the Sandbox is in the one domain: they see, signal and trace each
// other, as one user's processes do on a machine. The spawner adds no Landlock layer of its own.
//
// The channel is the spawner's stdin (frames from the Harness) and stdout (frames to the Harness).
// Both must be sockets, which the Harness makes (Node's `stdio: "pipe"` is a socketpair): a socket
// cannot be opened again through `/proc/<spawner>/fd/N` (ENXIO), so a process of the domain cannot
// put a frame on the channel by that path. The spawner refuses to start on any other kind of file.
// It is also not dumpable (PR_SET_DUMPABLE 0), so a process of the domain cannot ptrace it or open
// its `/proc/<pid>/fd`. A child holds no fd of the channel: every fd of the spawner is close-on-exec,
// and a child's 0, 1 and 2 are its own pipes (or /dev/null).
//
// A frame is one JSON object on one line. Bytes travel as base64. From the Harness:
//
//	{"op":"spawn","id":ID,"argv":[...],"env":{NAME:VALUE},"cwd":PATH,"stdin":BOOL}
//	{"op":"stdin","id":ID,"data":B64}
//	{"op":"stdin-end","id":ID}
//	{"op":"signal","id":ID,"signal":"SIGTERM"}     to the process group of spawn ID
//	{"op":"read","id":ID,"path":ABS}
//	{"op":"write","id":ID,"path":ABS,"data":B64}   makes the missing folders, then the file
//	{"op":"stat","id":ID,"path":ABS}               follows links
//	{"op":"readdir","id":ID,"path":ABS}            the names in a folder
//	{"op":"unlink","id":ID,"path":ABS}             removes one name; never a folder, never what a link names
//
// To the Harness:
//
//	{"id":ID,"op":"started","pid":N}
//	{"id":ID,"op":"out","stream":"stdout"|"stderr","data":B64}
//	{"id":ID,"op":"exit","code":N|null,"signal":"SIGKILL"|null}   the last frame of a spawn
//	{"id":ID,"op":"ok"}                                            write, unlink
//	{"id":ID,"op":"ok","data":B64}                                 read
//	{"id":ID,"op":"ok","names":[NAME,...]}                         readdir, sorted
//	{"id":ID,"op":"ok","kind":"file"|"directory"|"other","size":N,"mtimeMs":N,"realpath":ABS}  stat
//	{"id":ID,"op":"error","code":"ENOENT","message":TEXT}
//
// An ID is a non-empty string. A spawn's ID names that spawn until its exit frame; a file op's ID
// is answered once. A spawn either answers `error` (it did not start) or `started`, then any `out`,
// then `exit`. `exit` comes when the process has ended and both of its pipes have ended, or
// GraceAfterExit after its last output: a background process that keeps the pipes open does not
// hold the call. Then the spawner closes its ends of the pipes.
//
// `stdin`, `stdin-end` and `signal` have no answer when they succeed; a signal to a group that has
// ended does nothing. A frame that is not JSON, or has no string ID, ends the spawner (exit 2): the
// Harness and the spawner no longer agree on the channel. A frame with an ID and an unknown op or
// wrong fields answers `error` with code EINVAL.
//
// When the channel ends, the spawner ends. The processes that it started run on, each in its own
// process group.
package spawner

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// GraceAfterExit is how long a spawn's pipes may stay quiet after its process ended before the
// spawner sends `exit`: the Harness's own grace (shell.ts, EXIT_STDIO_GRACE_MS).
var GraceAfterExit = 100 * time.Millisecond

// maxFrame is the longest line the spawner reads: a write of a large file is one frame.
const maxFrame = 1 << 30

// keepExited is how long a spawn's process group stays signallable by its ID after its exit
// frame: the Harness ends the group of a `command` Effect when its top process exits (exec.ts).
const keepExited = 5 * time.Minute

const prSetDumpable = 4

// The ops that the spawner names in more than one place.
const (
	opSpawn   = "spawn"
	opRead    = "read"
	opWrite   = "write"
	opStat    = "stat"
	opReaddir = "readdir"
	opUnlink  = "unlink"
)

// inFrame is every field a frame from the Harness can carry.
type inFrame struct {
	Op     string            `json:"op"`
	ID     *string           `json:"id"`
	Argv   []string          `json:"argv"`
	Env    map[string]string `json:"env"`
	Cwd    string            `json:"cwd"`
	Stdin  bool              `json:"stdin"`
	Data   *string           `json:"data"`
	Signal string            `json:"signal"`
	Path   string            `json:"path"`
}

// Main is `effector spawner`. It returns the exit code: 0 when the channel ended, 1 when the
// spawner cannot start, 2 on a frame that breaks the channel.
func Main(args []string, stdin, stdout *os.File, stderr io.Writer) int {
	if len(args) != 0 {
		_, _ = fmt.Fprintln(stderr, "spawner: usage: effector spawner (no arguments; the channel is stdin and stdout)")
		return 1
	}
	if err := prepare(stdin, stdout); err != nil {
		_, _ = fmt.Fprintf(stderr, "spawner: %v\n", err)
		return 1
	}
	return Serve(stdin, stdout, stderr)
}

// prepare makes the process safe to hold the channel: both ends are sockets, every other fd is
// close-on-exec, and the process is not dumpable.
func prepare(stdin, stdout *os.File) error {
	for _, f := range []*os.File{stdin, stdout} {
		var st syscall.Stat_t
		if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
			return fmt.Errorf("fd %d: %w", f.Fd(), err)
		}
		if st.Mode&syscall.S_IFMT != syscall.S_IFSOCK {
			return fmt.Errorf("fd %d is not a socket: a pipe can be opened again through /proc/<pid>/fd, "+
				"so a process of the domain could put a frame on the channel (ADR-0076)", f.Fd())
		}
	}
	if err := closeOnExecAbove(2); err != nil {
		return err
	}
	if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, prSetDumpable, 0, 0); errno != 0 {
		return fmt.Errorf("prctl(PR_SET_DUMPABLE, 0): %w", errno)
	}
	return nil
}

// closeOnExecAbove marks every open fd above n close-on-exec: one the parent left open by mistake
// does not reach a child.
func closeOnExecAbove(n int) error {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return fmt.Errorf("list the open fds: %w", err)
	}
	for _, e := range entries {
		var fd int
		if _, err := fmt.Sscan(e.Name(), &fd); err != nil || fd <= n {
			continue
		}
		// The fd that read the folder is closed already, and answers EBADF.
		_, _, errno := syscall.RawSyscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_SETFD, syscall.FD_CLOEXEC)
		if errno != 0 && errno != syscall.EBADF {
			return fmt.Errorf("fd %d: close-on-exec: %w", fd, errno)
		}
	}
	return nil
}

// spawner is the state of one channel.
type spawner struct {
	outMu sync.Mutex
	out   *bufio.Writer
	dead  bool

	mu    sync.Mutex
	procs map[string]*proc
}

// proc is one spawned process.
type proc struct {
	pgid   int
	stdin  *stdinQueue
	exited bool
}

// Serve runs the channel until it ends. It is Main without the checks of the files, for a test.
func Serve(in io.Reader, out io.Writer, stderr io.Writer) int {
	s := &spawner{out: bufio.NewWriter(out), procs: map[string]*proc{}}
	r := bufio.NewReaderSize(in, 64<<10)
	for {
		line, err := readLine(r)
		if errors.Is(err, io.EOF) && len(line) == 0 {
			return 0
		}
		if err != nil && !errors.Is(err, io.EOF) {
			_, _ = fmt.Fprintf(stderr, "spawner: the channel failed: %v\n", err)
			return 2
		}
		if len(bytes.TrimSpace(line)) == 0 {
			if err != nil {
				return 0
			}
			continue
		}
		var f inFrame
		if jerr := json.Unmarshal(line, &f); jerr != nil || f.ID == nil || *f.ID == "" {
			_, _ = fmt.Fprintf(stderr, "spawner: a frame that is not a JSON object with a string id: %q\n", truncate(line))
			return 2
		}
		s.handle(&f)
		if s.isDead() {
			return 2
		}
		if err != nil {
			return 0
		}
	}
}

// readLine reads one line, its newline removed, up to maxFrame bytes.
func readLine(r *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := r.ReadSlice('\n')
		buf = append(buf, chunk...)
		if len(buf) > maxFrame {
			return nil, fmt.Errorf("a frame is longer than %d bytes", maxFrame)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return bytes.TrimSuffix(buf, []byte("\n")), err
	}
}

func truncate(b []byte) []byte {
	if len(b) > 200 {
		return b[:200]
	}
	return b
}

func (s *spawner) isDead() bool {
	s.outMu.Lock()
	defer s.outMu.Unlock()
	return s.dead
}

// send writes one frame. A channel that cannot be written ends the spawner at its next frame or at
// the end of its input: the Harness is gone.
func (s *spawner) send(frame map[string]any) {
	b, err := json.Marshal(frame)
	if err != nil {
		panic(err) // Every frame is made here, of strings, numbers and nil.
	}
	s.outMu.Lock()
	defer s.outMu.Unlock()
	if s.dead {
		return
	}
	if _, err := s.out.Write(append(b, '\n')); err == nil {
		err = s.out.Flush()
		if err == nil {
			return
		}
	}
	s.dead = true
}

// sendOut sends one chunk of a process's stdout or stderr.
func (s *spawner) sendOut(id, stream string, b []byte) {
	s.send(map[string]any{"id": id, "op": "out", "stream": stream, "data": base64.StdEncoding.EncodeToString(b)})
}

func (s *spawner) fail(id, code, message string) {
	s.send(map[string]any{"id": id, "op": "error", "code": code, "message": message})
}

func (s *spawner) handle(f *inFrame) {
	id := *f.ID
	switch f.Op {
	case opSpawn:
		s.spawn(id, f)
	case "stdin":
		data, ok := decode(f.Data)
		if !ok {
			s.fail(id, "EINVAL", "stdin: data is not base64")
			return
		}
		if p := s.proc(id); p != nil && p.stdin != nil {
			p.stdin.push(data)
		}
	case "stdin-end":
		if p := s.proc(id); p != nil && p.stdin != nil {
			p.stdin.end()
		}
	case "signal":
		sig, ok := signalNumbers[f.Signal]
		if !ok {
			s.fail(id, "EINVAL", fmt.Sprintf("signal: %q is no signal name", f.Signal))
			return
		}
		if p := s.proc(id); p != nil {
			// ESRCH: the group has ended. Nothing to do, as a kill of an ended process.
			_ = syscall.Kill(-p.pgid, sig)
		}
	case opRead, opWrite, opStat, opReaddir, opUnlink:
		if !filepath.IsAbs(f.Path) {
			s.fail(id, "EINVAL", fmt.Sprintf("%s: the path %q is not absolute", f.Op, f.Path))
			return
		}
		var data []byte
		if f.Op == opWrite {
			var ok bool
			if data, ok = decode(f.Data); !ok || f.Data == nil {
				s.fail(id, "EINVAL", "write: data is missing or not base64")
				return
			}
		}
		go s.fileOp(id, f.Op, f.Path, data)
	default:
		s.fail(id, "EINVAL", fmt.Sprintf("%q is no op", f.Op))
	}
}

func decode(data *string) ([]byte, bool) {
	if data == nil {
		return nil, true
	}
	b, err := base64.StdEncoding.DecodeString(*data)
	return b, err == nil
}

func (s *spawner) proc(id string) *proc {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.procs[id]
}

// spawn starts argv in its own process group, with exactly env, in cwd.
func (s *spawner) spawn(id string, f *inFrame) {
	if len(f.Argv) == 0 || f.Argv[0] == "" {
		s.fail(id, "EINVAL", "spawn: argv is empty")
		return
	}
	if f.Cwd != "" && !filepath.IsAbs(f.Cwd) {
		s.fail(id, "EINVAL", fmt.Sprintf("spawn: cwd %q is not absolute", f.Cwd))
		return
	}
	s.mu.Lock()
	if _, ok := s.procs[id]; ok {
		s.mu.Unlock()
		s.fail(id, "EINVAL", fmt.Sprintf("spawn: the id %q is in use", id))
		return
	}
	// Held from here, so a second spawn with this id is refused while this one starts.
	p := &proc{}
	s.procs[id] = p
	s.mu.Unlock()
	if err := s.start(id, p, f); err != nil {
		s.mu.Lock()
		delete(s.procs, id)
		s.mu.Unlock()
		s.fail(id, errnoName(err), err.Error())
	}
}

func (s *spawner) start(id string, p *proc, f *inFrame) error {
	env := make([]string, 0, len(f.Env))
	for k, v := range f.Env {
		if k == "" || strings.ContainsAny(k, "=\x00") || strings.Contains(v, "\x00") {
			return &os.PathError{Op: opSpawn, Path: k, Err: syscall.EINVAL}
		}
		env = append(env, k+"="+v)
	}
	path, err := lookPath(f.Argv[0], f.Env["PATH"], f.Cwd)
	if err != nil {
		return err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		return err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		closeAll(outR, outW)
		return err
	}
	cmd := &exec.Cmd{Path: path, Args: f.Argv, Env: env, Dir: f.Cwd, Stdout: outW, Stderr: errW,
		SysProcAttr: &syscall.SysProcAttr{Setpgid: true}}
	var inW *os.File
	if f.Stdin {
		var inR *os.File
		if inR, inW, err = os.Pipe(); err != nil {
			closeAll(outR, outW, errR, errW)
			return err
		}
		cmd.Stdin = inR
		defer func() { _ = inR.Close() }()
	}
	// No Stdin: os/exec opens /dev/null.
	if err := cmd.Start(); err != nil {
		closeAll(outR, outW, errR, errW, inW)
		return err
	}
	// The child holds the write ends now; the spawner keeps only the read ends, so a pipe ends when
	// every process that holds it has ended or closed it.
	closeAll(outW, errW)
	pid := cmd.Process.Pid
	s.mu.Lock()
	p.pgid = pid
	if inW != nil {
		p.stdin = newStdinQueue(inW)
	}
	s.mu.Unlock()
	s.send(map[string]any{"id": id, "op": "started", "pid": pid})
	go s.relay(id, p, cmd, outR, errR)
	return nil
}

func closeAll(files ...*os.File) {
	for _, f := range files {
		if f != nil {
			_ = f.Close()
		}
	}
}

// relay sends the output of one spawn, then its exit.
//
// One loop reads both pipes and sends each chunk as it reads it, so `out` frames keep the order in
// which the child wrote to its two streams (the Harness shows them together in that order). Two
// readers, one for each pipe, can swap a stdout chunk and a stderr chunk under load.
func (s *spawner) relay(id string, p *proc, cmd *exec.Cmd, outR, errR *os.File) {
	done := make(chan *os.ProcessState, 1)
	// wake tells the loop that the process ended, so the grace starts at once.
	var wake [2]int
	wakeErr := syscall.Pipe2(wake[:], syscall.O_CLOEXEC|syscall.O_NONBLOCK)
	if wakeErr != nil {
		wake = [2]int{-1, -1}
	}
	go func() {
		state, _ := cmd.Process.Wait()
		// Write the wake first: the loop closes the pipe after it receives the state.
		if wake[1] >= 0 {
			_, _ = syscall.Write(wake[1], []byte{1})
		}
		done <- state
	}()
	state := s.readOutput(id, p, outR, errR, wake[0], done)
	if wake[0] >= 0 {
		_ = syscall.Close(wake[0])
		_ = syscall.Close(wake[1])
	}
	closeAll(outR, errR)
	if p.stdin != nil {
		p.stdin.end()
	}

	frame := map[string]any{"id": id, "op": "exit", "code": nil, "signal": nil}
	if state != nil {
		if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			frame["signal"] = signalName(ws.Signal())
		} else {
			frame["code"] = state.ExitCode()
		}
	}
	s.mu.Lock()
	p.exited = true
	s.mu.Unlock()
	s.send(frame)
	time.AfterFunc(keepExited, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.procs[id] == p {
			delete(s.procs, id)
		}
	})
}

// readOutput reads a spawn's two pipes in one loop and sends each chunk, until both pipes end or
// the process has ended and the pipes stayed quiet for GraceAfterExit. It returns the process's
// state, which comes on done. wake is a pipe that becomes readable when the state is on done, or
// -1: then the loop looks at done every 10 ms.
func (s *spawner) readOutput(
	id string, p *proc, outR, errR *os.File, wake int, done <-chan *os.ProcessState,
) *os.ProcessState {
	// Fd puts the file in blocking mode; set it back, so that a read after a spurious wake-up
	// cannot hold the loop.
	outFd, errFd := int(outR.Fd()), int(errR.Fd())
	streams := map[int]string{outFd: "stdout", errFd: "stderr"}
	ep, err := syscall.EpollCreate1(syscall.EPOLL_CLOEXEC)
	if err == nil {
		defer func() { _ = syscall.Close(ep) }()
		for _, fd := range []int{outFd, errFd, wake} {
			if fd < 0 || err != nil {
				continue
			}
			if err = syscall.SetNonblock(fd, true); err == nil {
				err = syscall.EpollCtl(ep, syscall.EPOLL_CTL_ADD, fd,
					&syscall.EpollEvent{Events: syscall.EPOLLIN, Fd: int32(fd)})
			}
		}
	}
	if err != nil {
		// The spawner cannot read the pipes: end the process, and say why on its stderr.
		s.sendOut(id, "stderr", []byte("spawner: cannot read the output: "+err.Error()+"\n"))
		_ = syscall.Kill(-p.pgid, syscall.SIGKILL)
		return <-done
	}

	var state *os.ProcessState
	ended := false
	var deadline time.Time
	end := func(st *os.ProcessState) {
		state, ended = st, true
		deadline = time.Now().Add(GraceAfterExit)
	}
	buf := make([]byte, 64<<10)
	events := make([]syscall.EpollEvent, 3)
	for len(streams) > 0 {
		timeout := -1
		if !ended && wake < 0 {
			select {
			case st := <-done:
				end(st)
			default:
				timeout = 10
			}
		}
		if ended {
			rem := time.Until(deadline)
			if rem <= 0 {
				break
			}
			timeout = int(rem / time.Millisecond)
			if timeout == 0 {
				timeout = 1
			}
		}
		n, err := syscall.EpollWait(ep, events, timeout)
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			break
		}
		ready := map[int]bool{}
		for _, ev := range events[:n] {
			ready[int(ev.Fd)] = true
		}
		// A fixed order when both pipes are ready in one wait: stdout first.
		for _, fd := range []int{outFd, errFd} {
			stream, open := streams[fd]
			if !ready[fd] || !open {
				continue
			}
			r, err := syscall.Read(fd, buf)
			switch {
			case r > 0:
				s.sendOut(id, stream, buf[:r])
				if ended {
					// The grace counts from the end of the last send: a slow channel is not a quiet pipe.
					deadline = time.Now().Add(GraceAfterExit)
				}
			case err == syscall.EAGAIN || err == syscall.EINTR:
			default:
				_ = syscall.EpollCtl(ep, syscall.EPOLL_CTL_DEL, fd, nil)
				delete(streams, fd)
			}
		}
		if wake >= 0 && ready[wake] {
			_ = syscall.EpollCtl(ep, syscall.EPOLL_CTL_DEL, wake, nil)
			end(<-done)
		}
	}
	if !ended {
		state = <-done
	}
	return state
}

// stdinQueue writes a child's stdin in order, without holding the channel: a child that does not
// read its stdin stops only its own queue.
type stdinQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	chunks [][]byte
	ending bool
}

func newStdinQueue(w *os.File) *stdinQueue {
	q := &stdinQueue{}
	q.cond = sync.NewCond(&q.mu)
	go func() {
		defer func() { _ = w.Close() }()
		for {
			q.mu.Lock()
			for len(q.chunks) == 0 && !q.ending {
				q.cond.Wait()
			}
			if len(q.chunks) == 0 {
				q.mu.Unlock()
				return
			}
			chunk := q.chunks[0]
			q.chunks = q.chunks[1:]
			q.mu.Unlock()
			if _, err := w.Write(chunk); err != nil {
				// The child closed its stdin: what is left goes nowhere.
				q.mu.Lock()
				q.chunks, q.ending = nil, true
				q.mu.Unlock()
				return
			}
		}
	}()
	return q
}

func (q *stdinQueue) push(b []byte) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.ending && len(b) > 0 {
		q.chunks = append(q.chunks, b)
		q.cond.Signal()
	}
}

func (q *stdinQueue) end() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.ending = true
	q.cond.Signal()
}

// lookPath finds file on path, the child's own PATH. A name with a slash is a path, relative to
// cwd. An empty or relative entry of PATH is never searched: it is the current folder, which is
// the Agent's.
func lookPath(file, path, cwd string) (string, error) {
	if strings.Contains(file, "/") {
		if !filepath.IsAbs(file) {
			if cwd == "" {
				var err error
				if cwd, err = os.Getwd(); err != nil {
					return "", err
				}
			}
			file = filepath.Join(cwd, file)
		}
		return file, nil
	}
	for _, dir := range filepath.SplitList(path) {
		if !filepath.IsAbs(dir) {
			continue
		}
		candidate := filepath.Join(dir, file)
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() {
			continue
		}
		if syscall.Access(candidate, 1) == nil { // X_OK
			return candidate, nil
		}
	}
	return "", &os.PathError{Op: opSpawn, Path: file, Err: syscall.ENOENT}
}

// fileOp does one file tool's I/O, in this process, so the domain's rules apply to it.
func (s *spawner) fileOp(id, op, path string, data []byte) {
	switch op {
	case opRead:
		b, err := os.ReadFile(path)
		if err != nil {
			s.fail(id, errnoName(err), err.Error())
			return
		}
		s.send(map[string]any{"id": id, "op": "ok", "data": base64.StdEncoding.EncodeToString(b)})
	case opWrite:
		if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
			s.fail(id, errnoName(err), err.Error())
			return
		}
		if err := os.WriteFile(path, data, 0o666); err != nil {
			s.fail(id, errnoName(err), err.Error())
			return
		}
		s.send(map[string]any{"id": id, "op": "ok"})
	case opStat:
		info, err := os.Stat(path)
		if err != nil {
			s.fail(id, errnoName(err), err.Error())
			return
		}
		real, err := filepath.EvalSymlinks(path)
		if err != nil {
			s.fail(id, errnoName(err), err.Error())
			return
		}
		kind := "other"
		switch {
		case info.Mode().IsRegular():
			kind = "file"
		case info.IsDir():
			kind = "directory"
		}
		s.send(map[string]any{"id": id, "op": "ok", "kind": kind, "size": info.Size(),
			"mtimeMs": info.ModTime().UnixMilli(), "realpath": real})
	case opReaddir:
		// The names alone, sorted. A name that is not UTF-8 travels with U+FFFD in place of each bad
		// byte (JSON text), so the Harness names a folder by such a name only to show it.
		entries, err := os.ReadDir(path)
		if err != nil {
			s.fail(id, errnoName(err), err.Error())
			return
		}
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		s.send(map[string]any{"id": id, "op": "ok", "names": names})
	case opUnlink:
		// unlink(2) alone, not os.Remove, which also tries rmdir: the op removes one file's name.
		if err := syscall.Unlink(path); err != nil {
			perr := &os.PathError{Op: opUnlink, Path: path, Err: err}
			s.fail(id, errnoName(perr), perr.Error())
			return
		}
		s.send(map[string]any{"id": id, "op": "ok"})
	}
}

// errnoName is the errno of err by its C name (EACCES, ENOENT), as Node names an error's code.
func errnoName(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if name, ok := errnoNames[errno]; ok {
			return name
		}
		return fmt.Sprintf("E%d", int(errno))
	}
	if errors.Is(err, fs.ErrNotExist) {
		return "ENOENT"
	}
	if errors.Is(err, fs.ErrPermission) {
		return "EACCES"
	}
	return "EIO"
}

var errnoNames = map[syscall.Errno]string{
	syscall.EPERM: "EPERM", syscall.ENOENT: "ENOENT", syscall.ESRCH: "ESRCH", syscall.EINTR: "EINTR",
	syscall.EIO: "EIO", syscall.ENXIO: "ENXIO", syscall.E2BIG: "E2BIG", syscall.ENOEXEC: "ENOEXEC",
	syscall.EBADF: "EBADF", syscall.ECHILD: "ECHILD", syscall.EAGAIN: "EAGAIN", syscall.ENOMEM: "ENOMEM",
	syscall.EACCES: "EACCES", syscall.EFAULT: "EFAULT", syscall.EBUSY: "EBUSY", syscall.EEXIST: "EEXIST",
	syscall.EXDEV: "EXDEV", syscall.ENODEV: "ENODEV", syscall.ENOTDIR: "ENOTDIR", syscall.EISDIR: "EISDIR",
	syscall.EINVAL: "EINVAL", syscall.ENFILE: "ENFILE", syscall.EMFILE: "EMFILE", syscall.ETXTBSY: "ETXTBSY",
	syscall.EFBIG: "EFBIG", syscall.ENOSPC: "ENOSPC", syscall.ESPIPE: "ESPIPE", syscall.EROFS: "EROFS",
	syscall.EMLINK: "EMLINK", syscall.EPIPE: "EPIPE", syscall.ENAMETOOLONG: "ENAMETOOLONG",
	syscall.ENOTEMPTY: "ENOTEMPTY", syscall.ELOOP: "ELOOP", syscall.EOVERFLOW: "EOVERFLOW",
	syscall.EDQUOT: "EDQUOT", syscall.ENOTSUP: "ENOTSUP",
}

// The signals of Linux on amd64 and arm64 (the same numbers on both), by Node's names.
var signalNumbers = map[string]syscall.Signal{
	"SIGHUP": 1, "SIGINT": 2, "SIGQUIT": 3, "SIGILL": 4, "SIGTRAP": 5, "SIGABRT": 6, "SIGBUS": 7,
	"SIGFPE": 8, "SIGKILL": 9, "SIGUSR1": 10, "SIGSEGV": 11, "SIGUSR2": 12, "SIGPIPE": 13, "SIGALRM": 14,
	"SIGTERM": 15, "SIGSTKFLT": 16, "SIGCHLD": 17, "SIGCONT": 18, "SIGSTOP": 19, "SIGTSTP": 20,
	"SIGTTIN": 21, "SIGTTOU": 22, "SIGURG": 23, "SIGXCPU": 24, "SIGXFSZ": 25, "SIGVTALRM": 26,
	"SIGPROF": 27, "SIGWINCH": 28, "SIGIO": 29, "SIGPWR": 30, "SIGSYS": 31,
}

func signalName(sig syscall.Signal) string {
	for name, n := range signalNumbers {
		if n == sig {
			return name
		}
	}
	return fmt.Sprintf("SIG%d", int(sig))
}
