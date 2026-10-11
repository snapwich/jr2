package confine

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// The test binary doubles as the confiner: re-executed with `confine` first, it runs Main, as
// /opt/jr2/bin/effector does in a pod. Landlock is real here (the host's kernel).
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "confine" {
		os.Exit(Main(os.Args[2:]))
	}
	os.Exit(m.Run())
}

const keyValue = "an-effector-placement-key-0123456789abcdef"

type layout struct {
	root, key, secrets, git, work, scratch, effect string
}

// A Sandbox Effector's mount in miniature: its key, two secrets, a push key under @git, the
// Agent's Worktree, and its scratch with one Effect's own directory.
func newLayout(t *testing.T) layout {
	t.Helper()
	// Beside the package, not under /tmp: a pod's /tmp holds none of the Effector's mount, so the
	// child may write /tmp whole, and a layout under /tmp would split it.
	dir, err := os.MkdirTemp(".", ".confine-")
	must(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	root, err := filepath.Abs(dir)
	must(t, err)
	root, err = filepath.EvalSymlinks(root)
	must(t, err)
	l := layout{
		root:    root,
		key:     filepath.Join(root, "effector"),
		secrets: filepath.Join(root, "secrets"),
		work:    filepath.Join(root, "work"),
		scratch: filepath.Join(root, "scratch"),
	}
	l.git = filepath.Join(l.secrets, "@git")
	l.effect = filepath.Join(l.scratch, "command-1")
	for _, d := range []string{l.key, filepath.Join(l.git, "jr2-git-push-1"), l.work, l.effect,
		filepath.Join(l.scratch, "push")} {
		must(t, os.MkdirAll(d, 0o700))
	}
	write := func(p, v string) { must(t, os.WriteFile(p, []byte(v), 0o600)) }
	write(filepath.Join(l.key, "key"), keyValue)
	write(filepath.Join(l.secrets, "aws"), "aws-secret-value-0123")
	write(filepath.Join(l.secrets, "other"), "other-secret-value-0123")
	write(filepath.Join(l.git, "jr2-git-push-1", "identity"), "-----BEGIN OPENSSH PRIVATE KEY-----")
	write(filepath.Join(l.work, "file"), "the Agent's file")
	write(filepath.Join(l.scratch, "push", "push-key"), "a copied push key")
	return l
}

// rules is what the command runner gives a child that names `aws`.
func (l layout) rules(t *testing.T) Rules {
	t.Helper()
	r, err := ForCommand([]string{l.key, l.secrets, l.work, l.scratch}, l.effect,
		[]string{filepath.Join(l.secrets, "aws")})
	must(t, err)
	return r
}

// confined runs script under sh, confined by rules, in the Effect's own directory.
func confined(t *testing.T, rules Rules, dir, script string) (string, error) {
	t.Helper()
	sh, err := exec.LookPath("sh")
	must(t, err)
	cmd := exec.Command(os.Args[0], append([]string{"confine"}, rules.Args(sh, []string{"sh", "-c", script})...)...)
	cmd.Dir = dir
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + dir}
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err = cmd.Run()
	return out.String(), err
}

func requireLandlock(t *testing.T) {
	t.Helper()
	if _, err := Probe(); err != nil {
		t.Fatalf("these tests need Landlock on the host: %v", err)
	}
}

func TestTheChildCannotReadTheKeyAnUnnamedSecretOrGitAndCannotWriteTheWorktree(t *testing.T) {
	requireLandlock(t)
	l := newLayout(t)
	rules := l.rules(t)
	for name, script := range map[string]string{
		"the placement key":         "cat " + filepath.Join(l.key, "key"),
		"an unnamed secret":         "cat " + filepath.Join(l.secrets, "other"),
		"the push key at @git":      "cat " + filepath.Join(l.git, "jr2-git-push-1", "identity"),
		"a push's copied key":       "cat " + filepath.Join(l.scratch, "push", "push-key"),
		"a write to the Worktree":   "echo x > " + filepath.Join(l.work, "new"),
		"a read of the Worktree":    "cat " + filepath.Join(l.work, "file"),
		"a list of the secrets":     "ls " + l.secrets,
		"the key from a grandchild": "sh -c 'sh -c \"cat " + filepath.Join(l.key, "key") + "\"'",
		"the effector's own memory": "cat /proc/" + strconv.Itoa(os.Getpid()) + "/environ",
	} {
		out, err := confined(t, rules, l.effect, script)
		if err == nil {
			t.Errorf("%s: the child succeeded: %q", name, out)
		}
		if !strings.Contains(out, "Permission denied") && !strings.Contains(out, "Operation not permitted") {
			t.Errorf("%s: no permission error: %q", name, out)
		}
		if strings.Contains(out, keyValue) || strings.Contains(out, "secret-value") || strings.Contains(out, "PRIVATE") {
			t.Errorf("%s: the output carries a secret: %q", name, out)
		}
	}
	if _, err := os.Stat(filepath.Join(l.work, "new")); !os.IsNotExist(err) {
		t.Error("the child wrote into the Worktree")
	}
}

func TestTheChildReadsItsNamedSecretAndWorksInItsScratchAndTmp(t *testing.T) {
	requireLandlock(t)
	l := newLayout(t)
	out, err := confined(t, l.rules(t), l.effect,
		"cat "+filepath.Join(l.secrets, "aws")+"; echo; echo made > made && cat made; "+
			"d=$(mktemp -d) && echo tmp > \"$d/f\" && cat \"$d/f\" && rm -r \"$d\"; "+
			"echo nothing > /dev/null && sh -c 'cat "+filepath.Join(l.secrets, "aws")+"'")
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if out != "aws-secret-value-0123\nmade\ntmp\naws-secret-value-0123" {
		t.Fatalf("got %q", out)
	}
}

func TestAFailedProbeRunsNothing(t *testing.T) {
	old := SetProbe(func() (int, error) { return 0, syscall.EOPNOTSUPP })
	defer SetProbe(old)
	marker := filepath.Join(t.TempDir(), "ran")
	err := Exec(Rules{}, "/bin/sh", []string{"sh", "-c", "touch " + marker}, nil)
	if err == nil || !strings.Contains(err.Error(), "landlock: the kernel has Landlock and it is not enabled") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("the program ran")
	}
}

func TestSystemPathsAreTheImagesSystemPathsAloneAndDescendAroundWhatIsDenied(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	must(t, err)
	for _, d := range []string{"usr/bin", "usr/lib", "etc/ssl", "etc/jr2-mount", "opt/jr2/bin", "run/jr2/effector",
		"run/jr2/secrets", "run/lock", "tmp", "work", "home/user", "root", "var/lib", "srv", "mnt", "media",
		"proc", "sys"} {
		must(t, os.MkdirAll(filepath.Join(root, d), 0o700))
	}
	must(t, os.Symlink("usr/bin", filepath.Join(root, "bin")))
	must(t, os.Symlink("usr/lib", filepath.Join(root, "lib")))
	// A system path that is a link into a denied path is skipped whole.
	must(t, os.Symlink("run/jr2/secrets", filepath.Join(root, "sbin")))
	at := func(p string) string { return filepath.Join(root, p) }
	rx, rw, err := SystemPaths(root, []string{at("run/jr2/effector"), at("run/jr2/secrets"), at("work"),
		at("etc/jr2-mount")})
	must(t, err)
	slices.Sort(rx)
	want := []string{at("bin"), at("etc/ssl"), at("lib"), at("opt"), at("usr")}
	if !slices.Equal(rx, want) {
		t.Fatalf("read+exec %v, want %v", rx, want)
	}
	if !slices.Equal(rw, []string{at("tmp")}) {
		t.Fatalf("read+write %v", rw)
	}
}

// On this host: nothing outside the system paths, /tmp, the devices and the Effect's own
// directory is allowed, so /home, /root, /var, /proc, /sys and /run are denied by omission.
func TestForCommandAllowsNothingOutsideTheSystemPaths(t *testing.T) {
	l := newLayout(t)
	rules := l.rules(t)
	allowed := append(append(append([]string{}, rules.ReadExec...), rules.ReadWrite...), rules.Read...)
	for _, p := range allowed {
		top := "/" + strings.SplitN(strings.TrimPrefix(p, "/"), "/", 2)[0]
		if slices.Contains(systemNames, top) || top == "/tmp" || slices.Contains(devices, p) || p == l.effect ||
			p == filepath.Join(l.secrets, "aws") {
			continue
		}
		t.Errorf("allowed: %s", p)
	}
}

func TestTheChildCannotReadOutsideTheSystemPaths(t *testing.T) {
	requireLandlock(t)
	l := newLayout(t)
	home, err := os.UserHomeDir()
	must(t, err)
	for name, script := range map[string]string{
		"/proc/net/unix": "cat /proc/net/unix",
		"a home":         "ls " + home,
		"/var":           "ls /var",
		"/run":           "ls /run",
	} {
		out, err := confined(t, l.rules(t), l.effect, script)
		if err == nil || !strings.Contains(out, "Permission denied") {
			t.Errorf("%s: %v %q", name, err, out)
		}
	}
}

func TestArgsRoundTrip(t *testing.T) {
	r := Rules{ReadExec: []string{"/usr"}, ReadWrite: []string{"/tmp", "/s/1"}, Read: []string{"/run/jr2/secrets/aws"}}
	got, path, argv, err := Parse(r.Args("/usr/bin/env", []string{"env", "--", "-x"}))
	must(t, err)
	if !slices.Equal(got.ReadExec, r.ReadExec) || !slices.Equal(got.ReadWrite, r.ReadWrite) ||
		!slices.Equal(got.Read, r.Read) || path != "/usr/bin/env" || !slices.Equal(argv, []string{"env", "--", "-x"}) {
		t.Fatalf("got %+v %q %q", got, path, argv)
	}
	for _, bad := range [][]string{{"--rx"}, {"--rx", "relative", "--", "/x", "x"}, {"/x"}, {"--", "/x"}} {
		if _, _, _, err := Parse(bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
