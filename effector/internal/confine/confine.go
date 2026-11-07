// Package confine keeps a credentialed command's child from the Sandbox Effector's mount with
// Landlock (ADR-0068). The child runs as the Effector's uid in the Effector's container, where
// the placement key, every placed secret and the push and signing keys are files that uid can
// read; its program is often the Agent's code. So the Effector does not exec argv itself: it execs
// its own binary as the confiner (`effector confine <rules> -- <path> <argv...>`), which sets
// PR_SET_NO_NEW_PRIVS, makes a Landlock ruleset, adds one rule per allowed path, restricts itself
// and only then calls execve(argv). Landlock is an allow-list the kernel enforces and every
// descendant inherits, and a confined process cannot ptrace a process outside its domain, so
// `/proc/<effector>/mem` is closed too. What a rule does not name is denied: the key, every secret
// the command does not name, the push credentials, the Worktree.
//
// The Harness of a Sandbox confines its spawner the same way (ADR-0076), and so each process that
// the spawner starts. Its rules are ForHarness's: every right on every path, except the paths it
// denies (`/run/jr2`), where the domain can list names and do nothing else.
//
// Three raw syscalls (444, 445, 446: the same numbers on amd64 and arm64) and prctl; the standard
// library only (ADR-0068). The minimum is ABI 3 (ADR-0077): below ABI 2, no confined process can
// move a file into another folder, and below ABI 3 the domain can truncate a file that it cannot
// write, such as a conversation under /run/jr2. The confiner sets the scopes of abstract Unix
// sockets and of signals (ABI 6) when the kernel offers them.
package confine

import (
	"errors"
	"fmt"
	"io"
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

	// The scopes of ABI 6, as the kernel's uapi numbers them (LANDLOCK_SCOPE_*).
	// scopeAbstractUnixSocket keeps a confined process from connecting to an abstract Unix socket
	// that a process outside its domain made. The containers of a pod share one network namespace,
	// so without it the domain reaches each abstract socket of the Harness and of the Custodian.
	scopeAbstractUnixSocket = 1 << 0
	// scopeSignal keeps a confined process from signalling a process outside its domain: a confined
	// child of the Harness cannot kill the Harness, which has the same uid (ADR-0076).
	scopeSignal = 1 << 1
	scopes      = scopeAbstractUnixSocket | scopeSignal

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

// MinABI is the lowest Landlock ABI jr2 confines with (ADR-0077). ABI 1 has no REFER right, so
// under it a confined process can never rename or link a file into another folder, and `mv`, git
// and the package managers do that. ABI 2 does not handle TRUNCATE, so under it a confined process
// can truncate(2) a file that the rules let it do nothing else to: a conversation under /run/jr2
// (ADR-0076).
const MinABI = 3

// Probe answers the Landlock ABI this kernel offers, or why jr2 cannot confine with it: a kernel
// built without it (ENOSYS), one that has it and did not enable it at boot (EOPNOTSUPP), or one
// whose ABI is below MinABI.
func Probe() (int, error) {
	abi, err := probe()
	if err == nil && abi < 1 {
		err = fmt.Errorf("the kernel answered ABI %d", abi)
	}
	if err == nil && abi < MinABI {
		err = fmt.Errorf("the kernel offers Landlock ABI %d, and jr2 needs ABI %d or later (Linux 6.2)", abi, MinABI)
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
	// ReadDir: list the names in a directory, in its whole tree, and nothing else (the Harness's root,
	// so that the domain lists each folder, the folders above and in a denied path too).
	ReadDir []string
}

const (
	separator = "--"
	flagRX    = "--rx"
	flagRW    = "--rw"
	flagRO    = "--ro"
	flagRD    = "--rd"
)

// Args is the confiner's command line for rules and the program to exec: the path execve runs,
// then argv.
func (r Rules) Args(path string, argv []string) []string {
	out := []string{}
	for _, set := range []struct {
		flag  string
		paths []string
	}{{flagRX, r.ReadExec}, {flagRW, r.ReadWrite}, {flagRO, r.Read}, {flagRD, r.ReadDir}} {
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
		case flagRX, flagRW, flagRO, flagRD:
			if i+1 >= len(args) || !strings.HasPrefix(args[i+1], "/") {
				return r, "", nil, fmt.Errorf("confine: %s needs an absolute path", args[i])
			}
			switch args[i] {
			case flagRX:
				r.ReadExec = append(r.ReadExec, args[i+1])
			case flagRW:
				r.ReadWrite = append(r.ReadWrite, args[i+1])
			case flagRD:
				r.ReadDir = append(r.ReadDir, args[i+1])
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
	// Probe refused every ABI below 3, so REFER and TRUNCATE are always handled.
	handled := uint64(abi1 | accessRefer | accessTruncate)
	if _, _, errno := syscall.RawSyscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0); errno != 0 {
		return fmt.Errorf("prctl(PR_SET_NO_NEW_PRIVS): %w", errno)
	}
	// struct landlock_ruleset_attr: handled_access_fs (ABI 1), handled_access_net (ABI 4) and scoped
	// (ABI 6). A kernel reads the size it is given, so an older one gets the first field alone.
	attr := struct{ handledAccessFS, handledAccessNet, scoped uint64 }{handledAccessFS: handled}
	size := unsafe.Sizeof(attr.handledAccessFS)
	if abi >= 6 {
		attr.scoped = scopes
		size = unsafe.Sizeof(attr)
	}
	fd, _, errno := syscall.RawSyscall(sysCreateRuleset, uintptr(unsafe.Pointer(&attr)), size, 0)
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
		{rules.ReadDir, accessReadDir},
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
// file (a file's rule may carry file rights only). A path that is absent is skipped. A path with a
// symbolic link at any component is refused (ELOOP), and the confiner then starts nothing: the rules
// are made once, and the spawner's confiner opens them again at each restart (ADR-0076), so a link
// that a confined process retargeted would carry a rule onto a denied path.
//
// openNoSymlinks is openat2(2) with RESOLVE_NO_SYMLINKS and RESOLVE_NO_MAGICLINKS: O_PATH alone
// follows every link on the path.
func addRule(ruleset int, path string, rights uint64) error {
	fd, err := openNoSymlinks(path)
	if errors.Is(err, syscall.ENOENT) {
		return nil
	}
	if errors.Is(err, syscall.ELOOP) {
		return fmt.Errorf("confine: %s: a symbolic link is on the path, and a rule never follows one: what it "+
			"names now can be other than what it named when the rules were made (ADR-0076)", path)
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

// sysOpenat2 is openat2's number in the unified syscall table (Linux 5.6), the same on amd64 and
// arm64; package beneath uses it too.
const (
	sysOpenat2          = 437
	resolveNoMagiclinks = 0x02
	resolveNoSymlinks   = 0x04
	atFdCwd             = -100
)

func openNoSymlinks(path string) (int, error) {
	p, err := syscall.BytePtrFromString(path)
	if err != nil {
		return -1, err
	}
	how := struct{ flags, mode, resolve uint64 }{
		flags:   oPath | syscall.O_CLOEXEC,
		resolve: resolveNoSymlinks | resolveNoMagiclinks,
	}
	for {
		dirfd := atFdCwd // a variable: a negative constant does not convert to uintptr
		fd, _, errno := syscall.Syscall6(sysOpenat2, uintptr(dirfd), uintptr(unsafe.Pointer(p)),
			uintptr(unsafe.Pointer(&how)), unsafe.Sizeof(how), 0, 0)
		if errno == syscall.EINTR || errno == syscall.EAGAIN {
			continue
		}
		if errno != 0 {
			return -1, errno
		}
		return int(fd), nil
	}
}

// deniedTop are the top-level directories a credentialed command's child never reads: the kernel
// and process pseudo-filesystems (`/proc`, `/sys`, `/dev` — the devices it needs are added one by
// one below), the runtime trees where jr2 mounts the Effector's own files (`/run`), the shared
// `/tmp` (ADR-0068 rule 3: each child writes its own TMPDIR in its Effect's scratch instead, so one
// child never reads what another wrote), and the volatile and per-user trees
// that hold no tool an image ships (`/home`, `/root`, `/var`, `/srv`, `/mnt`, `/media`,
// `/lost+found`). Everything else a top-level entry of the image holds is the image's own — the
// programs, libraries and configuration a tool reads, under `/usr`, `/bin`, `/etc`, `/opt` or a
// name of the image's own (`/google-cloud-sdk`, `/nix`) — and is allowed, so the rules follow the
// image and break on no layout. Each jr2 mount that holds a secret or the Agent's files is under
// one of these names (`/run`) or named in deny (`/work`, `/repos`, the scratch); the two others,
// the runtime at `/opt/jr2` and the instance's caBundle at `/etc/jr2/effector-ca`, hold only public
// data and are readable. A jr2 mount that holds a secret goes under `/run/jr2`: one under `/etc`,
// `/opt` or a new top-level name is the child's to read.
var deniedTop = []string{"/proc", "/sys", "/dev", "/run", "/tmp", "/home", "/root", "/var", "/srv", "/mnt",
	"/media", "/lost+found"}

// SystemPaths is what a credentialed command's child may read and run under root: every top-level
// entry the image holds that is not in deniedTop. An entry that holds a path in deny is not
// allowed whole; its other entries are, one level down at a time, so a mount placed inside a
// system path stays denied. A symbolic link gets no rule: Landlock checks the path that a link
// resolves to, so `/bin -> usr/bin` works through the rule on `/usr`, and `/lib -> /run/jr2/secrets`
// or `/data -> /var/data` allows nothing. Every path in deny is a real path (no link in it).
func SystemPaths(root string, deny []string) (readExec []string, err error) {
	return carve(root, deny, deniedTop)
}

// carve is every path under root that holds no path of deny and lies beneath none, as few paths as
// it can: a top-level entry whole when it holds nothing denied, and the entries of one that does,
// one level down at a time. A top-level name in skip is left out whole. A symbolic link gets no
// rule: what it names gets its own where it is allowed, and the kernel checks the path that a link
// resolves to. A rule on a link would follow it each time the confiner opens the rules, and a
// confined process that writes the folder of the link's target can retarget it onto a denied path
// before the next open (ADR-0076). Every path in deny is a real path (no link in it). Landlock
// allows a path only by a rule, so a folder that holds a denied path gets no rule of its own: a
// confined process cannot list it, or add or remove an entry directly in it.
func carve(root string, deny, skip []string) (allowed []string, err error) {
	denied := func(p string) bool { return slices.ContainsFunc(deny, func(d string) bool { return within(p, d) }) }
	holds := func(p string) bool { return slices.ContainsFunc(deny, func(d string) bool { return within(d, p) }) }
	var allow func(p string) error
	allow = func(p string) error {
		info, err := os.Lstat(p)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			// A link gets no rule. Its target gets its own rule where it is allowed, and the kernel
			// checks the path that a link resolves to. A rule on the link would allow what the link
			// names when the confiner opens it, and a confined process can change that (ADR-0076).
			return nil
		}
		switch {
		case denied(p):
			return nil
		case holds(p):
			entries, err := os.ReadDir(p)
			if err != nil {
				return err
			}
			for _, e := range entries {
				if err := allow(joinPath(p, e.Name())); err != nil {
					return err
				}
			}
		default:
			allowed = append(allowed, p)
		}
		return nil
	}
	// Every top-level entry the image holds, bar the skipped names. The image decides what it holds;
	// reading the root follows it. A root that cannot be read is a defect the caller turns into an
	// outcome. A root that is itself denied allows nothing.
	if denied(root) {
		return nil, nil
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		name := "/" + e.Name()
		if slices.Contains(skip, name) {
			continue
		}
		if err := allow(joinPath(root, e.Name())); err != nil {
			return nil, err
		}
	}
	return allowed, nil
}

// devices are the character devices a child may read and write: what `> /dev/null` and a tool's
// terminal need. The rest of /dev is denied by omission.
var devices = []string{"/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty"}

// ForCommand is a credentialed command's confinement (ADR-0068): read and execute on the
// image's system paths, read and write on the devices and the Effect's own scratch (`effect`, which
// holds the child's HOME and TMPDIR), and read on each secret file the command names (`read`).
// Everything else is denied by omission: the key, the secrets the command does not name, the push
// credentials, the Worktree, the node caches, /tmp and the rest of the scratch. deny is those paths of the Effector's
// own, each a real path, kept out even where one lies inside a system path.
func ForCommand(deny []string, effect string, read []string) (Rules, error) {
	rx, err := SystemPaths("/", deny)
	if err != nil {
		return Rules{}, err
	}
	rw := append(slices.Clone(devices), effect)
	return Rules{ReadExec: rx, ReadWrite: rw, Read: read}, nil
}

// ForHarness is the domain of the Harness of a Sandbox (ADR-0076): the spawner, and so each process
// that it starts and the file tools' I/O. Every handled right on every path under root, except the
// paths of deny (`/run/jr2`, each a real path): carve allows each sibling of a denied path and of
// each folder above it, one level at a time. root itself gets READ_DIR on its whole tree, so that
// `ls /`, `ls /run` and `find /` work as they do outside jr2. That right also lists the names in a
// denied path (the Stand-ins' names, the conversations' file names), which are not secrets; their
// contents stay out of reach, and the domain makes, removes, moves and links nothing there.
// Landlock only narrows the Unix permissions, so the domain does what the uid does, except reach a
// denied path. What the kernel keeps read-only (the Repo caches, the runtime, the CA bundles) stays
// read-only. A confined process cannot ptrace a process outside its domain, so `/proc` is open and
// the Harness's environ and memory are not.
//
// read is the folders inside a denied path that the domain may read and not write: the folder of
// the Harness's own where pi's `bash` keeps a long command's whole output, which the model reads
// there. The domain cannot write, move or link anything there, so the Harness opens a path there
// as safely as its own. Each must lie in a path of deny: a folder outside one already has every
// right.
//
// root is `/` in the Harness; a test gives its own.
func ForHarness(root string, deny, read []string) (Rules, error) {
	if len(deny) == 0 {
		return Rules{}, errors.New("the Harness's domain needs a denied path: without one it is no boundary")
	}
	for _, d := range deny {
		if !strings.HasPrefix(d, "/") {
			return Rules{}, fmt.Errorf("the denied path %q is not absolute", d)
		}
	}
	for _, r := range read {
		if !strings.HasPrefix(r, "/") {
			return Rules{}, fmt.Errorf("the read-only path %q is not absolute", r)
		}
		if !slices.ContainsFunc(deny, func(d string) bool { return within(r, d) && r != d }) {
			return Rules{}, fmt.Errorf("the read-only path %s is in no denied path, so the domain would write it too", r)
		}
	}
	rw, err := carve(root, deny, nil)
	if err != nil {
		return Rules{}, err
	}
	return Rules{ReadWrite: rw, Read: slices.Clone(read), ReadDir: []string{root}}, nil
}

// ProbeMain is `effector probe`, the probe of a process that confines and runs no Go of its own
// (the Harness, ADR-0077): `landlock abi=<n>` and 0, or why there is none and 1.
func ProbeMain(stdout, stderr io.Writer) int {
	abi, err := Probe()
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "landlock: %v\n", err)
		return 1
	}
	_, _ = fmt.Fprintf(stdout, "landlock abi=%d\n", abi)
	return 0
}

// HarnessRulesMain is `effector harness-rules --deny <path> [--deny <path>]... [--read <path>]...`:
// ForHarness's rules for root `/`, each argument ended by a NUL byte, in confine's own format (Args,
// without the program), so the Harness puts them before `--` as they are. At least one `--deny` is
// required. Each `--read` is a folder in a denied path that the domain may read. A path is resolved
// to its real path here (realPath); a deny path that does not exist is still left out by the
// carve-out, so a folder made there later gets no rule.
func HarnessRulesMain(args []string, stdout, stderr io.Writer) int {
	var deny, read []string
	for i := 0; i < len(args); i++ {
		if args[i] != "--deny" && args[i] != "--read" {
			_, _ = fmt.Fprintf(stderr,
				"harness-rules: %q is no flag (usage: harness-rules --deny <path>... [--read <path>]...)\n", args[i])
			return 2
		}
		if i+1 >= len(args) || !strings.HasPrefix(args[i+1], "/") {
			_, _ = fmt.Fprintf(stderr, "harness-rules: %s needs an absolute path\n", args[i])
			return 2
		}
		real, err := realPath(args[i+1])
		if err != nil {
			_, _ = fmt.Fprintf(stderr, "harness-rules: %s: %v\n", args[i+1], err)
			return 1
		}
		if args[i] == "--deny" {
			deny = append(deny, real)
		} else {
			read = append(read, real)
		}
		i++
	}
	if len(deny) == 0 {
		_, _ = fmt.Fprintln(stderr, "harness-rules: at least one --deny <path> is required")
		return 2
	}
	rules, err := ForHarness("/", deny, read)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "harness-rules: %v\n", err)
		return 1
	}
	all := rules.Args("/", nil)
	for _, a := range all[:len(all)-2] {
		_, _ = fmt.Fprintf(stdout, "%s\x00", a)
	}
	return 0
}

// realPath is p with every link resolved. When p does not exist, the longest part of it that exists
// is resolved and the rest is kept, so a link above a missing denied path is still followed.
func realPath(p string) (string, error) {
	p = filepath.Clean(p)
	real, err := filepath.EvalSymlinks(p)
	if err == nil {
		return real, nil
	}
	if !errors.Is(err, os.ErrNotExist) || p == "/" {
		return "", err
	}
	parent, err := realPath(filepath.Dir(p))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(p)), nil
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
