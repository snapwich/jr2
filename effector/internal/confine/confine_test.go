package confine

import (
	"bytes"
	"net"
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
		// syscall.Exit, not os.Exit: under -coverprofile the test binary's exit hook writes
		// "GOCOVERDIR not set" to stderr, into the output the test reads. The Effector's binary has no such hook.
		syscall.Exit(Main(os.Args[2:]))
	}
	if len(os.Args) > 2 && os.Args[1] == "dial-abstract" {
		syscall.Exit(dialAbstract(os.Args[2]))
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
	// Beside the package, not under /tmp: the layout's carve-outs are what a test reads here, and
	// /tmp is denied whole (ADR-0068 rule 3).
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

func TestTheChildReadsItsNamedSecretAndWorksInItsScratchAndItsOwnTmpdir(t *testing.T) {
	requireLandlock(t)
	l := newLayout(t)
	tmp := filepath.Join(l.effect, "tmp")
	must(t, os.Mkdir(tmp, 0o700))
	out, err := confined(t, l.rules(t), l.effect,
		"export TMPDIR="+tmp+"; cat "+filepath.Join(l.secrets, "aws")+"; echo; echo made > made && cat made; "+
			"d=$(mktemp -d) && echo tmp > \"$d/f\" && cat \"$d/f\" && rm -r \"$d\"; "+
			"echo nothing > /dev/null && sh -c 'cat "+filepath.Join(l.secrets, "aws")+"'")
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if out != "aws-secret-value-0123\nmade\ntmp\naws-secret-value-0123" {
		t.Fatalf("got %q", out)
	}
}

// ADR-0068 rule 3: /tmp is out of the ruleset — a child neither writes nor reads it, so what one child
// leaves there no other child reads.
func TestTheChildCannotWriteOrReadTmp(t *testing.T) {
	requireLandlock(t)
	l := newLayout(t)
	planted, err := os.CreateTemp("/tmp", "jr2-confine-")
	must(t, err)
	_, _ = planted.WriteString("another child's secret")
	must(t, planted.Close())
	t.Cleanup(func() { _ = os.Remove(planted.Name()) })
	for name, script := range map[string]string{
		"a write to /tmp": "echo x > /tmp/jr2-confine-write-" + strconv.Itoa(os.Getpid()),
		"a read of /tmp":  "cat " + planted.Name(),
	} {
		out, err := confined(t, l.rules(t), l.effect, script)
		if err == nil || !strings.Contains(out, "Permission denied") {
			t.Errorf("%s: %v %q", name, err, out)
		}
		if strings.Contains(out, "another child's secret") {
			t.Errorf("%s: the child read /tmp: %q", name, out)
		}
	}
	if _, err := os.Stat("/tmp/jr2-confine-write-" + strconv.Itoa(os.Getpid())); !os.IsNotExist(err) {
		_ = os.Remove("/tmp/jr2-confine-write-" + strconv.Itoa(os.Getpid()))
		t.Error("the child wrote /tmp")
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

// SystemPaths follows the image: every top-level entry the image holds is allowed but the denied
// names, so a tool under a non-FHS top-level (`/google-cloud-sdk`, `/nix`) runs, and `/proc`,
// `/sys`, `/run`, `/home` and the rest are denied. A system path that holds one of the Effector's
// own paths descends around it; a link gets no rule.
func TestSystemPathsFollowTheImageAndDescendAroundWhatIsDenied(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	must(t, err)
	for _, d := range []string{"usr/bin", "usr/lib", "etc/ssl", "etc/jr2-mount", "opt/jr2/bin", "run/jr2/effector",
		"run/jr2/secrets", "run/lock", "tmp", "work", "home/user", "root", "var/lib", "srv", "mnt", "media",
		"proc", "sys", "google-cloud-sdk/bin", "nix/store"} {
		must(t, os.MkdirAll(filepath.Join(root, d), 0o700))
	}
	must(t, os.Symlink("usr/bin", filepath.Join(root, "bin")))
	must(t, os.Symlink("usr/lib", filepath.Join(root, "lib")))
	// A system path that is a link into a denied path, or into a denied top-level, is skipped whole.
	must(t, os.Symlink("run/jr2/secrets", filepath.Join(root, "sbin")))
	must(t, os.Symlink("var/lib", filepath.Join(root, "data")))
	at := func(p string) string { return filepath.Join(root, p) }
	rx, err := SystemPaths(root, []string{at("run/jr2/effector"), at("run/jr2/secrets"), at("work"),
		at("etc/jr2-mount")})
	must(t, err)
	slices.Sort(rx)
	// The image's own tool trees are allowed — google-cloud-sdk and nix among them — and the
	// denied names (run, home, root, var, srv, mnt, media, proc, sys, tmp) and work are not. A link
	// gets no rule (`/bin` works through the rule on `/usr`), so `/data -> var/lib` reaches nothing.
	want := []string{at("etc/ssl"), at("google-cloud-sdk"), at("nix"), at("opt"), at("usr")}
	if !slices.Equal(rx, want) {
		t.Fatalf("read+exec %v, want %v", rx, want)
	}
}

// On this host: no path under a denied top-level (bar the devices) and no path under one
// of the Effector's own mounts is allowed — /home, /root, /var, /proc, /sys and /run are denied —
// while the per-Effect scratch and the one named secret are the carve-outs.
func TestForCommandAllowsNothingDeniedOrUnderThePseudoFilesystems(t *testing.T) {
	l := newLayout(t)
	rules := l.rules(t)
	deny := []string{l.key, l.secrets, l.work, l.scratch}
	named := filepath.Join(l.secrets, "aws")
	allowed := append(append(append([]string{}, rules.ReadExec...), rules.ReadWrite...), rules.Read...)
	for _, p := range allowed {
		if p == l.effect || p == named {
			continue
		}
		top := "/" + strings.SplitN(strings.TrimPrefix(p, "/"), "/", 2)[0]
		if slices.Contains(deniedTop, top) && !slices.Contains(devices, p) {
			t.Errorf("allowed under a denied top-level: %s", p)
		}
		for _, d := range deny {
			if within(p, d) {
				t.Errorf("allowed under a denied path: %s", p)
			}
		}
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
	r := Rules{ReadExec: []string{"/usr"}, ReadWrite: []string{"/tmp", "/s/1"}, Read: []string{"/run/jr2/secrets/aws"},
		ReadDir: []string{"/"}}
	got, path, argv, err := Parse(r.Args("/usr/bin/env", []string{"env", "--", "-x"}))
	must(t, err)
	if !slices.Equal(got.ReadExec, r.ReadExec) || !slices.Equal(got.ReadWrite, r.ReadWrite) ||
		!slices.Equal(got.Read, r.Read) || !slices.Equal(got.ReadDir, r.ReadDir) || path != "/usr/bin/env" || !slices.Equal(argv, []string{"env", "--", "-x"}) {
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

// The Harness's domain (ADR-0076): every right on every path but the denied one. A confined process
// writes a folder that the uid owns outside the Worktree, writes /tmp, renames a file into another
// folder (the same inode: REFER, not a copy), and reads the /proc of a process of its own domain.
// It lists `/`, each folder above the denied path and the denied path itself, as a user does on a
// machine. It reads, writes, makes, removes, moves and links nothing under the denied path, by its
// name or through a link, and reaches neither the Harness's environ nor its memory.
func TestTheHarnessDomainDoesWhatTheUidDoesButReachesNothingDenied(t *testing.T) {
	requireLandlock(t)
	l := newLayout(t)
	dirs := map[string]string{}
	for _, d := range []string{"work2", "app", "a", "b", "run-jr2/standins", "run-jr2/control", "run-jr2/conversations"} {
		dirs[d] = filepath.Join(l.root, d)
		must(t, os.MkdirAll(dirs[d], 0o700))
	}
	denied := filepath.Join(l.root, "run-jr2")
	control := filepath.Join(dirs["run-jr2/control"], "standin")
	must(t, os.WriteFile(control, []byte("control-stand-in-value"), 0o400))
	must(t, os.WriteFile(filepath.Join(dirs["run-jr2/standins"], "ANTHROPIC_API_KEY"), []byte("model-stand-in"), 0o400))
	must(t, os.WriteFile(filepath.Join(dirs["run-jr2/conversations"], "record"), []byte("a conversation"), 0o600))
	must(t, os.WriteFile(filepath.Join(dirs["a"], "f"), []byte("moved\n"), 0o600))
	must(t, os.Symlink(control, filepath.Join(dirs["work2"], "to-standin")))
	must(t, os.Symlink(denied, filepath.Join(dirs["work2"], "to-run-jr2")))
	rules, err := ForHarness("/", []string{denied}, nil)
	must(t, err)
	if len(rules.ReadExec) != 0 || len(rules.Read) != 0 || !slices.Equal(rules.ReadDir, []string{"/"}) {
		t.Fatalf("the Harness's domain has rules that are not every right, or READ_DIR on the root: %+v", rules)
	}
	for _, p := range rules.ReadWrite {
		if within(p, denied) || within(denied, p) {
			t.Fatalf("a rule reaches the denied path: %s", p)
		}
	}
	tmp, err := os.MkdirTemp("", "jr2-harness-domain-")
	must(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(tmp) })
	a, b := filepath.Join(dirs["a"], "f"), filepath.Join(dirs["b"], "f")
	out, err := confined(t, rules, dirs["work2"], strings.Join([]string{
		"echo made > made && cat made",
		"echo app > " + filepath.Join(dirs["app"], "owned") + " && cat " + filepath.Join(dirs["app"], "owned"),
		"echo tmp > " + filepath.Join(tmp, "t") + " && cat " + filepath.Join(tmp, "t"),
		"before=$(stat -c %i " + a + ") && mv " + a + " " + b + " && after=$(stat -c %i " + b + ")" +
			" && [ \"$before\" = \"$after\" ] && cat " + b,
		"JR2_MARK=sibling sleep 30 & pid=$!; sleep 0.2; tr '\\0' '\\n' < /proc/$pid/environ | grep -x JR2_MARK=sibling" +
			" && kill $pid",
	}, " && "))
	if err != nil || out != "made\napp\ntmp\nmoved\nJR2_MARK=sibling\n" {
		t.Fatalf("%v: %q", err, out)
	}
	// The root, each folder above the denied path, and the denied path itself list, as they do outside
	// jr2: the names there are not secrets. find walks into the denied path and reads no file there.
	listed := []string{denied, dirs["run-jr2/standins"]}
	for p := denied; p != "/"; {
		p = filepath.Dir(p)
		listed = append(listed, p)
	}
	for _, p := range listed {
		out, err := confined(t, rules, dirs["work2"], "ls -a "+p)
		if err != nil || !strings.Contains(out, "..") {
			t.Errorf("ls %s: %v %q", p, err, out)
		}
	}
	out, err = confined(t, rules, dirs["work2"], "ls "+dirs["run-jr2/standins"]+" && find "+denied+" -maxdepth 2 | sort")
	if err != nil || !strings.Contains(out, "ANTHROPIC_API_KEY\n") || !strings.Contains(out, control+"\n") {
		t.Errorf("the names in the denied path: %v %q", err, out)
	}
	for name, script := range map[string]string{
		"the control Stand-in":               "cat " + control,
		"a held Stand-in":                    "cat " + filepath.Join(dirs["run-jr2/standins"], "ANTHROPIC_API_KEY"),
		"the conversations":                  "cat " + filepath.Join(dirs["run-jr2/conversations"], "record"),
		"a write under the denied path":      "echo x > " + filepath.Join(dirs["run-jr2/conversations"], "new"),
		"a folder made in the denied path":   "mkdir " + filepath.Join(denied, "new"),
		"a write over a Stand-in":            "echo x > " + filepath.Join(dirs["run-jr2/standins"], "ANTHROPIC_API_KEY"),
		"a truncate of a Stand-in":           "truncate -s 0 " + filepath.Join(dirs["run-jr2/standins"], "ANTHROPIC_API_KEY"),
		"a remove of a Stand-in":             "rm -f " + filepath.Join(dirs["run-jr2/standins"], "ANTHROPIC_API_KEY"),
		"a move of the denied path":          "mv " + denied + " " + filepath.Join(dirs["work2"], "stolen"),
		"a move out of the denied path":      "mv " + control + " " + filepath.Join(dirs["work2"], "stolen"),
		"a move into the denied path":        "mv " + filepath.Join(dirs["work2"], "made") + " " + filepath.Join(denied, "made"),
		"a hard link to a Stand-in":          "ln " + control + " " + filepath.Join(dirs["work2"], "hard"),
		"a symbolic link in the denied path": "ln -s /etc/passwd " + filepath.Join(denied, "planted"),
		"a link to the Stand-in":             "cat " + filepath.Join(dirs["work2"], "to-standin"),
		"a write through that link":          "echo x > " + filepath.Join(dirs["work2"], "to-standin"),
		"a link to the denied folder":        "cat " + filepath.Join(dirs["work2"], "to-run-jr2", "control", "standin"),
		"the Harness's environ":              "cat /proc/" + strconv.Itoa(os.Getpid()) + "/environ",
		"the Harness's memory":               "head -c 1 /proc/" + strconv.Itoa(os.Getpid()) + "/mem",
	} {
		out, err := confined(t, rules, dirs["work2"], script)
		if err == nil {
			t.Errorf("%s: the child succeeded: %q", name, out)
		}
		if strings.Contains(out, "stand-in") || strings.Contains(out, "a conversation") {
			t.Errorf("%s: the output carries what the child may not read: %q", name, out)
		}
	}
	for _, p := range []string{filepath.Join(dirs["run-jr2/conversations"], "new"), filepath.Join(denied, "new"),
		filepath.Join(denied, "made"), filepath.Join(denied, "planted"), filepath.Join(dirs["work2"], "stolen")} {
		if _, err := os.Lstat(p); !os.IsNotExist(err) {
			t.Errorf("the child made %s", p)
		}
	}
	if got, _ := os.ReadFile(filepath.Join(dirs["run-jr2/standins"], "ANTHROPIC_API_KEY")); string(got) != "model-stand-in" {
		t.Errorf("the held Stand-in changed: %q", got)
	}
	if got, _ := os.ReadFile(control); string(got) != "control-stand-in-value" {
		t.Errorf("the control Stand-in changed: %q", got)
	}
}

// ForHarness carves around the denied path one level at a time: every top-level entry whole but
// the one that holds it, and that one's other entries. A link gets no rule: its target has its own
// where it is allowed.
func TestForHarnessCarvesAroundTheDeniedPathOneLevelAtATime(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	must(t, err)
	for _, d := range []string{"usr/bin", "etc", "work", "tmp", "proc", "run/jr2/control", "run/lock", "var"} {
		must(t, os.MkdirAll(filepath.Join(root, d), 0o700))
	}
	at := func(p string) string { return filepath.Join(root, p) }
	must(t, os.Symlink(at("run"), at("var/run")))
	must(t, os.Symlink(at("run/jr2/control"), at("etc/control")))
	must(t, os.Symlink(at("usr/bin"), at("bin")))
	must(t, os.WriteFile(at("run/pidfile"), nil, 0o600))
	rules, err := ForHarness(root, []string{at("run/jr2")}, nil)
	must(t, err)
	got := slices.Clone(rules.ReadWrite)
	slices.Sort(got)
	want := []string{at("etc"), at("proc"), at("run/lock"), at("run/pidfile"), at("tmp"), at("usr"),
		at("var"), at("work")}
	if !slices.Equal(got, want) {
		t.Fatalf("read+write %v, want %v", got, want)
	}
	if !slices.Equal(rules.ReadDir, []string{root}) {
		t.Fatalf("READ_DIR %v, want the root alone", rules.ReadDir)
	}
	// A folder whose entries are links into the denied path, one level down.
	rules, err = ForHarness(at("etc"), []string{at("run/jr2")}, nil)
	must(t, err)
	if len(rules.ReadWrite) != 0 {
		t.Fatalf("a link into the denied path got a rule: %v", rules.ReadWrite)
	}
	if _, err := ForHarness(root, nil, nil); err == nil {
		t.Fatal("a domain with no denied path was made")
	}
}

// ADR-0076: the rules are made once, and the spawner's confiner opens them again at each restart.
// A link beside the denied path whose target is in a folder that the domain writes (here `w`) once
// carried a rule; the domain retargeted the link's target onto the denied path and ended the
// spawner, and the next confiner allowed the denied path. Now a link gets no rule, so the Stand-in
// read fails before and after the retarget, with the same rules (a restart).
func TestARetargetedLinkGivesARestartedDomainNothingDenied(t *testing.T) {
	requireLandlock(t)
	l := newLayout(t)
	at := func(p string) string { return filepath.Join(l.root, p) }
	for _, d := range []string{"run/jr2/control", "w/target"} {
		must(t, os.MkdirAll(at(d), 0o700))
	}
	denied := at("run/jr2")
	must(t, os.WriteFile(at("run/jr2/control/standin"), []byte("control-stand-in-value"), 0o400))
	must(t, os.Symlink(at("w/target"), at("run/link")))
	rules, err := ForHarness("/", []string{denied}, nil)
	must(t, err)
	for _, p := range rules.ReadWrite {
		if p == at("run/link") {
			t.Fatalf("the link got a rule: %v", rules.ReadWrite)
		}
	}
	read := "cat " + at("run/link/control/standin") + "; cat " + at("run/jr2/control/standin")
	if out, _ := confined(t, rules, at("w"), read); strings.Contains(out, "control-stand-in-value") {
		t.Fatalf("the first domain read the Stand-in: %q", out)
	}
	if out, err := confined(t, rules, at("w"), "rmdir target && ln -s "+denied+" target"); err != nil {
		t.Fatalf("the domain could not retarget the link's target: %v %q", err, out)
	}
	out, _ := confined(t, rules, at("w"), read)
	if strings.Contains(out, "control-stand-in-value") {
		t.Fatalf("after the retarget, the restarted domain read the Stand-in: %q", out)
	}
}

// A rule path with a symbolic link at any component stops the confiner (ELOOP): it never follows a
// link to find what a rule allows, and it runs nothing.
func TestTheConfinerRefusesARuleThroughALink(t *testing.T) {
	requireLandlock(t)
	l := newLayout(t)
	link := filepath.Join(l.root, "to-work")
	must(t, os.Symlink(l.work, link))
	for _, p := range []string{link, filepath.Join(link, "file")} {
		out, err := confined(t, Rules{Read: []string{p}}, l.root, "echo ran")
		if err == nil || strings.Contains(out, "ran") || !strings.Contains(out, p+": a symbolic link") {
			t.Errorf("a rule through %s: %v %q", p, err, out)
		}
	}
}

// With the signal scope (ABI 6), a confined child cannot signal a process outside its domain; below
// it, it can (ADR-0076: a denial of service, not an impersonation).
func TestTheSignalScopeHoldsWhenTheKernelOffersIt(t *testing.T) {
	requireLandlock(t)
	abi, _ := Probe()
	l := newLayout(t)
	out, err := confined(t, l.rules(t), l.effect, "kill -0 "+strconv.Itoa(os.Getpid()))
	if abi >= 6 && err == nil {
		t.Fatalf("ABI %d: the child signalled a process outside its domain: %q", abi, out)
	}
	if abi < 6 && err != nil {
		t.Fatalf("ABI %d: %v %q", abi, err, out)
	}
}

// dialAbstract is the test binary as a confined program: `dial-abstract <name>` connects to the
// abstract Unix socket <name>, or, with name "self", to one it makes itself, so in its own domain.
// It prints "connected" and exits 0, or prints the error and exits 1.
func dialAbstract(name string) int {
	if name == "self" {
		name = "@jr2-confine-self-" + strconv.Itoa(os.Getpid())
		l, err := net.Listen("unix", name)
		if err != nil {
			_, _ = os.Stdout.WriteString("listen: " + err.Error() + "\n")
			return 1
		}
		defer func() { _ = l.Close() }()
	}
	c, err := net.Dial("unix", name)
	if err != nil {
		_, _ = os.Stdout.WriteString(err.Error() + "\n")
		return 1
	}
	_ = c.Close()
	_, _ = os.Stdout.WriteString("connected\n")
	return 0
}

// With the abstract Unix socket scope (ABI 6), a confined process cannot connect to an abstract
// socket that a process outside its domain made: the Harness's and the Custodian's, in a pod whose
// containers share one network namespace. It still connects to one that its own domain made. It
// holds in the Harness's domain and in a credentialed command's (ADR-0068): the confiner is one.
func TestTheAbstractSocketScopeHoldsWhenTheKernelOffersIt(t *testing.T) {
	requireLandlock(t)
	abi, _ := Probe()
	name := "@jr2-confine-outside-" + strconv.Itoa(os.Getpid())
	l, err := net.Listen("unix", name)
	must(t, err)
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	lay := newLayout(t)
	denied := filepath.Join(lay.root, "run-jr2")
	must(t, os.Mkdir(denied, 0o700))
	harness, err := ForHarness("/", []string{denied}, nil)
	must(t, err)
	// A credentialed command's child runs the test binary only if its folder is a system path: copy
	// it into the Effect's own directory, which the child may run from.
	bin := filepath.Join(lay.effect, "confine.test")
	self, err := os.ReadFile(os.Args[0])
	must(t, err)
	must(t, os.WriteFile(bin, self, 0o700))
	for domain, rules := range map[string]Rules{"the Harness's domain": harness, "a credentialed command": lay.rules(t)} {
		out, err := confined(t, rules, lay.effect, bin+" dial-abstract self")
		if err != nil || out != "connected\n" {
			t.Errorf("%s: a socket of its own domain: %v %q", domain, err, out)
		}
		out, err = confined(t, rules, lay.effect, bin+" dial-abstract "+name)
		if abi >= 6 && (err == nil || !strings.Contains(out, "operation not permitted")) {
			t.Errorf("ABI %d, %s: the child connected to an abstract socket outside its domain: %v %q", abi, domain, err, out)
		}
		if abi < 6 && (err != nil || out != "connected\n") {
			t.Errorf("ABI %d, %s: %v %q", abi, domain, err, out)
		}
	}
	if abi < 6 {
		t.Skipf("the host offers Landlock ABI %d: the abstract Unix socket scope needs ABI 6 (Linux 6.12), so only "+
			"the connect without it was checked", abi)
	}
}

// ADR-0076: the folder where pi's `bash` keeps a long command's whole output is the Harness's own,
// in the denied path. The domain reads a file there, by its name, as the model does with `read` or
// `cat`. It writes, makes, removes, moves and links nothing there, so a command cannot put a link
// or a FIFO in the place of a file that the Harness opens by its path. A read-only path outside every
// denied path is refused: it would have every right.
func TestTheDomainReadsTheHarnessOutputFolderAndChangesNothingThere(t *testing.T) {
	requireLandlock(t)
	l := newLayout(t)
	at := func(p string) string { return filepath.Join(l.root, p) }
	for _, d := range []string{"run-jr2/output", "run-jr2/control", "w"} {
		must(t, os.MkdirAll(at(d), 0o700))
	}
	denied, output := at("run-jr2"), at("run-jr2/output")
	full := filepath.Join(output, "pi-bash-0123456789abcdef.log")
	must(t, os.WriteFile(full, []byte("the whole output\n"), 0o600))
	must(t, os.WriteFile(at("run-jr2/control/standin"), []byte("control-stand-in-value"), 0o400))
	rules, err := ForHarness("/", []string{denied}, []string{output})
	must(t, err)
	if !slices.Equal(rules.Read, []string{output}) {
		t.Fatalf("read-only %v, want the output folder alone", rules.Read)
	}
	if out, err := confined(t, rules, at("w"), "cat "+full+" && ls "+output); err != nil ||
		out != "the whole output\npi-bash-0123456789abcdef.log\n" {
		t.Fatalf("the domain could not read the output folder: %v %q", err, out)
	}
	for name, script := range map[string]string{
		"a write":              "echo x >> " + full,
		"a truncate":           ": > " + full,
		"a new file":           "echo x > " + filepath.Join(output, "new"),
		"a remove":             "rm -f " + full,
		"a rename":             "mv " + full + " " + full + ".old",
		"a link":               "ln -s /dev/zero " + filepath.Join(output, "pi-bash-link.log"),
		"a FIFO":               "mkfifo " + filepath.Join(output, "pi-bash-fifo.log"),
		"a move of the folder": "mv " + output + " " + at("w/output"),
		"a read beside it":     "cat " + at("run-jr2/control/standin"),
	} {
		if out, err := confined(t, rules, at("w"), script); err == nil {
			t.Errorf("%s in the output folder passed: %q", name, out)
		}
	}
	if got, err := os.ReadFile(full); err != nil || string(got) != "the whole output\n" {
		t.Fatalf("the file changed: %v %q", err, got)
	}
	if _, err := ForHarness("/", []string{denied}, []string{at("w")}); err == nil {
		t.Fatal("a read-only path outside every denied path was given")
	}
	if _, err := ForHarness("/", []string{denied}, []string{denied}); err == nil {
		t.Fatal("the denied path itself was given as read-only")
	}
}

// `effector harness-rules --deny <path>...` writes ForHarness's rules in confine's own format:
// Parse reads them back with a program after `--`. Every rule is read and write, none reaches the
// denied path, a `--read` folder is read-only, and any other flag, a relative path or no --deny at all is refused.
func TestHarnessRulesMainWritesConfinesFormat(t *testing.T) {
	var out, errs bytes.Buffer
	if code := HarnessRulesMain([]string{"--deny", "/run/jr2"}, &out, &errs); code != 0 {
		t.Fatalf("exit %d: %s", code, errs.String())
	}
	args := strings.Split(strings.TrimSuffix(out.String(), "\x00"), "\x00")
	rules, path, argv, err := Parse(append(args, "--", "/bin/sh", "sh"))
	if err != nil || path != "/bin/sh" || !slices.Equal(argv, []string{"sh"}) {
		t.Fatalf("%v %q %q", err, path, argv)
	}
	if len(rules.ReadExec) != 0 || len(rules.Read) != 0 || !slices.Contains(rules.ReadWrite, "/proc") ||
		!slices.Contains(rules.ReadWrite, "/tmp") || !slices.Equal(rules.ReadDir, []string{"/"}) {
		t.Fatalf("got %+v", rules)
	}
	for _, p := range rules.ReadWrite {
		if p == "/" || p == "/run" || within(p, "/run/jr2") {
			t.Fatalf("%s reaches /run/jr2: %+v", p, rules.ReadWrite)
		}
	}
	out.Reset()
	if code := HarnessRulesMain([]string{"--deny", "/run/jr2", "--read", "/run/jr2/output"}, &out, &errs); code != 0 ||
		!strings.Contains(out.String(), "--ro\x00/run/jr2/output\x00") {
		t.Fatalf("--read: exit %d: %q %s", code, out.String(), errs.String())
	}
	for _, bad := range [][]string{{"--deny", "run/jr2"}, {}, {"--rw", "/work"}, {"--deny"}, {"--deny", "/run/jr2", "--read"}} {
		errs.Reset()
		if code := HarnessRulesMain(bad, &out, &errs); code != 2 {
			t.Errorf("%q: exit %d", bad, code)
		}
	}
}

// A --read path that a link is on, at its end or above it, is refused: the caller looked at the
// path before it asked, so a link there was put in its place (ELOOP). Its own real path is ruled.
func TestHarnessRulesMainRefusesAReadThroughALink(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	must(t, err)
	agent := filepath.Join(root, "agent")
	must(t, os.MkdirAll(filepath.Join(agent, "skills"), 0o700))
	must(t, os.WriteFile(filepath.Join(agent, "auth.json"), []byte("{}"), 0o600))
	must(t, os.WriteFile(filepath.Join(agent, "AGENTS.md"), []byte("x"), 0o600))
	must(t, os.Symlink(filepath.Join(agent, "auth.json"), filepath.Join(agent, "CLAUDE.md")))
	must(t, os.Symlink(agent, filepath.Join(root, "via")))
	var out, errs bytes.Buffer
	for _, read := range []string{filepath.Join(agent, "CLAUDE.md"), filepath.Join(root, "via", "AGENTS.md")} {
		out.Reset()
		errs.Reset()
		if code := HarnessRulesMain([]string{"--deny", agent, "--read", read}, &out, &errs); code != 1 ||
			out.Len() != 0 || !strings.Contains(errs.String(), "a link is on the path") ||
			!strings.Contains(errs.String(), "too many levels of symbolic links") {
			t.Errorf("%s: exit %d, out %q, err %q", read, code, out.String(), errs.String())
		}
	}
	out.Reset()
	if code := HarnessRulesMain([]string{"--deny", agent, "--read", filepath.Join(agent, "AGENTS.md") + "/",
		"--read", filepath.Join(agent, "skills")}, &out, &errs); code != 0 ||
		!strings.Contains(out.String(), "--ro\x00"+filepath.Join(agent, "AGENTS.md")+"\x00") {
		t.Fatalf("exit %d: %q %s", code, out.String(), errs.String())
	}
	// A deny path is still resolved through a link: it names what the domain may not reach.
	out.Reset()
	if code := HarnessRulesMain([]string{"--deny", filepath.Join(root, "via")}, &out, &errs); code != 0 {
		t.Fatalf("deny through a link: exit %d: %s", code, errs.String())
	}
}

// A missing denied path is resolved through the links above it, so a link on its way is followed.
func TestRealPathFollowsALinkAboveAMissingPath(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	must(t, err)
	must(t, os.Mkdir(filepath.Join(root, "real"), 0o700))
	must(t, os.Symlink(filepath.Join(root, "real"), filepath.Join(root, "link")))
	got, err := realPath(filepath.Join(root, "link", "missing", "deeper"))
	must(t, err)
	if want := filepath.Join(root, "real", "missing", "deeper"); got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

// `effector probe` is the Harness's probe (ADR-0077): the ABI and 0, or the reason and 1.
func TestProbeMainSaysTheABIOrWhyThereIsNone(t *testing.T) {
	var out, errs bytes.Buffer
	old := SetProbe(func() (int, error) { return 3, nil })
	if code := ProbeMain(&out, &errs); code != 0 || out.String() != "landlock abi=3\n" {
		t.Fatalf("exit %d: %q %q", code, out.String(), errs.String())
	}
	SetProbe(func() (int, error) { return 0, syscall.ENOSYS })
	defer SetProbe(old)
	out.Reset()
	if code := ProbeMain(&out, &errs); code != 1 || !strings.Contains(errs.String(), "landlock: the kernel has no Landlock") {
		t.Fatalf("exit %d: %q %q", code, out.String(), errs.String())
	}
}

// ABI 3 is the minimum (ADR-0077): a kernel that offers ABI 1 or 2 is refused, with the ABI it
// offers, by the probe and by the confiner, which then runs nothing. Under ABI 2 the domain could
// truncate a file under /run/jr2.
func TestTheProbeRefusesABI1And2WithTheABIItFound(t *testing.T) {
	old := SetProbe(func() (int, error) { return 1, nil })
	defer SetProbe(old)
	for _, found := range []int{1, 2} {
		SetProbe(func() (int, error) { return found, nil })
		var out, errs bytes.Buffer
		want := "Landlock ABI " + strconv.Itoa(found)
		if code := ProbeMain(&out, &errs); code != 1 || !strings.Contains(errs.String(), want) ||
			!strings.Contains(errs.String(), "needs ABI 3 or later (Linux 6.2)") {
			t.Fatalf("ABI %d: exit %d: %q %q", found, code, out.String(), errs.String())
		}
		marker := filepath.Join(t.TempDir(), "ran")
		if err := Exec(Rules{}, "/bin/sh", []string{"sh", "-c", "touch " + marker}, nil); err == nil ||
			!strings.Contains(err.Error(), want) {
			t.Fatalf("ABI %d: got %v", found, err)
		}
		if _, err := os.Stat(marker); !os.IsNotExist(err) {
			t.Fatalf("ABI %d: the program ran", found)
		}
	}
	SetProbe(func() (int, error) { return 3, nil })
	if abi, err := Probe(); err != nil || abi != 3 {
		t.Fatalf("ABI 3: %d %v", abi, err)
	}
}
