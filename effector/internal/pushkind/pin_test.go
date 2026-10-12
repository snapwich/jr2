package pushkind

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/snapwich/jr2/effector/internal/gittest"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// unbundle reads a sync bundle into the Agent's repository, as the Harness's sync does, and
// answers whether the published commit is then in the Agent's store.
func unbundle(t *testing.T, f *fixture, bundle, published string) bool {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(bundle)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(f.pod.Root, "sync.bundle")
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	gittest.Git(t, f.pod.Tree, "bundle", "verify", "-q", file)
	gittest.Git(t, f.pod.Tree, "bundle", "unbundle", file)
	return exec.Command("git", "-C", f.pod.Tree, "cat-file", "-e", published+"^{commit}").Run() == nil
}

// ADR-0067: jr2 runs a sync that did not finish again before the next push. A push that
// publishes nothing new because the pair or cherry maps the published tip still leaves the Agent's
// branch on its unsigned commit, so its answer carries the bundle the sync moves the branch from.
func TestASignedPushThatPublishesNothingNewStillCarriesTheSyncBundle(t *testing.T) {
	for _, mode := range []string{"pair", "cherry"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t, "ssh")
			f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
			first := f.push(true, nil)
			if first.Outcome != wire.OutcomePushed {
				t.Fatalf("first: %+v", first)
			}
			var last *wire.Pair
			if mode == "pair" {
				last = &wire.Pair{Published: first.Push.Published, Source: first.Push.Source}
			}
			again := f.push(true, last)
			if again.Outcome != wire.OutcomePushed || !again.Push.Unchanged || again.Push.Via != mode ||
				again.Push.Published != first.Push.Published || again.Push.Source != first.Push.Source {
				t.Fatalf("got %+v %+v", again, again.Push)
			}
			if again.Push.Bundle == "" {
				t.Fatal("no sync bundle: the Agent's branch stays on its unsigned commit and no sync can move it")
			}
			if !unbundle(t, f, again.Push.Bundle, again.Push.Published) {
				t.Fatal("the bundle does not carry the published commit")
			}
		})
	}
}

// ADR-0067: `squash` takes a message from the Machine. The Agent's commits become one
// signed commit on the published base, with the Agent's tree and author and the Machine's message.
func TestASquashedSignedPushPublishesOneSignedCommitWithTheMachinesMessage(t *testing.T) {
	f := newFixture(t, "ssh")
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	sha := f.pod.Commit("two", map[string]string{"b.txt": "b\n"})
	req := f.request(true, nil)
	msg := "one squashed commit"
	req.Push.Squash = &msg
	out := f.runner.Run(context.Background(), req)
	if out.Outcome != wire.OutcomePushed || out.Push.Source != sha || out.Push.Published == sha {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	pub := remoteRef(f)
	if n := remoteGit(t, f, "rev-list", "--count", pub, "--not", "main"); n != "1" {
		t.Fatalf("%s commits published, want 1", n)
	}
	if got := remoteGit(t, f, "log", "-1", "--format=%s|%an <%ae>|%cn <%ce>", pub); got !=
		msg+"|Agent <agent@example.test>|"+signerName+" <"+signerEmail+">" {
		t.Fatalf("the squashed commit: %s", got)
	}
	if remoteGit(t, f, "rev-parse", pub+"^") != remoteGit(t, f, "rev-parse", "main") {
		t.Fatal("the squashed commit's parent is not the published base")
	}
	if remoteGit(t, f, "rev-parse", pub+"^{tree}") != gittest.Git(t, f.pod.Tree, "rev-parse", sha+"^{tree}") {
		t.Fatal("the squashed tree is not the Agent's")
	}
	verify(t, f, pub)
	if out.Push.Bundle == "" || !unbundle(t, f, out.Push.Bundle, pub) {
		t.Fatal("no sync bundle of the squashed commit")
	}
	if out.Push.Squashed != wire.SquashedSigned {
		t.Fatalf("squashed %q, want %q", out.Push.Squashed, wire.SquashedSigned)
	}
}

// ADR-0067: `pin` pushes exactly the commit a Gate approved — one older than the Agent's tip
// included; what the Agent committed after it does not leave.
func TestAPinnedPushPublishesTheApprovedCommitAndNothingAfterIt(t *testing.T) {
	f := newFixture(t, "")
	approved := f.pod.Commit("approved", map[string]string{"a.txt": "a\n"})
	f.pod.Commit("after the approval", map[string]string{"b.txt": "b\n"})
	req := f.request(false, nil)
	req.Push.Pin = approved
	out := f.runner.Run(context.Background(), req)
	if out.Outcome != wire.OutcomePushed || out.Push.Published != approved || out.Push.Source != approved {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != approved {
		t.Fatalf("the remote holds %q, want the approved %q", remoteRef(f), approved)
	}
}

// ADR-0067: the Agent can deny a pinned push (it prunes the commit), and jr2 never
// substitutes another.
func TestAPinnedPushOfACommitTheAgentPrunedIsRejectedAndNothingIsPushed(t *testing.T) {
	f := newFixture(t, "")
	f.pod.Commit("kept", map[string]string{"a.txt": "a\n"})
	approved := f.pod.Commit("approved", map[string]string{"b.txt": "b\n"})
	gittest.Git(t, f.pod.Tree, "reset", "-q", "--hard", "HEAD~1")
	gittest.Git(t, f.pod.Tree, "reflog", "expire", "--expire=now", "--all")
	gittest.Git(t, f.pod.Tree, "gc", "-q", "--prune=now")
	if exec.Command("git", "-C", f.pod.Tree, "cat-file", "-e", approved).Run() == nil {
		t.Fatal("setup: the approved commit is still in the Agent's store")
	}
	req := f.request(false, nil)
	req.Push.Pin = approved
	out := f.runner.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeRejected || out.Push.Stage != "import" ||
		!strings.Contains(out.Reason, "not in the Agent's") {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != "" {
		t.Fatalf("the remote holds %q: the pruned commit was substituted", remoteRef(f))
	}
}

// The pair is the ledger's LAST push: it stands for the remote's tip only while the remote still
// holds that push. When the remote moved past it (another writer), the Agent's commits are not
// grafted onto the new tip — that would publish a fast-forward that reverts the other commit.
func TestAPairWhoseRemoteMovedPastTheLastPushIsDiverged(t *testing.T) {
	f := newFixture(t, "ssh")
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	first := f.push(true, nil)
	if first.Outcome != wire.OutcomePushed {
		t.Fatalf("first: %+v", first)
	}
	// Another writer pushes on top of the signed copy.
	tree := remoteGit(t, f, "rev-parse", first.Push.Published+"^{tree}")
	other := gittest.Git(t, f.pod.Root, "--git-dir="+f.pod.Remote, "commit-tree", tree, "-p", first.Push.Published, "-m", "another writer")
	remoteGit(t, f, "update-ref", "refs/heads/"+f.pod.Branch, other)
	// The sync did not run; the Agent adds a commit on its unsigned one.
	f.pod.Commit("two", map[string]string{"b.txt": "b\n"})
	out := f.push(true, &wire.Pair{Published: first.Push.Published, Source: first.Push.Source})
	if out.Outcome != wire.OutcomeDiverged {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	if remoteRef(f) != other {
		t.Fatal("the remote moved: the other writer's commit was built over")
	}
}

// ADR-0067: an unsigned squash has a committer of its own. Without `sign`, the squashed commit is made
// with the entry's `committer` and the Effector's clock, unsigned; the author and its date stay
// the Agent's, the message is the Machine's. An entry with no committer is a defect jr2 up refuses.
func TestAnUnsignedSquashIsCommittedByTheEntrysCommitter(t *testing.T) {
	f := newFixture(t, "")
	f.runner.Config.Git[0].Committer = &secrets.GitIdentity{Name: "jr2 bot", Email: "bot@jr2.test"}
	f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
	sha := f.pod.Commit("two", map[string]string{"b.txt": "b\n"})
	req := f.request(false, nil)
	msg := "one squashed commit"
	req.Push.Squash = &msg
	if err := req.Validate(); err != nil {
		t.Fatalf("an unsigned squash is a valid start: %v", err)
	}
	if m := f.runner.Check(req); m != "" {
		t.Fatalf("got %q", m)
	}
	out := f.runner.Run(context.Background(), req)
	if out.Outcome != wire.OutcomePushed || out.Push.Source != sha || out.Push.Published == sha {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	pub := remoteRef(f)
	if n := remoteGit(t, f, "rev-list", "--count", pub, "--not", "main"); n != "1" {
		t.Fatalf("%s commits published, want 1", n)
	}
	if got := remoteGit(t, f, "log", "-1", "--format=%s|%an <%ae> %at|%cn <%ce> %ct", pub); got !=
		msg+"|Agent <agent@example.test> 1700000000|jr2 bot <bot@jr2.test> 1800000000" {
		t.Fatalf("the squashed commit: %s", got)
	}
	if raw := remoteGit(t, f, "cat-file", "commit", pub); strings.Contains(raw, "gpgsig") {
		t.Fatalf("an unsigned squash carries a signature: %s", raw)
	}
	// Its published commit is not the Agent's own, so it is synced as a signed push is (ADR-0067):
	// it carries the bundle, and says what it published — one squashed commit, unsigned.
	if out.Push.Bundle == "" || out.Push.Squashed != wire.SquashedUnsigned {
		t.Fatalf("an unsigned squash: bundle %d bytes, squashed %q", len(out.Push.Bundle), out.Push.Squashed)
	}
	// The sync did not finish, so the Agent's branch stays on its own commits: the next squash
	// pairs the published commit from the ledger's last push and squashes only what is new onto it.
	more := f.pod.Commit("three", map[string]string{"c.txt": "c\n"})
	next := f.request(false, &wire.Pair{Published: pub, Source: sha})
	next.Push.Squash = &msg
	out = f.runner.Run(context.Background(), next)
	if out.Outcome != wire.OutcomePushed || out.Push.Via != "pair" || out.Push.Source != more {
		t.Fatalf("the next squash: %+v %+v", out, out.Push)
	}
	if got := remoteGit(t, f, "rev-parse", remoteRef(f)+"^"); got != pub {
		t.Fatalf("the next squash's parent is %s, not the published %s", got, pub)
	}
	if remoteGit(t, f, "rev-parse", pub+"^{tree}") != gittest.Git(t, f.pod.Tree, "rev-parse", sha+"^{tree}") {
		t.Fatal("the squashed tree is not the Agent's")
	}
	// This sync runs: the branch moves to the squashed commit. A plain push after it is a fast-forward.
	squashed := remoteRef(f)
	if !unbundle(t, f, out.Push.Bundle, squashed) {
		t.Fatal("the bundle does not carry the squashed commit")
	}
	gittest.Git(t, f.pod.Tree, "reset", "-q", "--hard", squashed)
	four := f.pod.Commit("four", map[string]string{"d.txt": "d\n"})
	plain := f.runner.Run(context.Background(), f.request(false, &wire.Pair{Published: squashed, Source: more}))
	if plain.Outcome != wire.OutcomePushed || plain.Push.Published != four || plain.Push.Squashed != "" {
		t.Fatalf("a plain push after a synced unsigned squash: %+v %+v", plain, plain.Push)
	}
	if remoteGit(t, f, "rev-parse", remoteRef(f)+"^{tree}") != gittest.Git(t, f.pod.Tree, "rev-parse", four+"^{tree}") {
		t.Fatal("the remote's tree is not the Agent's")
	}

	f.runner.Config.Git[0].Committer = nil
	if m := f.runner.Check(req); !strings.Contains(m, "holds no committer") {
		t.Fatalf("got %q", m)
	}
	// An entry with a sign field and no committer: its signer's identity commits the unsigned squash.
	f.runner.Config.Git[0].Sign = &secrets.GitSign{SSHKey: "sign", Name: signerName, Email: signerEmail}
	if m := f.runner.Check(req); m != "" {
		t.Fatalf("got %q", m)
	}
}

// ADR-0067: `squashed` says what the published commit is, not what this push's options ask for.
// A push that publishes nothing new maps the published tip, which an earlier push of the Repo Slot
// made, maybe with other options: the ledger's last push carries its own `squashed` beside its
// pair, and the output names that. Two such cases: an unsigned squash whose sync did not finish,
// then a signed push of the same tip — the published commit is an unsigned squash, never "signed
// copies"; and signed copies whose sync did not finish, then a squash of the same tip — the
// published commits are signed copies, never "one squashed commit". A squash this push makes is
// named by its own options.
func TestAPushThatMapsAnEarlierPushsCommitNamesWhatThatPushPublished(t *testing.T) {
	msg := "one squashed commit"
	t.Run("an unsigned squash, then a signed push", func(t *testing.T) {
		f := newFixture(t, "ssh")
		f.runner.Config.Git[0].Committer = &secrets.GitIdentity{Name: "jr2 bot", Email: "bot@jr2.test"}
		f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
		f.pod.Commit("two", map[string]string{"b.txt": "b\n"})
		req := f.request(false, nil)
		req.Push.Squash = &msg
		first := f.runner.Run(context.Background(), req)
		if first.Outcome != wire.OutcomePushed || first.Push.Squashed != wire.SquashedUnsigned {
			t.Fatalf("first: %+v %+v", first, first.Push)
		}
		again := f.push(true, &wire.Pair{Published: first.Push.Published, Source: first.Push.Source,
			Squashed: first.Push.Squashed})
		if again.Outcome != wire.OutcomePushed || again.Push.Published != first.Push.Published || !again.Push.Unchanged {
			t.Fatalf("again: %+v %+v", again, again.Push)
		}
		if again.Push.Squashed != wire.SquashedUnsigned {
			t.Fatalf("the published commit is an unsigned squash, and the output says squashed %q", again.Push.Squashed)
		}
		if again.Push.Bundle == "" {
			t.Fatal("no sync bundle")
		}
	})
	t.Run("signed copies, then a squash", func(t *testing.T) {
		f := newFixture(t, "ssh")
		f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
		f.pod.Commit("two", map[string]string{"b.txt": "b\n"})
		first := f.push(true, nil)
		if first.Outcome != wire.OutcomePushed || first.Push.Squashed != "" {
			t.Fatalf("first: %+v %+v", first, first.Push)
		}
		req := f.request(true, &wire.Pair{Published: first.Push.Published, Source: first.Push.Source})
		req.Push.Squash = &msg
		again := f.runner.Run(context.Background(), req)
		if again.Outcome != wire.OutcomePushed || again.Push.Published != first.Push.Published || !again.Push.Unchanged {
			t.Fatalf("again: %+v %+v", again, again.Push)
		}
		if again.Push.Squashed != "" {
			t.Fatalf("the published commits are signed copies, and the output says squashed %q", again.Push.Squashed)
		}
	})
	t.Run("a squash this push makes", func(t *testing.T) {
		f := newFixture(t, "ssh")
		f.pod.Commit("one", map[string]string{"a.txt": "a\n"})
		first := f.push(true, nil)
		if first.Outcome != wire.OutcomePushed {
			t.Fatalf("first: %+v %+v", first, first.Push)
		}
		f.pod.Commit("two", map[string]string{"b.txt": "b\n"})
		req := f.request(true, &wire.Pair{Published: first.Push.Published, Source: first.Push.Source})
		req.Push.Squash = &msg
		out := f.runner.Run(context.Background(), req)
		if out.Outcome != wire.OutcomePushed || out.Push.Unchanged || out.Push.Squashed != wire.SquashedSigned {
			t.Fatalf("got %+v %+v", out, out.Push)
		}
	})
}
