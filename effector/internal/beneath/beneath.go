// Package beneath opens a file the Agent named, under a directory the Agent can write (ADR-0067's
// `upload`, a file-body `http`, a ref of the Agent's repository read as data). The Agent owns
// every byte under that directory, so the path and every component on it are hostile.
//
// The opener is openat2(2) from a directory fd, with RESOLVE_BENEATH, RESOLVE_NO_SYMLINKS,
// RESOLVE_NO_MAGICLINKS and RESOLVE_NO_XDEV, O_NONBLOCK and O_NOFOLLOW: a symlink at any component
// (one that stays inside included), `..` that leaves, an absolute path, a /proc magic link and a
// mount crossing are each refused by the kernel. Then fstat on the open fd: a FIFO, a socket, a
// device or a directory is refused (O_NONBLOCK keeps a FIFO from blocking the open), and so is a
// regular file with more than one link — a hard link to a file outside the directory reads that
// file, and the kernel's resolve flags cannot see it. Evidence: the e6 upload-path experiment.
package beneath

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

// sysOpenat2 is openat2's number in the unified syscall table (Linux 5.6), the same on every
// architecture this binary is built for.
const sysOpenat2 = 437

const (
	resolveNoXdev       = 0x01
	resolveNoMagiclinks = 0x02
	resolveNoSymlinks   = 0x04
	resolveBeneath      = 0x08
)

type openHow struct {
	flags   uint64
	mode    uint64
	resolve uint64
}

// Refused is a path the opener will not read. Its text names why, never the file's content; the
// path is the Agent's own, so it may be shown to it.
type Refused struct{ Reason string }

func (r *Refused) Error() string { return r.Reason }

func refuse(format string, args ...any) error { return &Refused{Reason: fmt.Sprintf(format, args...)} }

// Clean checks a relative path the Agent named before the kernel sees it: not empty, not
// absolute, no NUL, no `..` component. The kernel refuses these too; checking first gives the
// Agent a reason in words.
func Clean(rel string) error {
	switch {
	case rel == "":
		return refuse("the path is empty")
	case strings.HasPrefix(rel, "/"):
		return refuse("the path %q is absolute; name a path inside the Worktree", rel)
	case strings.ContainsRune(rel, 0):
		return refuse("the path holds a NUL byte")
	}
	for seg := range strings.SplitSeq(rel, "/") {
		if seg == ".." {
			return refuse("the path %q holds a `..` component", rel)
		}
	}
	return nil
}

// openat2 opens rel under dir with the resolve flags above.
func openat2(dir *os.File, rel string, flags int) (*os.File, error) {
	p, err := syscall.BytePtrFromString(rel)
	if err != nil {
		return nil, err
	}
	how := openHow{
		flags:   uint64(flags | syscall.O_CLOEXEC | syscall.O_NONBLOCK | syscall.O_NOFOLLOW),
		resolve: resolveBeneath | resolveNoSymlinks | resolveNoMagiclinks | resolveNoXdev,
	}
	for {
		fd, _, errno := syscall.Syscall6(sysOpenat2, dir.Fd(), uintptr(unsafe.Pointer(p)),
			uintptr(unsafe.Pointer(&how)), unsafe.Sizeof(how), 0, 0)
		if errno == syscall.EINTR || errno == syscall.EAGAIN {
			continue
		}
		if errno != 0 {
			return nil, errno
		}
		return os.NewFile(fd, rel), nil
	}
}

// why turns the kernel's refusal into words the Agent can act on.
func why(rel string, err error) error {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return refuse("%q could not be opened: %v", rel, err)
	}
	switch errno {
	case syscall.ELOOP:
		return refuse("%q is, or passes through, a symlink; name the file itself", rel)
	case syscall.EXDEV:
		return refuse("%q leaves the Worktree", rel)
	case syscall.ENOENT:
		return refuse("%q does not exist in the Worktree", rel)
	case syscall.ENOTDIR:
		return refuse("a component of %q is not a directory", rel)
	case syscall.EACCES, syscall.EPERM:
		return refuse("%q cannot be read", rel)
	case syscall.ENOSYS:
		// A kernel older than 5.6: there is no safe opener, so nothing is opened.
		return errors.New("this kernel has no openat2(2); the Effector opens no Worktree file without it")
	}
	return refuse("%q could not be opened: %v", rel, errno)
}

// Dir opens a directory under root (an absolute directory the Effector trusts, like /work) by a
// relative path, with the same rules: no symlink on the way, no `..` out, no mount crossed.
func Dir(root, rel string) (*os.File, error) {
	base, err := os.Open(root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = base.Close() }()
	if rel == "" || rel == "." {
		return openat2(base, ".", syscall.O_RDONLY|syscall.O_DIRECTORY)
	}
	if err := Clean(rel); err != nil {
		return nil, err
	}
	f, err := openat2(base, rel, syscall.O_RDONLY|syscall.O_DIRECTORY)
	if err != nil {
		return nil, why(rel, err)
	}
	return f, nil
}

// File is one regular file, opened by Open.
type File struct {
	*os.File
	Size int64
}

// Open opens rel under dir for reading: a regular file with one link, beneath dir, reached by no
// symlink. Anything else is a *Refused.
func Open(dir *os.File, rel string) (*File, error) {
	if err := Clean(rel); err != nil {
		return nil, err
	}
	f, err := openat2(dir, rel, syscall.O_RDONLY)
	if err != nil {
		return nil, why(rel, err)
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		_ = f.Close()
		return nil, refuse("%q could not be read: %v", rel, err)
	}
	switch st.Mode & syscall.S_IFMT {
	case syscall.S_IFREG:
	case syscall.S_IFDIR:
		_ = f.Close()
		return nil, refuse("%q is a directory; name a file", rel)
	case syscall.S_IFIFO:
		_ = f.Close()
		return nil, refuse("%q is a FIFO, not a regular file", rel)
	default:
		_ = f.Close()
		return nil, refuse("%q is not a regular file", rel)
	}
	if st.Nlink > 1 {
		_ = f.Close()
		return nil, refuse("%q has %d hard links; a file with more than one may be a file outside the Worktree",
			rel, st.Nlink)
	}
	// O_NONBLOCK served the open; a regular file's reads never block, so it is cleared for them.
	if err := syscall.SetNonblock(int(f.Fd()), false); err != nil {
		_ = f.Close()
		return nil, err
	}
	return &File{File: f, Size: st.Size}, nil
}

// ReadSmall reads all of a small file under dir, at most limit bytes: a ref or packed-refs read
// as data. A longer file is refused.
func ReadSmall(dir *os.File, rel string, limit int64) ([]byte, error) {
	f, err := Open(dir, rel)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	if f.Size > limit {
		return nil, refuse("%q is %d bytes, over the %d this read takes", rel, f.Size, limit)
	}
	return io.ReadAll(io.LimitReader(f, limit+1))
}
