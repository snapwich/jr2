package pushkind

// The check's client of git-lfs's pure SSH protocol (ADR-0067): `git-lfs-transfer <path>
// <operation>` over the call's own ssh command, as git-lfs's docs/proposals/ssh_adapter.md gives
// it and as git-lfs 3.x speaks it (ssh/protocol.go, tq/ssh.go). The client uses only what the
// check needs: the capability advertisement, `version 1`, `batch` and `quit`. It never sends an
// object and never asks for one.
//
// The wire is git's pkt-line: four hex digits give the length of the packet with those four
// digits; 0000 is a flush, 0001 a delimiter. A text packet ends with a LF.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/snapwich/jr2/effector/internal/gitclean"
	"github.com/snapwich/jr2/effector/internal/reaper"
)

// pktMax is the largest packet that pkt-line allows, its four length digits included.
const pktMax = 65520

// transferPacketsMax bounds the packets of one message that are read: a batch names at most
// lfsBatchSize objects, and an answer lists each at most once for each action. lfsAnswerMax
// bounds its bytes, as it bounds an https answer. A server that keeps sending is refused, so the
// Effector's memory does not grow until the Effect's timeout.
const transferPacketsMax = 4096

// The kinds of packet that a read gives.
const (
	pktData = iota
	pktFlush
	pktDelim
)

// lfsTransfer is one open `git-lfs-transfer` session.
type lfsTransfer struct {
	cmd  *exec.Cmd
	w    io.WriteCloser
	r    *bufio.Reader
	stop func() bool
	once sync.Once
	// packets and bytes are what the message that is read has left of its bounds.
	packets, bytes int
}

// begin starts the bounds of a new message.
func (s *lfsTransfer) begin() { s.packets, s.bytes = transferPacketsMax, lfsAnswerMax }

// openTransfer starts `git-lfs-transfer <path> <operation>` on t's host over the call's ssh command
// and does git-lfs's version step: the server must advertise `version=1` and accept `version 1`.
// An error means that the server does not speak the pure SSH protocol here, or that ssh failed:
// git-lfs then tries git-lfs-authenticate, and so does the caller.
func (c *call) openTransfer(ctx context.Context, t sshTarget, operation string) (*lfsTransfer, error) {
	cmd := gitclean.Command(ctx, c.repo, c.sshArgv(t.args("git-lfs-transfer", operation))...)
	w, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	r, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := reaper.Start(ctx, cmd); err != nil {
		return nil, err
	}
	s := &lfsTransfer{cmd: cmd, w: w, r: bufio.NewReader(r)}
	// The process is the leader of its own group (reaper.Start). When ctx ends, the group is
	// killed and the read end closed, so a read that waits on a silent server returns.
	s.stop = context.AfterFunc(ctx, func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = r.Close()
	})
	if err := s.version(); err != nil {
		s.kill()
		if ctx.Err() != nil {
			return nil, errors.New("the timeout passed")
		}
		return nil, err
	}
	return s, nil
}

// version reads the capability advertisement and does the version step.
func (s *lfsTransfer) version() error {
	caps, err := s.readList()
	if err != nil {
		return fmt.Errorf("no capability advertisement: %w", err)
	}
	if !slices.Contains(caps, "version=1") {
		return errors.New("the server does not advertise version=1")
	}
	if err := s.send("version 1", nil, nil); err != nil {
		return err
	}
	status, _, lines, err := s.readStatus()
	if err != nil {
		return err
	}
	if status != 200 {
		return fmt.Errorf("the server answered version 1 with %d%s", status, firstLine(lines))
	}
	return nil
}

// batch sends one download batch request for objects and reads the answer: an object is held when
// a line gives it the `download` action. A server that lacks an object gives it `noop`. The pure
// SSH protocol has no error for one object. An oid that the answer does not list has no entry.
// hash-algo and transfer are the arguments that git-lfs sends.
func (s *lfsTransfer) batch(objects []lfsObject) (map[string]lfsState, error) {
	lines := make([]string, 0, len(objects))
	asked := map[string]bool{}
	for _, o := range objects {
		lines = append(lines, fmt.Sprintf("%s %d", o.oid, o.size))
		asked[o.oid] = true
	}
	if err := s.send("batch", []string{"transfer=ssh", "hash-algo=sha256"}, lines); err != nil {
		return nil, err
	}
	status, args, answer, err := s.readStatus()
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("the LFS server answered the batch request %d%s", status, firstLine(answer))
	}
	for _, a := range args {
		if v, ok := strings.CutPrefix(a, "hash-algo="); ok && v != "sha256" {
			return nil, fmt.Errorf("the LFS server's batch answer names the hash %q, not sha256", v)
		}
	}
	states := map[string]lfsState{}
	for _, line := range answer {
		f := strings.Fields(line)
		if len(f) < 3 {
			return nil, fmt.Errorf("the LFS server's batch answer has a line that is not `oid size action`: %q",
				oneLine(line))
		}
		if !asked[f[0]] {
			continue
		}
		state := states[f[0]]
		state.held = state.held || f[2] == "download"
		states[f[0]] = state
	}
	return states, nil
}

// close sends `quit`, reads its status, and waits for the process. Its errors change nothing: the
// batch answers came before it.
func (s *lfsTransfer) close() {
	if err := s.send("quit", nil, nil); err == nil {
		_, _, _, _ = s.readStatus()
	}
	s.kill()
}

// kill ends the session: stdin closes, and the process group is killed if it did not exit.
func (s *lfsTransfer) kill() {
	s.once.Do(func() {
		_ = s.w.Close()
		s.stop()
		// A server that does not exit within a second of its stdin's close is killed.
		late := time.AfterFunc(time.Second, func() { _ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL) })
		_ = s.cmd.Wait()
		late.Stop()
	})
}

// send writes a command, its arguments, then, when lines is not nil, a delimiter and the lines,
// and a flush.
func (s *lfsTransfer) send(command string, args, lines []string) error {
	var b strings.Builder
	for _, text := range append([]string{command}, args...) {
		if err := pktText(&b, text); err != nil {
			return err
		}
	}
	if lines != nil {
		b.WriteString("0001")
		for _, text := range lines {
			if err := pktText(&b, text); err != nil {
				return err
			}
		}
	}
	b.WriteString("0000")
	if _, err := io.WriteString(s.w, b.String()); err != nil {
		return fmt.Errorf("the LFS server closed the session: %w", err)
	}
	return nil
}

func pktText(b *strings.Builder, text string) error {
	n := len(text) + 1 + 4
	if n > pktMax {
		return errors.New("a packet is too long")
	}
	fmt.Fprintf(b, "%04x%s\n", n, text)
	return nil
}

// read reads one packet: its kind, and its text with no final LF.
func (s *lfsTransfer) read() (int, string, error) {
	var head [4]byte
	if _, err := io.ReadFull(s.r, head[:]); err != nil {
		return 0, "", errors.New("the LFS server ended the session")
	}
	n, err := strconv.ParseUint(string(head[:]), 16, 16)
	if err != nil {
		return 0, "", fmt.Errorf("the LFS server sent a packet length that is not hex: %q", head[:])
	}
	switch {
	case n == 0:
		return pktFlush, "", nil
	case n == 1:
		return pktDelim, "", nil
	case n < 4 || n > pktMax:
		return 0, "", fmt.Errorf("the LFS server sent a packet of length %d", n)
	}
	if s.packets--; s.packets < 0 {
		return 0, "", fmt.Errorf("the LFS server sent a message of more than %d packets", transferPacketsMax)
	}
	if s.bytes -= int(n); s.bytes < 0 {
		return 0, "", fmt.Errorf("the LFS server sent a message of more than %d bytes", lfsAnswerMax)
	}
	body := make([]byte, n-4)
	if _, err := io.ReadFull(s.r, body); err != nil {
		return 0, "", errors.New("the LFS server ended the session in a packet")
	}
	return pktData, strings.TrimSuffix(string(body), "\n"), nil
}

// readList reads text packets up to a flush, within the bounds of a message.
func (s *lfsTransfer) readList() ([]string, error) {
	s.begin()
	var list []string
	for {
		kind, text, err := s.read()
		if err != nil {
			return nil, err
		}
		switch kind {
		case pktFlush:
			return list, nil
		case pktDelim:
			return nil, errors.New("the LFS server sent a delimiter where none goes")
		}
		list = append(list, text)
	}
}

// readStatus reads `status <code>`, its arguments, and, after a delimiter, its lines, up to a
// flush, within the bounds of a message.
func (s *lfsTransfer) readStatus() (status int, args, lines []string, err error) {
	s.begin()
	kind, text, err := s.read()
	if err != nil {
		return 0, nil, nil, err
	}
	code, ok := strings.CutPrefix(text, "status ")
	if kind != pktData || !ok {
		return 0, nil, nil, fmt.Errorf("the LFS server sent %q where a status goes", oneLine(text))
	}
	if status, err = strconv.Atoi(code); err != nil {
		return 0, nil, nil, fmt.Errorf("the LFS server sent the status %q", oneLine(code))
	}
	delim := false
	for {
		kind, text, err := s.read()
		if err != nil {
			return 0, nil, nil, err
		}
		switch {
		case kind == pktFlush:
			return status, args, lines, nil
		case kind == pktDelim && delim:
			return 0, nil, nil, errors.New("the LFS server sent two delimiters")
		case kind == pktDelim:
			delim = true
		case delim:
			lines = append(lines, text)
		default:
			args = append(args, text)
		}
	}
}

// takeSSHLine reads and removes ssh's stderr file of the call, and gives its last line, or "".
func (c *call) takeSSHLine() string {
	if c.sshLog == "" {
		return ""
	}
	raw, _ := os.ReadFile(c.sshLog)
	_ = os.Remove(c.sshLog)
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	return oneLine(lines[len(lines)-1])
}

// firstLine is " (<the first line>)" of a status's lines, or "".
func firstLine(lines []string) string {
	if len(lines) == 0 || oneLine(lines[0]) == "" {
		return ""
	}
	return " (" + oneLine(lines[0]) + ")"
}
