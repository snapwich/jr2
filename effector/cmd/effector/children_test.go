package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/gittest"
)

// One child cannot reach another (ADR-0068), with real processes: the Effector is its
// children's subreaper and ends every process an Effect started before the Effect settles; a
// child's TMPDIR is its own; and a GPG-signing push and a credentialed command are never live in
// one Sandbox Effector at once.

func commandStart(script string) string {
	return `{"kind":"command","command":{"repo":{"gitDir":"app/default/.git","worktree":"app/work",` +
		`"cache":"app-key"},"branch":"work","argv":["sh","` + script + `"],"env":{"AWS":{"secret":"aws"}},` +
		`"tail":4000},"timeoutMs":30000}`
}

func signedPushStart(p *gittest.Pod, timeoutMs int) string {
	return fmt.Sprintf(`{"kind":"push","push":{"repo":{"gitDir":"app/default/.git","worktree":"app/work",`+
		`"cache":"app-key"},"url":%q,"branch":"work","sign":true},"timeoutMs":%d}`, p.Remote, timeoutMs)
}

func alive(pid int) bool {
	if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
		return false
	}
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	s := string(raw)
	fields := strings.Fields(s[strings.LastIndexByte(s, ')')+1:])
	return len(fields) > 0 && fields[0] != "Z"
}

// ADR-0068 rule 1: a descendant of a credentialed command's child that leaves its group with setsid is
// dead once the Effect has settled.
func TestASetsidEscapeeOfACredentialedCommandIsDeadOnceItSettles(t *testing.T) {
	requireTool(t, "setsid")
	p := gittest.NewPod(t, "work")
	p.Commit("an escape", map[string]string{
		"escape.sh": "setsid sleep 300 </dev/null >/dev/null 2>&1 &\necho \"escapee=$!\"\n",
	})
	e, out := startSandboxEffectorWith(t, p, true)
	if e == nil {
		t.Fatalf("the effector never served: %s", out)
	}
	got := e.run(t, "escape-1", commandStart("escape.sh"))
	m := regexp.MustCompile(`escapee=(\d+)`).FindStringSubmatch(got)
	if m == nil || !strings.Contains(got, `"code":0`) {
		t.Fatalf("got %s", got)
	}
	pid, _ := strconv.Atoi(m[1])
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	if alive(pid) {
		t.Fatalf("the setsid escapee %d outlived its settled Effect", pid)
	}
}

// commandStartWithin is commandStart with its own timeout.
func commandStartWithin(script string, timeoutMs int) string {
	return strings.Replace(commandStart(script), `"timeoutMs":30000`, fmt.Sprintf(`"timeoutMs":%d`, timeoutMs), 1)
}

// escapee reads the pid a script printed as `escapee=<pid>`.
func escapee(t *testing.T, got string) int {
	t.Helper()
	m := regexp.MustCompile(`escapee=(\d+)`).FindStringSubmatch(got)
	if m == nil {
		t.Fatalf("got %s", got)
	}
	pid, _ := strconv.Atoi(m[1])
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	return pid
}

// ADR-0068 rule 1, and the outcome a command's own end gives: an escapee that keeps the command's
// output open neither holds the Effect past its top process's end nor outlives it.
func TestAnEscapeeThatHoldsTheOutputOpenEndsWithItsCommand(t *testing.T) {
	requireTool(t, "setsid")
	p := gittest.NewPod(t, "work")
	p.Commit("an escape", map[string]string{"escape.sh": "setsid sleep 25 &\necho \"escapee=$!\"\n"})
	e, out := startSandboxEffectorWith(t, p, true)
	if e == nil {
		t.Fatalf("the effector never served: %s", out)
	}
	started := time.Now()
	got := e.run(t, "hold-1", commandStartWithin("escape.sh", 20000))
	if d := time.Since(started); d > 10*time.Second {
		t.Fatalf("a command whose top process ends at once settled after %s: %s", d, got)
	}
	if !strings.Contains(got, `"outcome":"exited"`) || !strings.Contains(got, `"code":0`) {
		t.Fatalf("got %s", got)
	}
	if pid := escapee(t, got); alive(pid) {
		t.Fatalf("the escapee %d outlived its settled Effect", pid)
	}
}

// The timeout bounds a credentialed command whose escapee keeps its output open: the Effect
// settles `timeout` near its timeout, and the escapee is dead once it has.
func TestATimeoutBoundsACommandWhoseEscapeeHoldsTheOutputOpen(t *testing.T) {
	requireTool(t, "setsid")
	p := gittest.NewPod(t, "work")
	p.Commit("an escape", map[string]string{"escape.sh": "setsid sleep 300 &\necho \"escapee=$!\"\nexec sleep 300\n"})
	e, out := startSandboxEffectorWith(t, p, true)
	if e == nil {
		t.Fatalf("the effector never served: %s", out)
	}
	started := time.Now()
	got := e.run(t, "hold-2", commandStartWithin("escape.sh", 2000))
	if d := time.Since(started); d > 10*time.Second {
		t.Fatalf("a command whose timeout is 2 s settled after %s: %s", d, got)
	}
	if !strings.Contains(got, `"outcome":"timeout"`) {
		t.Fatalf("got %s", got)
	}
	if pid := escapee(t, got); alive(pid) {
		t.Fatalf("the escapee %d outlived its settled Effect", pid)
	}
}

// ADR-0068 rule 1, "belong to no live Effect": a daemon a LIVE credentialed command starts — it leaves
// the command's process group, and its parent ends — outlives the settle of another Effect beside
// it, and is dead once its own Effect has settled.
func TestAnotherEffectsSettleLeavesALiveCommandsDaemon(t *testing.T) {
	requireTool(t, "setsid")
	p := gittest.NewPod(t, "work")
	p.Commit("a daemon", map[string]string{
		"daemon.sh": "( setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! > \"$TMPDIR/d\" )\n" +
			"echo \"escapee=$(cat \"$TMPDIR/d\")\"\nsleep 4\n" +
			"kill -0 \"$(cat \"$TMPDIR/d\")\" && echo daemon-alive || echo daemon-dead\n",
		"quick.sh": "echo quick\n",
	})
	e, out := startSandboxEffectorWith(t, p, true)
	if e == nil {
		t.Fatalf("the effector never served: %s", out)
	}
	done := make(chan string, 1)
	go func() { done <- e.run(t, "daemon-1", commandStart("daemon.sh")) }()
	time.Sleep(time.Second)
	if quick := e.run(t, "quick-1", commandStart("quick.sh")); !strings.Contains(quick, `"code":0`) {
		t.Fatalf("got %s", quick)
	}
	got := <-done
	if !strings.Contains(got, "daemon-alive") {
		t.Fatalf("another Effect's settle killed a live command's daemon: %s", got)
	}
	if pid := escapee(t, got); alive(pid) {
		t.Fatalf("the daemon %d outlived its own settled Effect", pid)
	}
}

// ADR-0068 rule 3: each child's TMPDIR is its own, in its Effect's scratch, and goes with it; /tmp is
// out of the ruleset, so a write there fails and the next child reads nothing the last one left.
func TestAChildsTmpdirIsItsOwnAndTheNextChildCannotReadIt(t *testing.T) {
	p := gittest.NewPod(t, "work")
	p.Commit("two scripts", map[string]string{
		"write.sh": "echo \"$AWS\" > \"$TMPDIR/left\" && echo \"tmpdir=$TMPDIR\"\n" +
			"echo x > /tmp/jr2-left-$$ 2>/dev/null && echo tmp-written || echo tmp-refused\n",
		"read.sh": "cat \"$1\" 2>&1 || true\necho \"tmpdir=$TMPDIR\"\n",
	})
	e, out := startSandboxEffectorWith(t, p, true)
	if e == nil {
		t.Fatalf("the effector never served: %s", out)
	}
	first := e.run(t, "tmp-1", commandStart("write.sh"))
	m := regexp.MustCompile(`tmpdir=([^\\"]+)`).FindStringSubmatch(first)
	if m == nil || !strings.Contains(first, "tmp-refused") {
		t.Fatalf("got %s", first)
	}
	left := m[1] + "/left"
	body := strings.Replace(commandStart("read.sh"), `"argv":["sh","read.sh"]`,
		`"argv":["sh","read.sh","`+left+`"]`, 1)
	second := e.run(t, "tmp-2", body)
	if strings.Contains(second, "[secret:aws]") || strings.Contains(second, awsSecret) {
		t.Fatalf("the next child read what the last one left: %s", second)
	}
	if strings.Contains(second, "tmpdir="+m[1]+`\n`) {
		t.Fatalf("two children share one TMPDIR: %s", second)
	}
	if _, err := os.Stat(left); !os.IsNotExist(err) {
		t.Fatal("the child's TMPDIR outlived its Effect")
	}
}

// gpgKey makes an armored GPG secret key with no passphrase.
func gpgKey(t *testing.T) string {
	t.Helper()
	requireTool(t, "gpg")
	requireTool(t, "gpg-agent")
	// The agents this test starts — this key's, and each signing push's — leave no socket directory.
	gittest.SweepSocketDirs(t)
	home, err := os.MkdirTemp("", "g")
	must(t, err)
	t.Cleanup(func() {
		gittest.RemoveSocketDir(home)
		_ = os.RemoveAll(home)
	})
	gen := exec.Command("gpg", "--batch", "--homedir", home, "--pinentry-mode", "loopback", "--passphrase", "",
		"--quick-gen-key", "jr2 signer <signer@jr2.test>", "ed25519", "sign", "never")
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	out, err := exec.Command("gpg", "--batch", "--homedir", home, "--pinentry-mode", "loopback", "--passphrase", "",
		"--armor", "--export-secret-keys", "signer@jr2.test").Output()
	must(t, err)
	return string(out)
}

func requireTool(t *testing.T, name string) {
	t.Helper()
	if _, err := exec.LookPath(name); err != nil {
		t.Skipf("no %s on this host", name)
	}
}

// overlap samples the host's processes while a run goes on, and records whether a gpg-agent of
// the Effector's scratch and a child of the named script were ever alive at one time. Both are
// matched to this Effector's scratch — the agent by its homedir in its argv, the child by its
// working directory, the command's tree in its Effect's scratch — so another Effector on the host
// (a second copy of the suite) is never sampled as either.
type overlap struct {
	mu                 sync.Mutex
	agent, child, both bool
	stop               chan struct{}
	done               chan struct{}
}

func watch(scratch, script string) *overlap {
	o := &overlap{stop: make(chan struct{}), done: make(chan struct{})}
	go func() {
		defer close(o.done)
		for {
			select {
			case <-o.stop:
				return
			default:
			}
			agent, child := false, false
			entries, _ := os.ReadDir("/proc")
			for _, e := range entries {
				if _, err := strconv.Atoi(e.Name()); err != nil {
					continue
				}
				raw, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
				if err != nil {
					continue
				}
				cmdline := strings.ReplaceAll(string(raw), "\x00", " ")
				if strings.Contains(cmdline, "gpg-agent") && strings.Contains(cmdline, scratch) {
					agent = true
				}
				if strings.HasPrefix(cmdline, "sh "+script) && ofScratch(e.Name(), scratch) {
					child = true
				}
			}
			o.mu.Lock()
			o.agent = o.agent || agent
			o.child = o.child || child
			o.both = o.both || (agent && child)
			o.mu.Unlock()
			time.Sleep(2 * time.Millisecond)
		}
	}()
	return o
}

// ofScratch says whether the process's working directory is under the scratch.
func ofScratch(pid, scratch string) bool {
	cwd, err := os.Readlink(filepath.Join("/proc", pid, "cwd"))
	return err == nil && strings.HasPrefix(cwd, scratch+string(filepath.Separator))
}

func (o *overlap) end() (agent, child, both bool) {
	close(o.stop)
	<-o.done
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.agent, o.child, o.both
}

// startSigning is a Sandbox Effector whose entry signs with GPG and whose Workspace holds a
// credentialed command, and the scratch its Effects run in.
func startSigning(t *testing.T, p *gittest.Pod) (*effector, string) {
	t.Helper()
	e, out := startSandboxEffectorSigning(t, p, true, gpgKey(t))
	if e == nil {
		t.Fatalf("the effector never served: %s", out)
	}
	return e, filepath.Join(filepath.Dir(filepath.Dir(e.keyFile)), "scratch")
}

// ADR-0068 rule 2: a credentialed command started while a GPG-signing push runs waits for the push —
// its agent killed and gone — and both complete; no sample sees the agent and the child at once.
func TestACommandStartedDuringAGPGPushRunsOnlyAfterTheAgentIsGone(t *testing.T) {
	p := gittest.NewPod(t, "work")
	p.Commit("a slow script", map[string]string{"slow.sh": "sleep 0.3; echo ran\n"})
	e, scratch := startSigning(t, p)
	o := watch(scratch, "slow.sh")
	if status, raw := e.call(t, "POST", "/effects/push-1", signedPushStart(p, 30000)); status != 202 {
		t.Fatalf("got %d %s", status, raw)
	}
	if status, raw := e.call(t, "POST", "/effects/cmd-1", commandStart("slow.sh")); status != 202 {
		t.Fatalf("got %d %s", status, raw)
	}
	pushed := e.wait(t, "push-1")
	ran := e.wait(t, "cmd-1")
	agent, child, both := o.end()
	if !strings.Contains(pushed, `"outcome":"pushed"`) || !strings.Contains(ran, `"code":0`) {
		t.Fatalf("got %s and %s", pushed, ran)
	}
	if !agent || !child {
		t.Fatalf("the sampler saw agent=%v child=%v; it cannot tell whether they overlapped", agent, child)
	}
	if both {
		t.Fatal("a credentialed command's child ran while a GPG-signing push's agent was alive")
	}
}

// …and the reverse: a GPG-signing push started while a credentialed command runs starts its agent
// only after the command's child and every process it left are gone.
func TestAGPGPushStartedDuringACommandStartsItsAgentOnlyAfterTheCommand(t *testing.T) {
	p := gittest.NewPod(t, "work")
	p.Commit("a slow script", map[string]string{"slow.sh": "sleep 0.5; echo ran\n"})
	e, scratch := startSigning(t, p)
	o := watch(scratch, "slow.sh")
	if status, raw := e.call(t, "POST", "/effects/cmd-1", commandStart("slow.sh")); status != 202 {
		t.Fatalf("got %d %s", status, raw)
	}
	// Once the child runs, the push starts.
	deadline := time.Now().Add(10 * time.Second)
	for {
		o.mu.Lock()
		seen := o.child
		o.mu.Unlock()
		if seen || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if status, raw := e.call(t, "POST", "/effects/push-1", signedPushStart(p, 30000)); status != 202 {
		t.Fatalf("got %d %s", status, raw)
	}
	ran := e.wait(t, "cmd-1")
	pushed := e.wait(t, "push-1")
	agent, child, both := o.end()
	if !strings.Contains(pushed, `"outcome":"pushed"`) || !strings.Contains(ran, `"code":0`) {
		t.Fatalf("got %s and %s", pushed, ran)
	}
	if !agent || !child {
		t.Fatalf("the sampler saw agent=%v child=%v; it cannot tell whether they overlapped", agent, child)
	}
	if both {
		t.Fatal("a GPG-signing push's agent ran while a credentialed command's child was alive")
	}
}

// A waiter has its Effect's own timeout: a GPG-signing push that waits past it for a command
// settles as a timed-out push and never runs late.
func TestAWaiterPastItsTimeoutSettlesTimedOutAndNeverRunsLate(t *testing.T) {
	p := gittest.NewPod(t, "work")
	p.Commit("a slow script", map[string]string{"slow.sh": "sleep 1.5; echo ran\n"})
	e, _ := startSigning(t, p)
	if status, raw := e.call(t, "POST", "/effects/cmd-1", commandStart("slow.sh")); status != 202 {
		t.Fatalf("got %d %s", status, raw)
	}
	time.Sleep(200 * time.Millisecond)
	if status, raw := e.call(t, "POST", "/effects/push-1", signedPushStart(p, 400)); status != 202 {
		t.Fatalf("got %d %s", status, raw)
	}
	pushed := e.wait(t, "push-1")
	if !strings.Contains(pushed, `"outcome":"rejected"`) ||
		!strings.Contains(pushed, "the timeout passed while it waited for the credentialed commands") {
		t.Fatalf("got %s", pushed)
	}
	if ran := e.wait(t, "cmd-1"); !strings.Contains(ran, `"code":0`) {
		t.Fatalf("got %s", ran)
	}
	time.Sleep(300 * time.Millisecond)
	if tip := p.RemoteTip("refs/heads/work"); tip != "" {
		t.Fatalf("the timed-out push ran late: the remote holds %s", tip)
	}
}
