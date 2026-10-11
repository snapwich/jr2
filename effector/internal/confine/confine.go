// Package confine keeps a credentialed command's child from the Sandbox Effector's mount with
// Landlock (ADR-0068, B9). The child runs as the Effector's uid in the Effector's container, where
// the placement key, every placed secret and the push and signing keys are files that uid can
// read; its program is often the Agent's code. So the Effector does not exec argv itself: it execs
// its own binary as the confiner (`effector confine <rules> -- <path> <argv...>`), which sets
// PR_SET_NO_NEW_PRIVS, makes a Landlock ruleset, adds one rule per allowed path, restricts itself
// and only then calls execve(argv). Landlock is an allow-list the kernel enforces and every
// descendant inherits, and a confined process cannot ptrace a process outside its domain, so
// `/proc/<effector>/mem` is closed too. What a rule does not name is denied: the key, every secret
// the command does not name, the push credentials, the Worktree.
//
// Three raw syscalls (444, 445, 446: the same numbers on amd64 and arm64) and prctl; the standard
// library only (B1). The design needs ABI 1; the rights a newer ABI adds (REFER, TRUNCATE) are
// handled when the kernel offers them.
package confine

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"unsafe"
)

const (
	sysCreateRuleset = 444
	sysAddRule       = 445
	sysRestrictSelf  = 446

	createRulesetVersion = 1 << 0
	rulePathBeneath      = 1
	prSetNoNewPrivs      = 38
	// oPath is O_PATH, the same on amd64 and arm64; the syscall package does not name it.
	oPath = 0x200000
)

// The filesystem rights of Landlock ABI 1, and the two that ABI 2 and 3 add.
const (
	accessExecute    = 1 << 0
	accessWriteFile  = 1 << 1
	accessReadFile   = 1 << 2
	accessReadDir    = 1 << 3
	accessRemoveDir  = 1 << 4
	accessRemoveFile = 1 << 5
	accessMakeChar   = 1 << 6
	accessMakeDir    = 1 << 7
	accessMakeReg    = 1 << 8
	accessMakeSock   = 1 << 9
	accessMakeFifo   = 1 << 10
	accessMakeBlock  = 1 << 11
	accessMakeSym    = 1 << 12
	accessRefer      = 1 << 13 // ABI 2
	accessTruncate   = 1 << 14 // ABI 3

	abi1 = accessExecute | accessWriteFile | accessReadFile | accessReadDir | accessRemoveDir |
		accessRemoveFile | accessMakeChar | accessMakeDir | accessMakeReg | accessMakeSock |
		accessMakeFifo | accessMakeBlock | accessMakeSym
	// fileRights are the rights a rule on a file (not a directory) may carry.
	fileRights = accessExecute | accessWriteFile | accessReadFile | accessTruncate
)

// probe is the kernel's answer; a test replaces it to see the Effector refuse to become ready.
var probe = func() (int, error) {
	abi, _, errno := syscall.RawSyscall(sysCreateRuleset, 0, 0, createRulesetVersion)
	if errno != 0 {
		return 0, errno
	}
	return int(abi), nil
}

// Probe answers the Landlock ABI this kernel offers, or why it offers none: a kernel built without
// it (ENOSYS), or one that has it and did not enable it at boot (EOPNOTSUPP).
func Probe() (int, error) {
	abi, err := probe()
	if err == nil && abi < 1 {
		err = fmt.Errorf("the kernel answered ABI %d", abi)
	}
	if err != nil {
		switch {
		case errors.Is(err, syscall.ENOSYS):
			return 0, errors.New("the kernel has no Landlock (ENOSYS)")
		case errors.Is(err, syscall.EOPNOTSUPP):
			return 0, errors.New("the kernel has Landlock and it is not enabled (EOPNOTSUPP: not in the lsm= list)")
		}
		return 0, err
	}
	return abi, nil
}

// SetProbe replaces the probe for a test; it answers the one it replaced.
func SetProbe(p func() (int, error)) func() (int, error) {
	old := probe
	probe = p
	return old
}

// Rules is one confinement, as paths. A path that does not exist is skipped: the rules name what
// the image may hold, and the image decides what it holds.
type Rules struct {
	// ReadExec: read and execute, a directory's whole tree (the image's system paths).
	ReadExec []string
	// ReadWrite: everything, a directory's whole tree (the per-Effect scratch, /tmp), or read and
	// write on a file (/dev/null).
	ReadWrite []string
	// Read: read only (each secret file the command names).
	Read []string
}

const (
	separator = "--"
	flagRX    = "--rx"
	flagRW    = "--rw"
	flagRO    = "--ro"
)

// Args is the confiner's command line for rules and the program to exec: the path execve runs,
// then argv.
func (r Rules) Args(path string, argv []string) []string {
	out := []string{}
	for _, set := range []struct {
		flag  string
		paths []string
	}{{flagRX, r.ReadExec}, {flagRW, r.ReadWrite}, {flagRO, r.Read}} {
		for _, p := range set.paths {
			out = append(out, set.flag, p)
		}
	}
	return append(append(out, separator, path), argv...)
}

// Parse reads what Args wrote.
func Parse(args []string) (Rules, string, []string, error) {
	var r Rules
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case separator:
			rest := args[i+1:]
			if len(rest) < 2 {
				return r, "", nil, errors.New("confine: no program after --")
			}
			return r, rest[0], rest[1:], nil
		case flagRX, flagRW, flagRO:
			if i+1 >= len(args) || !strings.HasPrefix(args[i+1], "/") {
				return r, "", nil, fmt.Errorf("confine: %s needs an absolute path", args[i])
			}
			switch args[i] {
			case flagRX:
				r.ReadExec = append(r.ReadExec, args[i+1])
			case flagRW:
				r.ReadWrite = append(r.ReadWrite, args[i+1])
			default:
				r.Read = append(r.Read, args[i+1])
			}
			i++
		default:
			return r, "", nil, fmt.Errorf("confine: %q is no rule", args[i])
		}
	}
	return r, "", nil, errors.New("confine: no -- before the program")
}

// Main is `effector confine`: it confines itself and execs the program, and returns only when it
// could not. Nothing runs unconfined: any failure before execve ends the process.
func Main(args []string) int {
	rules, path, argv, err := Parse(args)
	if err == nil {
		err = Exec(rules, path, argv, os.Environ())
	}
	_, _ = fmt.Fprintf(os.Stderr, "jr2: the command was not run: %v\n", err)
	return 126
}

// Exec restricts this process to rules and execs path with argv and env. It returns only on
// failure. The thread is locked: no_new_privs and the Landlock domain are the calling thread's,
// and execve keeps that thread's.
func Exec(rules Rules, path string, argv, env []string) error {
	runtime.LockOSThread()
	abi, err := Probe()
	if err != nil {
		return fmt.Errorf("landlock: %w", err)
	}
	handled := uint64(abi1)
	if abi >= 2 {
		handled |= accessRefer
	}
	if abi >= 3 {
		handled |= accessTruncate
	}
	if _, _, errno := syscall.RawSyscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0); errno != 0 {
		return fmt.Errorf("prctl(PR_SET_NO_NEW_PRIVS): %w", errno)
	}
	attr := struct{ handledAccessFS uint64 }{handled}
	fd, _, errno := syscall.RawSyscall(sysCreateRuleset, uintptr(unsafe.Pointer(&attr)), unsafe.Sizeof(attr), 0)
	if errno != 0 {
		return fmt.Errorf("landlock_create_ruleset: %w", errno)
	}
	ruleset := int(fd)
	readExec := uint64(accessExecute | accessReadFile | accessReadDir)
	for _, set := range []struct {
		paths  []string
		rights uint64
	}{
		{rules.ReadExec, readExec},
		{rules.ReadWrite, handled},
		{rules.Read, accessReadFile | accessReadDir},
	} {
		for _, p := range set.paths {
			if err := addRule(ruleset, p, set.rights&handled); err != nil {
				_ = syscall.Close(ruleset)
				return err
			}
		}
	}
	if _, _, errno := syscall.RawSyscall(sysRestrictSelf, uintptr(ruleset), 0, 0); errno != 0 {
		_ = syscall.Close(ruleset)
		return fmt.Errorf("landlock_restrict_self: %w", errno)
	}
	_ = syscall.Close(ruleset)
	return syscall.Exec(path, argv, env)
}

// addRule allows rights beneath one path: the whole tree for a directory, the file alone for a
// file (a file's rule may carry file rights only). A path that is absent is skipped.
func addRule(ruleset int, path string, rights uint64) error {
	fd, err := syscall.Open(path, oPath|syscall.O_CLOEXEC, 0)
	if errors.Is(err, syscall.ENOENT) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("confine: %s: %w", path, err)
	}
	defer func() { _ = syscall.Close(fd) }()
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return fmt.Errorf("confine: %s: %w", path, err)
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR {
		rights &= fileRights
	}
	// struct landlock_path_beneath_attr is packed: a u64 then an s32, 12 bytes, which this
	// struct's first 12 bytes are on every little-endian 64-bit target jr2 builds for.
	attr := struct {
		allowedAccess uint64
		parentFd      int32
	}{rights, int32(fd)}
	if _, _, errno := syscall.RawSyscall6(sysAddRule, uintptr(ruleset), rulePathBeneath,
		uintptr(unsafe.Pointer(&attr)), 0, 0, 0); errno != 0 {
		return fmt.Errorf("landlock_add_rule %s: %w", path, errno)
	}
	return nil
}

// SystemPaths is what a credentialed command's child may read and run: every entry the image holds
// from root down, except each path in deny and what lies beneath it. An entry that holds a denied
// path is not allowed whole; its other entries are, one level down at a time. So the rules follow
// the image — `/usr`, `/bin`, `/lib64`, `/etc`, `/opt/jr2` and whatever else it has — and no list
// jr2 wrote breaks on another image. `writable` names the entries a child may also write (/tmp),
// allowed in the same way. A symbolic link is allowed only when what it names holds no denied path
// and lies beneath none: a rule follows the link, so `/s -> /run/jr2/secrets` would allow the
// secrets. Every path in deny is a real path (no link in it).
func SystemPaths(root string, deny, writable []string) (readExec, readWrite []string, err error) {
	denied := func(p string) bool { return slices.ContainsFunc(deny, func(d string) bool { return within(p, d) }) }
	holds := func(p string) bool { return slices.ContainsFunc(deny, func(d string) bool { return within(d, p) }) }
	var walk func(dir string, write bool) error
	walk = func(dir string, write bool) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			p := joinPath(dir, e.Name())
			w := write || slices.Contains(writable, p)
			if e.Type()&os.ModeSymlink != 0 {
				real, err := filepath.EvalSymlinks(p)
				if err != nil || denied(real) || holds(real) {
					continue
				}
			}
			switch {
			case denied(p):
				continue
			case holds(p):
				if err := walk(p, w); err != nil {
					return err
				}
			case w:
				readWrite = append(readWrite, p)
			default:
				readExec = append(readExec, p)
			}
		}
		return nil
	}
	if err := walk(root, false); err != nil {
		return nil, nil, err
	}
	return readExec, readWrite, nil
}

// devices are the character devices a child may also write: what `> /dev/null` and a tool's
// terminal need. /dev itself is read and execute, like every system path.
var devices = []string{"/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty"}

// ForCommand is a credentialed command's confinement (ADR-0068, B9): read and execute on the
// image's system paths, read and write on /tmp, the writable devices and the Effect's own scratch
// (`effect`), and read on each secret file the command names (`read`). deny is the Effector's
// own: its key, its secrets and push credentials, the Worktree, the node caches and its whole
// scratch, each a real path. Everything else is denied by omission.
func ForCommand(deny []string, effect string, read []string) (Rules, error) {
	rx, rw, err := SystemPaths("/", deny, []string{"/tmp"})
	if err != nil {
		return Rules{}, err
	}
	rw = append(rw, devices...)
	return Rules{ReadExec: rx, ReadWrite: append(rw, effect), Read: read}, nil
}

func joinPath(dir, name string) string {
	if dir == "/" {
		return "/" + name
	}
	return dir + "/" + name
}

// within says whether p is base or lies beneath it.
func within(p, base string) bool {
	return p == base || strings.HasPrefix(p, strings.TrimSuffix(base, "/")+"/")
}
