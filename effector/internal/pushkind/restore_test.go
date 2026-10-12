package pushkind

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// The restore comparison (ADR-0067): a squash sent again on restore takes the remote's tip as its
// own only when the tip is an exact image of it — the tree, the mapped parents, the author line and
// the message, the committer name and email of jr2's squash committer, and with `sign` a signature
// that verifies against the slot's key. Dates and signature bytes are not compared. A tip with the
// same content under another committer, or with `sign` and no verifying signature, is not jr2's
// own: `rejected`, no sync bundle.

// resignRemoteTip is rewriteRemoteTip, with the edited copy then signed by the ssh key at keyFile:
// a signature over the new payload, so its bytes differ from the first one's.
func resignRemoteTip(t *testing.T, f *fixture, keyFile string, edit func(head []string) []string) {
	t.Helper()
	raw := remoteGit(t, f, "cat-file", "commit", remoteRef(f))
	head, msg, _ := strings.Cut(raw, "\n\n")
	var kept []string
	inSig := false
	for line := range strings.SplitSeq(head, "\n") {
		if strings.HasPrefix(line, "gpgsig ") || (inSig && strings.HasPrefix(line, " ")) {
			inSig = true
			continue
		}
		inSig = false
		kept = append(kept, line)
	}
	kept = edit(kept)
	payload := strings.Join(kept, "\n") + "\n\n" + msg + "\n"
	key := filepath.Join(t.TempDir(), "key")
	src, err := os.ReadFile(keyFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(key, src, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("ssh-keygen", "-q", "-Y", "sign", "-n", "git", "-f", key)
	cmd.Stdin = strings.NewReader(payload)
	sig, err := cmd.Output()
	if err != nil {
		t.Fatalf("ssh-keygen -Y sign: %v", err)
	}
	signed := strings.Join(kept, "\n") + "\ngpgsig " +
		strings.ReplaceAll(strings.TrimRight(string(sig), "\n"), "\n", "\n ") + "\n\n" + msg + "\n"
	hash := exec.Command("git", "--git-dir="+f.pod.Remote, "hash-object", "-t", "commit", "-w", "--stdin")
	hash.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	hash.Stdin = strings.NewReader(signed)
	out, err := hash.Output()
	if err != nil {
		t.Fatalf("hash-object: %v", err)
	}
	remoteGit(t, f, "update-ref", "refs/heads/"+f.pod.Branch, strings.TrimSpace(string(out)))
}

// laterCommitter moves the committer line's date one hour on (dates are not compared) and, when
// name is not "", names another committer.
func laterCommitter(name, email string) func(head []string) []string {
	return func(head []string) []string {
		for i, line := range head {
			rest, ok := strings.CutPrefix(line, "committer ")
			if !ok {
				continue
			}
			who, when, _ := strings.Cut(rest, "> ")
			who += ">"
			if name != "" {
				who = name + " <" + email + ">"
			}
			secs, zone, _ := strings.Cut(when, " ")
			n, _ := strconv.ParseInt(secs, 10, 64)
			head[i] = fmt.Sprintf("committer %s %d %s", who, n+3600, zone)
		}
		return head
	}
}

// squashFirst publishes one squash of the Agent's A and answers its start, to be sent again.
func squashFirst(t *testing.T, f *fixture, sign bool) *wire.StartRequest {
	t.Helper()
	f.pod.Commit("A", map[string]string{"a.txt": "a\n"})
	msg := "one squashed commit"
	req := f.request(sign, nil)
	req.Push.Squash = &msg
	if first := f.runner.Run(context.Background(), req); first.Outcome != wire.OutcomePushed {
		t.Fatalf("first: %+v %+v", first, first.Push)
	}
	return req
}

// assertNotOwn sends req again and expects the remote's tip refused as not jr2's own: `rejected`,
// no sync bundle, a reason that names why, the remote's branch where it was.
func assertNotOwn(t *testing.T, f *fixture, req *wire.StartRequest, why string) {
	t.Helper()
	tip := remoteRef(f)
	out := f.runner.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeRejected || out.Push == nil || out.Push.Bundle != "" {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if !strings.Contains(out.Reason, why) {
		t.Fatalf("reason %q does not say %q", out.Reason, why)
	}
	if remoteRef(f) != tip {
		t.Fatal("the remote's branch moved")
	}
}

// Another committer: the same tree, parents, author and message under a committer that is not
// jr2's squash committer is not jr2's own — unsigned, and signed with the slot's own key alike.
func TestARemoteSquashUnderAnotherCommitterIsNotThisPushsOwn(t *testing.T) {
	t.Run("unsigned", func(t *testing.T) {
		f := newFixture(t, "ssh")
		f.runner.Config.Git[0].Committer = &secrets.GitIdentity{Name: "jr2 bot", Email: "bot@jr2.test"}
		req := squashFirst(t, f, false)
		rewriteRemoteTip(t, f, laterCommitter("Someone Else", "someone@elsewhere.test"))
		assertNotOwn(t, f, req, "committer")
	})
	t.Run("signed by the slot's key", func(t *testing.T) {
		f := newFixture(t, "ssh")
		req := squashFirst(t, f, true)
		// Signed with the slot's own key, so only the committer tells it from jr2's.
		resignRemoteTip(t, f, filepath.Join(f.runner.GitRoot, "sign", secrets.SignSSHFile),
			laterCommitter("Someone Else", "someone@elsewhere.test"))
		assertNotOwn(t, f, req, "committer")
	})
}

// `sign` and no verifying signature: the tip with the same content and committer and no
// signature, or one by another key, is not jr2's own.
func TestASignedSquashWithNoVerifyingSignatureIsNotThisPushsOwn(t *testing.T) {
	t.Run("ssh, no signature", func(t *testing.T) {
		f := newFixture(t, "ssh")
		req := squashFirst(t, f, true)
		rewriteRemoteTip(t, f, func(head []string) []string { return head })
		assertNotOwn(t, f, req, "signature")
	})
	t.Run("ssh, another key", func(t *testing.T) {
		f := newFixture(t, "ssh")
		req := squashFirst(t, f, true)
		other := filepath.Join(t.TempDir(), "other")
		run(t, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", other)
		resignRemoteTip(t, f, other, func(head []string) []string { return head })
		assertNotOwn(t, f, req, "signature")
	})
	t.Run("gpg, no signature", func(t *testing.T) {
		f := newFixture(t, "gpg")
		req := squashFirst(t, f, true)
		rewriteRemoteTip(t, f, func(head []string) []string { return head })
		assertNotOwn(t, f, req, "signature")
	})
}

// `sign` with a verifying signature: the tip re-signed by the slot's key, its committer's date an
// hour later — other date, other signature bytes — is this push's own commit: `pushed`,
// `unchanged`, with the sync bundle. With GPG, the tip a first push signed is its own when sent
// again.
func TestASignedSquashWithAVerifyingSignatureIsThisPushsOwn(t *testing.T) {
	t.Run("ssh, re-signed later", func(t *testing.T) {
		f := newFixture(t, "ssh")
		req := squashFirst(t, f, true)
		resignRemoteTip(t, f, filepath.Join(f.runner.GitRoot, "sign", secrets.SignSSHFile), laterCommitter("", ""))
		tip := remoteRef(f)
		out := f.runner.Run(context.Background(), req)
		if out.Outcome != wire.OutcomePushed || !out.Push.Unchanged || out.Push.Published != tip ||
			out.Push.Bundle == "" || out.Push.Squashed != wire.SquashedSigned {
			t.Fatalf("got %+v %+v", out, out.Push)
		}
	})
	t.Run("gpg, sent again", func(t *testing.T) {
		f := newFixture(t, "gpg")
		req := squashFirst(t, f, true)
		tip := remoteRef(f)
		out := f.runner.Run(context.Background(), req)
		if out.Outcome != wire.OutcomePushed || !out.Push.Unchanged || out.Push.Published != tip ||
			out.Push.Bundle == "" || out.Push.Squashed != wire.SquashedSigned {
			t.Fatalf("got %+v %+v", out, out.Push)
		}
	})
}
