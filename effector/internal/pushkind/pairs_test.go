package pushkind

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/gittest"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// pairOf is the pair a push's ledger row holds once it settled `pushed`.
func pairOf(out wire.Output) wire.Pair {
	return wire.Pair{Published: out.Push.Published, Source: out.Push.Source, Squashed: out.Push.Squashed}
}

// syncTo moves the Agent's branch to the published commit, from the push's bundle, as the sync does.
func syncTo(t *testing.T, f *fixture, out wire.Output) {
	t.Helper()
	if out.Outcome != wire.OutcomePushed || !unbundle(t, f, out.Push.Bundle, out.Push.Published) {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	gittest.Git(t, f.pod.Tree, "reset", "-q", "--hard", out.Push.Published)
}

// mergeSide checks out branch side, commits subject on it, and merges it into the Agent's branch.
func mergeSide(t *testing.T, f *fixture, side, subject, file string) {
	t.Helper()
	tree := f.pod.Tree
	gittest.Git(t, tree, "checkout", "-q", side)
	f.pod.Commit(subject, map[string]string{file: subject + "\n"})
	gittest.Git(t, tree, "checkout", "-q", f.pod.Branch)
	gittest.Git(t, tree, "merge", "-q", "--no-ff", "-m", "merge "+side, side)
}

// subjects counts each subject the remote's branch holds after main.
func subjects(t *testing.T, f *fixture) map[string]int {
	t.Helper()
	n := map[string]int{}
	for s := range strings.SplitSeq(remoteGit(t, f, "log", "--format=%s", remoteRef(f), "--not", "main"), "\n") {
		if s != "" {
			n[s]++
		}
	}
	return n
}

// ADR-0067: the Effector sees every pair the Repo Slot's ledger holds, oldest push first. A squash
// publishes Q for the Agent's A and B, and the sync moves the branch to Q. Push 2 merges side1 (made
// at B, gains S) and publishes S′ and the merge. Push 3 merges side2 (made at S, gains T). With the
// last push's pair alone, B has no twin and is signed again, S′ is then no faithful image of S, and A,
// B and S are published a second time beside Q; with every pair, B maps to Q by push 1's pair and
// S to S′, and push 3 publishes T and its merge alone.
func TestASquashOlderThanTheLastPushStillMapsItsSource(t *testing.T) {
	f := newFixture(t, "ssh")
	clock := int64(1800000000)
	f.runner.Now = func() time.Time { clock += 60; return time.Unix(clock, 0) }
	tree := f.pod.Tree
	f.pod.Commit("A", map[string]string{"a.txt": "a\n"})
	b := f.pod.Commit("B", map[string]string{"b.txt": "b\n"})
	gittest.Git(t, tree, "branch", "side1", b)
	msg := "Q squashed"
	req := f.request(true, nil)
	req.Push.Squash = &msg
	first := f.runner.Run(context.Background(), req)
	syncTo(t, f, first)

	mergeSide(t, f, "side1", "S", "s.txt")
	s := gittest.Git(t, tree, "rev-parse", "side1")
	gittest.Git(t, tree, "branch", "side2", s)
	second := f.push(true, []wire.Pair{pairOf(first)})
	assertPushedTheAgentsTree(t, f, second, first.Push.Published, 2)
	syncTo(t, f, second)

	mergeSide(t, f, "side2", "T", "t.txt")
	third := f.push(true, []wire.Pair{pairOf(first), pairOf(second)})
	assertPushedTheAgentsTree(t, f, third, second.Push.Published, 2)
	got := subjects(t, f)
	want := map[string]int{msg: 1, "S": 1, "merge side1": 1, "T": 1, "merge side2": 1}
	if len(got) != len(want) {
		t.Fatalf("published after main: %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("published after main: %v, want %v", got, want)
		}
	}
}

// ADR-0067: when two pairs name one source, the newest wins; a pair is used only while the remote
// still holds its published commit. Two pairs name B: an old one whose published commit a forced
// push later replaced, and the newest. B maps to the newest; the old pair's commit is not the
// remote's, and nothing is published for it.
func TestTheNewestPairOfOneSourceWins(t *testing.T) {
	f := newFixture(t, "ssh")
	clock := int64(1800000000)
	f.runner.Now = func() time.Time { clock += 60; return time.Unix(clock, 0) }
	tree := f.pod.Tree
	b := f.pod.Commit("B", map[string]string{"b.txt": "b\n"})
	gittest.Git(t, tree, "branch", "side", b)
	first := f.push(true, nil)
	// The same B pushed again with force, after the remote was reset: a new signed copy B″.
	remoteGit(t, f, "update-ref", "refs/heads/"+f.pod.Branch, remoteGit(t, f, "rev-parse", "main"))
	second := f.push(true, nil)
	if second.Outcome != wire.OutcomePushed || second.Push.Published == first.Push.Published {
		t.Fatalf("second: %+v %+v", second, second.Push)
	}
	syncTo(t, f, second)
	mergeSide(t, f, "side", "S", "s.txt")
	out := f.push(true, []wire.Pair{pairOf(first), pairOf(second)})
	assertPushedTheAgentsTree(t, f, out, second.Push.Published, 2)
	if n := subjects(t, f)["B"]; n != 1 {
		t.Fatalf("the remote holds %d copies of B", n)
	}
}

// ADR-0067: when two pairs name one source and the remote holds both published commits, the newest
// pair wins. The Agent pushes B, signed, as B′, and the sync moves the branch to B′. A side branch
// made at B gains S and is merged. The start carries an older pair that names B with a commit the
// remote also holds (main's tip), then push 1's pair. B maps to B′, so S′ is published on B′; mapped
// by the older pair, S′ would be published on main's tip.
func TestTheNewestOfTwoHeldPairsOfOneSourceWins(t *testing.T) {
	f := newFixture(t, "ssh")
	tree := f.pod.Tree
	b := f.pod.Commit("B", map[string]string{"b.txt": "b\n"})
	gittest.Git(t, tree, "branch", "side", b)
	first := f.push(true, nil)
	syncTo(t, f, first)
	mergeSide(t, f, "side", "S", "s.txt")
	older := wire.Pair{Published: remoteGit(t, f, "rev-parse", "main"), Source: b}
	out := f.push(true, []wire.Pair{older, pairOf(first)})
	assertPushedTheAgentsTree(t, f, out, first.Push.Published, 2)
	s := remoteGit(t, f, "rev-parse", out.Push.Published+"^2")
	if got := remoteGit(t, f, "rev-parse", s+"^"); got != first.Push.Published {
		t.Fatalf("S′ is published on %s, not on B′ %s", short(got), short(first.Push.Published))
	}
	if n := subjects(t, f)["B"]; n != 1 {
		t.Fatalf("the remote holds %d copies of B", n)
	}
}

// ADR-0067, one mapping rule everywhere: the cherry fallback keys a merge on its MAPPED non-first
// parents, as the twin set does. The Agent merges its side branch x (X) as A before its first push;
// the push publishes X′ and A′, whose second parent is X′. The sync does not run; the Agent commits
// C; the start carries no pair. Cherry pairs X with X′, then keys A with X′ as its second parent and
// pairs it with A′, and the push publishes C alone.
func TestCherryKeysAMergeOnItsMappedParents(t *testing.T) {
	for _, sign := range []string{"ssh", "gpg"} {
		t.Run(sign, func(t *testing.T) {
			if _, err := exec.LookPath("gpg"); sign == "gpg" && err != nil {
				t.Skip("no gpg")
			}
			f := newFixture(t, sign)
			tree := f.pod.Tree
			gittest.Git(t, tree, "checkout", "-q", "-b", "x")
			f.pod.Commit("X", map[string]string{"x.txt": "x\n"})
			gittest.Git(t, tree, "checkout", "-q", f.pod.Branch)
			gittest.Git(t, tree, "merge", "-q", "--no-ff", "-m", "A merge x", "x")
			first := f.push(true, nil)
			if first.Outcome != wire.OutcomePushed {
				t.Fatalf("first: %+v %+v", first, first.Push)
			}
			f.pod.Commit("C", map[string]string{"c.txt": "c\n"})
			out := f.push(true, nil)
			if out.Outcome != wire.OutcomePushed || out.Push.Via != "cherry" {
				t.Fatalf("second: %+v %+v", out, out.Push)
			}
			assertPushedTheAgentsTree(t, f, out, first.Push.Published, 1)
			assertOneCopyOfEach(t, f, "X", "A merge x", "C")
		})
	}
}

// ADR-0067, the tree half of the faithful image. The Agent pushes A, signed, and the sync moves the
// branch to A′. A side branch made at main gains A2: A's author line, message and parent, and a
// patch that differs from A's in whitespace alone — the same stable patch-id, so A's key — but
// another tree. It is merged. A2 is no image of A′: it is signed, and the push publishes A2′ and the
// merge.
func TestACommitWithAnotherTreeIsNotMappedToATwinOfItsKey(t *testing.T) {
	f := newFixture(t, "ssh")
	tree := f.pod.Tree
	gittest.Git(t, tree, "branch", "side", "main")
	f.pod.Commit("A", map[string]string{"a.txt": "a b\n"})
	first := f.push(true, nil)
	syncTo(t, f, first)
	gittest.Git(t, tree, "checkout", "-q", "side")
	a2 := f.pod.Commit("A", map[string]string{"a.txt": "a  b\n"})
	gittest.Git(t, tree, "checkout", "-q", f.pod.Branch)
	gittest.Git(t, tree, "merge", "-q", "--no-ff", "-s", "ours", "-m", "merge side", "side")
	key := func(id string) string {
		diff := gittest.Git(t, tree, "diff-tree", "-p", "--root", id)
		cmd := exec.Command("git", "-C", tree, "patch-id", "--stable")
		cmd.Stdin = strings.NewReader(diff + "\n")
		out, err := cmd.Output()
		if err != nil || len(strings.Fields(string(out))) == 0 {
			t.Fatalf("patch-id: %v", err)
		}
		return strings.Fields(string(out))[0]
	}
	if key(a2) != key(first.Push.Published) {
		t.Fatal("the fixture's A2 does not share A's patch-id")
	}
	if gittest.Git(t, tree, "rev-parse", a2+"^{tree}") == gittest.Git(t, tree, "rev-parse", first.Push.Published+"^{tree}") {
		t.Fatal("the fixture's A2 has A's tree")
	}
	out := f.push(true, []wire.Pair{pairOf(first)})
	assertPushedTheAgentsTree(t, f, out, first.Push.Published, 2)
	if n := subjects(t, f)["A"]; n != 2 {
		t.Fatalf("the remote holds %d commits A, want 2: A′ and A2′", n)
	}
}

// ADR-0067, a named limit: the pair maps a squash's SOURCE only. A side branch made at A, an earlier
// commit of the squashed range A,B, gains S and is merged after the sync. A has no faithful twin —
// mapped to the squashed commit it would publish a false diff — so the push publishes A as a signed
// copy beside the squashed commit, then S and the merge. No commit is signed twice, and the trees
// are the Agent's.
func TestASideBranchMadeInsideASquashedRangePublishesWhatItDescendsFrom(t *testing.T) {
	f := newFixture(t, "ssh")
	clock := int64(1800000000)
	f.runner.Now = func() time.Time { clock += 60; return time.Unix(clock, 0) }
	tree := f.pod.Tree
	a := f.pod.Commit("A", map[string]string{"a.txt": "a\n"})
	f.pod.Commit("B", map[string]string{"b.txt": "b\n"})
	gittest.Git(t, tree, "branch", "side", a)
	msg := "Q squashed"
	req := f.request(true, nil)
	req.Push.Squash = &msg
	first := f.runner.Run(context.Background(), req)
	syncTo(t, f, first)
	mergeSide(t, f, "side", "S", "s.txt")
	out := f.push(true, []wire.Pair{pairOf(first)})
	assertPushedTheAgentsTree(t, f, out, first.Push.Published, 3)
	got := subjects(t, f)
	if got[msg] != 1 || got["A"] != 1 || got["S"] != 1 || got["merge side"] != 1 || got["B"] != 0 {
		t.Fatalf("published after main: %v", got)
	}
}

// ADR-0067: a squash sent again on restore is this push's own commit. The squash published Q; the
// Effector then lost the Effect, and the restore sends the same start again (the same pin, the same
// pairs: the push in flight has no settled row). The remote's tip is this squash's exact image, so
// the push settles `pushed`, `unchanged`, with the sync bundle and its own `squashed` — signed or
// unsigned. A later push of the Repo Slot, its ledger now holding the push's pair, is pushed too.
func TestASquashSentAgainOnRestoreIsThisPushsOwnCommit(t *testing.T) {
	for _, sign := range []bool{true, false} {
		name := map[bool]string{true: "signed", false: "unsigned"}[sign]
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, "ssh")
			f.runner.Config.Git[0].Committer = &secrets.GitIdentity{Name: "jr2 bot", Email: "bot@jr2.test"}
			clock := int64(1800000000)
			f.runner.Now = func() time.Time { clock += 60; return time.Unix(clock, 0) }
			f.pod.Commit("A", map[string]string{"a.txt": "a\n"})
			f.pod.Commit("B", map[string]string{"b.txt": "b\n"})
			msg := "one squashed commit"
			req := f.request(sign, nil)
			req.Push.Squash = &msg
			first := f.runner.Run(context.Background(), req)
			if first.Outcome != wire.OutcomePushed || first.Push.Unchanged {
				t.Fatalf("first: %+v %+v", first, first.Push)
			}
			again := f.runner.Run(context.Background(), req)
			if again.Outcome != wire.OutcomePushed || !again.Push.Unchanged ||
				again.Push.Published != first.Push.Published || again.Push.Source != first.Push.Source {
				t.Fatalf("sent again: %+v %+v", again, again.Push)
			}
			if again.Push.Squashed != first.Push.Squashed || again.Push.Bundle == "" {
				t.Fatalf("sent again: squashed %q (first %q), bundle %d bytes", again.Push.Squashed,
					first.Push.Squashed, len(again.Push.Bundle))
			}
			if !unbundle(t, f, again.Push.Bundle, again.Push.Published) {
				t.Fatal("the bundle does not carry the squashed commit")
			}
			// The next push of the slot: the sync did not run, the Agent commits C, and squashes again.
			c := f.pod.Commit("C", map[string]string{"c.txt": "c\n"})
			next := f.request(sign, []wire.Pair{pairOf(again)})
			next.Push.Squash = &msg
			out := f.runner.Run(context.Background(), next)
			if out.Outcome != wire.OutcomePushed || out.Push.Source != c || out.Push.Unchanged {
				t.Fatalf("next: %+v %+v", out, out.Push)
			}
			if got := remoteGit(t, f, "rev-parse", remoteRef(f)+"^"); got != first.Push.Published {
				t.Fatalf("the next squash's parent is %s, not the first squash %s", got, first.Push.Published)
			}
		})
	}
}

// ADR-0067: the restore's acceptance is a full comparison, not a pairing. A remote tip that is a
// squash of the Agent's tree with another message is no image of this push: `diverged`, nothing
// pushed.
func TestARemoteSquashWithAnotherMessageIsNotThisPushsOwn(t *testing.T) {
	f := newFixture(t, "ssh")
	f.pod.Commit("A", map[string]string{"a.txt": "a\n"})
	msg := "one squashed commit"
	req := f.request(true, nil)
	req.Push.Squash = &msg
	if first := f.runner.Run(context.Background(), req); first.Outcome != wire.OutcomePushed {
		t.Fatalf("first: %+v %+v", first, first.Push)
	}
	other := "another message"
	req.Push.Squash = &other
	out := f.runner.Run(context.Background(), req)
	if out.Outcome != wire.OutcomeDiverged {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
}

// rewriteRemoteTip replaces the remote branch's tip by a copy of it that edit changed, as another
// writer could: the raw commit object with its gpgsig header dropped, then edit, then written.
func rewriteRemoteTip(t *testing.T, f *fixture, edit func(head []string) []string) {
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
	cmd := exec.Command("git", "--git-dir="+f.pod.Remote, "hash-object", "-t", "commit", "-w", "--stdin")
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	cmd.Stdin = strings.NewReader(strings.Join(edit(kept), "\n") + "\n\n" + msg + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("hash-object: %v", err)
	}
	remoteGit(t, f, "update-ref", "refs/heads/"+f.pod.Branch, strings.TrimSpace(string(out)))
}

// ADR-0067: the restore's acceptance compares the tree, the author line and the parent as it
// compares the message. The squash published Q; the remote's tip is then a copy of Q with one of
// them changed — main's tree, another author, or no parent — and the same start is sent again. That
// tip is no image of this push: `diverged`, nothing pushed, no sync bundle.
func TestARemoteSquashWithAnotherTreeAuthorOrParentIsNotThisPushsOwn(t *testing.T) {
	cases := map[string]func(f *fixture) func(head []string) []string{
		"tree": func(f *fixture) func([]string) []string {
			other := remoteGit(t, f, "rev-parse", "main^{tree}")
			return func(head []string) []string {
				return replaceLine(head, "tree ", "tree "+other)
			}
		},
		"author": func(*fixture) func([]string) []string {
			return func(head []string) []string {
				for i, line := range head {
					if rest, ok := strings.CutPrefix(line, "author "); ok {
						_, when, _ := strings.Cut(rest, "> ")
						head[i] = "author Someone Else <someone@elsewhere.test> " + when
					}
				}
				return head
			}
		},
		"parent": func(*fixture) func([]string) []string {
			return func(head []string) []string { return replaceLine(head, "parent ", "") }
		},
	}
	for name, edit := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, "ssh")
			f.pod.Commit("A", map[string]string{"a.txt": "a\n"})
			msg := "one squashed commit"
			req := f.request(true, nil)
			req.Push.Squash = &msg
			if first := f.runner.Run(context.Background(), req); first.Outcome != wire.OutcomePushed {
				t.Fatalf("first: %+v %+v", first, first.Push)
			}
			rewriteRemoteTip(t, f, edit(f))
			tip := remoteRef(f)
			out := f.runner.Run(context.Background(), req)
			if out.Outcome != wire.OutcomeDiverged || (out.Push != nil && out.Push.Bundle != "") {
				t.Fatalf("got %+v %+v", out, out.Push)
			}
			if remoteRef(f) != tip {
				t.Fatal("the remote's branch moved")
			}
		})
	}
}

// replaceLine replaces each header line that starts with prefix by with; an empty with drops it.
func replaceLine(head []string, prefix, with string) []string {
	var out []string
	for _, line := range head {
		switch {
		case !strings.HasPrefix(line, prefix):
			out = append(out, line)
		case with != "":
			out = append(out, with)
		}
	}
	return out
}
