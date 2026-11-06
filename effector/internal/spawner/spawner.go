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
//	{"op":"spawn",...,"tty":{"rows":N,"cols":N}}  on a pseudo-terminal (below)
//	{"op":"stdin","id":ID,"data":B64}
//	{"op":"stdin-end","id":ID}
//	{"op":"signal","id":ID,"signal":"SIGTERM"}     to the process group of spawn ID
//	{"op":"resize","id":ID,"rows":N,"cols":N}      the terminal size of a spawn with a tty
//	{"op":"pause","id":ID}  {"op":"resume","id":ID}  stop and start reading the output of spawn ID
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
// A spawn with `tty` gets a pseudo-terminal that the spawner opens (/dev/ptmx), as its stdin, stdout
// and stderr and its controlling terminal, in a session of its own: the shell of a person (`jr2
// workspace shell`, ADR-0076), in the one domain like each other process that the spawner starts.
// Its output comes as `out` frames on `stdout`, and `stdin` frames go to the terminal; `stdin-end`
// closes nothing that the process reads. The terminal ends with the spawn: when the spawner sends
// `exit`, it closes the terminal, and the kernel hangs up the session.
//
// `pause` stops the reads of a spawn's output until `resume`. Its pipes or its terminal fill, and then
// its writes block, as a process's writes to a slow terminal do. The Harness pauses a person's shell
// while the socket to the person is full, so the shell's output does not collect in the Harness's
// memory (workspace-shell.ts). While a spawn is paused, the grace after its exit does not count.
//
// `stdin`, `stdin-end`, `signal`, `resize`, `pause` and `resume` have no answer when they succeed;
// a signal to a group that has ended does nothing. A frame that is not JSON, or has no string ID,
// ends the spawner (exit 2): the Harness and the spawner no longer agree on the channel. A frame
// with an ID and an unknown op or wrong fields answers `error` with code EINVAL.
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
	"unsafe"
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
	Tty    *ttySize          `json:"tty"`
	Rows   int               `json:"rows"`
	Cols   int               `json:"cols"`
}

// ttySize is the size of a spawn's pseudo-terminal, in characters.
type ttySize struct {
	Rows int `json:"rows"`
	Cols int `json:"cols"`
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
	// tty is the fd of the terminal's master side, for `resize`, or -1: no tty, or it is closed.
	// Read and changed under spawner.mu.
	tty int
	// paused is true from `pause` to `resume`: readOutput does not read the output. Under spawner.mu.
	paused bool
	// ctl is the write end of a pipe that wakes readOutput at each `pause` and `resume`, or -1: not
	// open yet, or closed. Under spawner.mu.
	ctl int
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
	case "resize":
		if f.Rows <= 0 || f.Cols <= 0 || f.Rows > 0xffff || f.Cols > 0xffff {
			s.fail(id, "EINVAL", fmt.Sprintf("resize: %dx%d is no terminal size", f.Rows, f.Cols))
			return
		}
		s.mu.Lock()
		if p := s.procs[id]; p != nil && p.tty >= 0 {
			// Under the lock, so the fd is not closed (and its number used again) during the call.
			_ = setWinsize(p.tty, f.Rows, f.Cols)
		}
		s.mu.Unlock()
	case "pause", "resume":
		s.mu.Lock()
		if p := s.procs[id]; p != nil {
			p.paused = f.Op == "pause"
			if p.ctl >= 0 {
				// Under the lock, so the fd is not closed (and its number used again) during the call.
				// A full pipe holds wakes already, and readOutput reads `paused` at each wake.
				_, _ = syscall.Write(p.ctl, []byte{1})
			}
		}
		s.mu.Unlock()
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
	if f.Tty != nil && (f.Tty.Rows <= 0 || f.Tty.Cols <= 0 || f.Tty.Rows > 0xffff || f.Tty.Cols > 0xffff) {
		s.fail(id, "EINVAL", fmt.Sprintf("spawn: %dx%d is no terminal size", f.Tty.Rows, f.Tty.Cols))
		return
	}
	s.mu.Lock()
	if _, ok := s.procs[id]; ok {
		s.mu.Unlock()
		s.fail(id, "EINVAL", fmt.Sprintf("spawn: the id %q is in use", id))
		return
	}
	// Held from here, so a second spawn with this id is refused while this one starts.
	p := &proc{tty: -1, ctl: -1}
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
	if f.Tty != nil {
		return s.startTty(id, p, f, path, env)
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

// startTty starts a spawn with `tty`: on a new pseudo-terminal, as the leader of a new session
// whose controlling terminal it is. The process group is the session's first; a job that the shell
// starts has a group of its own, and the kernel signals it from the terminal (Ctrl-C) or its hang-up.
func (s *spawner) startTty(id string, p *proc, f *inFrame, path string, env []string) error {
	master, slave, err := openPty()
	if err != nil {
		return err
	}
	// Fd once, here: it puts the file in blocking mode, and readOutput sets it back.
	mfd := int(master.Fd())
	if err := setWinsize(mfd, f.Tty.Rows, f.Tty.Cols); err != nil {
		closeAll(master, slave)
		return err
	}
	// A dup for the writes, so `stdin-end` closes it and not the terminal that the output comes on.
	wfd, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(mfd), syscall.F_DUPFD_CLOEXEC, 0)
	if errno != 0 {
		closeAll(master, slave)
		return &os.SyscallError{Syscall: "fcntl", Err: errno}
	}
	writer := &ttyWriter{fd: int(wfd)}
	cmd := &exec.Cmd{Path: path, Args: f.Argv, Env: env, Dir: f.Cwd, Stdin: slave, Stdout: slave, Stderr: slave,
		SysProcAttr: &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}}
	if err := cmd.Start(); err != nil {
		closeAll(master, slave)
		_ = writer.Close()
		return err
	}
	// Only the child holds the terminal's slave side now: the master reads EIO when it closes it.
	_ = slave.Close()
	pid := cmd.Process.Pid
	s.mu.Lock()
	p.pgid = pid
	p.tty = mfd
	p.stdin = newStdinQueue(writer)
	s.mu.Unlock()
	s.send(map[string]any{"id": id, "op": "started", "pid": pid})
	go s.relay(id, p, cmd, master, nil)
	return nil
}

// openPty opens a new pseudo-terminal: its master side and its slave side, each close-on-exec.
func openPty() (master, slave *os.File, err error) {
	master, err = os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	fd := master.Fd()
	var unlock int32
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock)))
	if errno != 0 {
		_ = master.Close()
		return nil, nil, &os.SyscallError{Syscall: "ioctl(TIOCSPTLCK)", Err: errno}
	}
	var n uint32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCGPTN, uintptr(unsafe.Pointer(&n))); errno != 0 {
		_ = master.Close()
		return nil, nil, &os.SyscallError{Syscall: "ioctl(TIOCGPTN)", Err: errno}
	}
	slave, err = os.OpenFile(fmt.Sprintf("/dev/pts/%d", n), os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		_ = master.Close()
		return nil, nil, err
	}
	return master, slave, nil
}

// setWinsize sets a terminal's size; the kernel sends SIGWINCH to its foreground group.
func setWinsize(fd, rows, cols int) error {
	ws := struct{ row, col, x, y uint16 }{uint16(rows), uint16(cols), 0, 0}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
	if errno != 0 {
		return &os.SyscallError{Syscall: "ioctl(TIOCSWINSZ)", Err: errno}
	}
	return nil
}

// ttyWriter writes to a terminal's master side. readOutput puts the master in non-blocking mode,
// and a dup shares that mode, so a full terminal answers EAGAIN: the write waits and tries again.
type ttyWriter struct{ fd int }

func (w *ttyWriter) Write(b []byte) (int, error) {
	done := 0
	for done < len(b) {
		n, err := syscall.Write(w.fd, b[done:])
		if n > 0 {
			done += n
		}
		switch {
		case err == syscall.EAGAIN || err == syscall.EINTR:
			time.Sleep(5 * time.Millisecond)
		case err != nil:
			return done, err
		}
	}
	return done, nil
}

func (w *ttyWriter) Close() error { return syscall.Close(w.fd) }

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
	// ctl wakes the loop at each `pause` and `resume`.
	var ctl [2]int
	if err := syscall.Pipe2(ctl[:], syscall.O_CLOEXEC|syscall.O_NONBLOCK); err != nil {
		ctl = [2]int{-1, -1}
	}
	s.mu.Lock()
	p.ctl = ctl[1]
	s.mu.Unlock()
	go func() {
		state, _ := cmd.Process.Wait()
		// Write the wake first: the loop closes the pipe after it receives the state.
		if wake[1] >= 0 {
			_, _ = syscall.Write(wake[1], []byte{1})
		}
		done <- state
	}()
	state := s.readOutput(id, p, outR, errR, wake[0], ctl[0], done)
	if wake[0] >= 0 {
		_ = syscall.Close(wake[0])
		_ = syscall.Close(wake[1])
	}
	// A terminal's fd and the ctl pipe are closed below: no `resize` or `pause` may use their
	// numbers from here.
	s.mu.Lock()
	p.tty = -1
	p.ctl = -1
	s.mu.Unlock()
	if ctl[0] >= 0 {
		_ = syscall.Close(ctl[0])
		_ = syscall.Close(ctl[1])
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
// the process has ended and the pipes stayed quiet for GraceAfterExit. A spawn with a tty has one:
// the terminal's master side as outR, and errR nil; it ends with EIO when no process holds the
// terminal. It returns the process's
// state, which comes on done. wake is a pipe that becomes readable when the state is on done, or
// -1: then the loop looks at done every 10 ms. ctl is a pipe that becomes readable at each `pause`
// and `resume`, or -1: then the loop looks at `paused` every 10 ms. While the spawn is paused, its
// output fds are out of the epoll set, and the grace after the exit does not count.
func (s *spawner) readOutput(
	id string, p *proc, outR, errR *os.File, wake, ctl int, done <-chan *os.ProcessState,
) *os.ProcessState {
	// Fd puts the file in blocking mode; set it back, so that a read after a spurious wake-up
	// cannot hold the loop.
	outFd, errFd := int(outR.Fd()), -1
	streams := map[int]string{outFd: "stdout"}
	if errR != nil {
		errFd = int(errR.Fd())
		streams[errFd] = "stderr"
	}
	ep, err := pollFds(outFd, errFd, wake, ctl)
	if ep >= 0 {
		defer func() { _ = syscall.Close(ep) }()
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
	events := make([]syscall.EpollEvent, 4)
	// watched says whether the output fds are in the epoll set: not while the spawn is paused.
	watched := true
	for len(streams) > 0 {
		s.mu.Lock()
		paused := p.paused
		s.mu.Unlock()
		if paused == watched {
			watched = !paused
			watchStreams(ep, streams, watched)
			if watched && ended {
				// The grace counts again from the resume.
				deadline = time.Now().Add(GraceAfterExit)
			}
		}
		timeout := -1
		if !ended && wake < 0 {
			select {
			case st := <-done:
				end(st)
			default:
				timeout = 10
			}
		}
		if paused {
			if ctl < 0 || (!ended && wake < 0) {
				timeout = 10
			}
		} else if ended {
			var over bool
			if timeout, over = graceLeft(deadline); over {
				break
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
		if s.readReady(id, ep, streams, ready, buf, outFd, errFd) && ended {
			// The grace counts from the end of the last send: a slow channel is not a quiet pipe.
			deadline = time.Now().Add(GraceAfterExit)
		}
		if wake >= 0 && ready[wake] {
			_ = syscall.EpollCtl(ep, syscall.EPOLL_CTL_DEL, wake, nil)
			end(<-done)
		}
		if ctl >= 0 && ready[ctl] {
			drain(ctl, buf)
		}
	}
	if !ended {
		state = <-done
	}
	return state
}

// pollFds makes an epoll set that watches each fd that is not -1 for input, each in non-blocking
// mode. It gives -1 when it cannot make the set, and the set with the error when it cannot add an
// fd: the caller closes a set that is not -1.
func pollFds(fds ...int) (int, error) {
	ep, err := syscall.EpollCreate1(syscall.EPOLL_CLOEXEC)
	if err != nil {
		return -1, err
	}
	for _, fd := range fds {
		if fd < 0 {
			continue
		}
		if err = syscall.SetNonblock(fd, true); err != nil {
			return ep, err
		}
		err = syscall.EpollCtl(ep, syscall.EPOLL_CTL_ADD, fd, &syscall.EpollEvent{Events: syscall.EPOLLIN, Fd: int32(fd)})
		if err != nil {
			return ep, err
		}
	}
	return ep, nil
}

// graceLeft gives the epoll timeout in milliseconds until the grace deadline, at least 1, and
// says whether the deadline is past.
func graceLeft(deadline time.Time) (int, bool) {
	rem := time.Until(deadline)
	if rem <= 0 {
		return 0, true
	}
	return max(int(rem/time.Millisecond), 1), false
}

// watchStreams adds the output fds to the epoll set, or takes them out of it.
func watchStreams(ep int, streams map[int]string, watched bool) {
	for fd := range streams {
		if watched {
			_ = syscall.EpollCtl(ep, syscall.EPOLL_CTL_ADD, fd,
				&syscall.EpollEvent{Events: syscall.EPOLLIN, Fd: int32(fd)})
		} else {
			_ = syscall.EpollCtl(ep, syscall.EPOLL_CTL_DEL, fd, nil)
		}
	}
}

// readReady reads each ready output fd once and sends what it read, stdout first when both are
// ready in one wait. An fd that ends or fails leaves the epoll set and streams. It says whether it
// sent a chunk.
func (s *spawner) readReady(
	id string, ep int, streams map[int]string, ready map[int]bool, buf []byte, outFd, errFd int,
) bool {
	sent := false
	for _, fd := range []int{outFd, errFd} {
		stream, open := streams[fd]
		if !ready[fd] || !open {
			continue
		}
		r, err := syscall.Read(fd, buf)
		switch {
		case r > 0:
			s.sendOut(id, stream, buf[:r])
			sent = true
		case err == syscall.EAGAIN || err == syscall.EINTR:
		default:
			_ = syscall.EpollCtl(ep, syscall.EPOLL_CTL_DEL, fd, nil)
			delete(streams, fd)
		}
	}
	return sent
}

// drain reads a wake pipe until it is empty. The wakes say only "look at paused again", which the
// next turn of the read loop does.
func drain(fd int, buf []byte) {
	for {
		if r, _ := syscall.Read(fd, buf); r <= 0 {
			return
		}
	}
}

// stdinQueue writes a child's stdin in order, without holding the channel: a child that does not
// read its stdin stops only its own queue.
type stdinQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	chunks [][]byte
	ending bool
}

func newStdinQueue(w io.WriteCloser) *stdinQueue {
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
