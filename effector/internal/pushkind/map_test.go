package pushkind

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/gittest"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// ADR-0067, map before you sign: the pair and cherry map runs on every push, before signing, so a
// commit that pairs with a published one is replaced by its signed twin and never signed again.
// The Agent commits B and makes a side branch at it; the push publishes B′ and the sync moves the
// branch to B′; the side branch gains S and is merged. By ancestry B is "new" again (B′ is not B),
// yet the next push publishes B′'s one signed copy and signs only S and the merge — for ssh and
// GPG, with the committer date from a clock that moves, so a second signature of B would differ.
func TestAPublishedCommitIsNeverSignedTwice(t *testing.T) {
	for _, sign := range []string{"ssh", "gpg"} {
		for _, mode := range []string{"pair", "cherry"} {
			t.Run(sign+"/"+mode, func(t *testing.T) {
				if _, err := exec.LookPath("gpg"); sign == "gpg" && err != nil {
					t.Skip("no gpg")
				}
				f := newFixture(t, sign)
				clock := int64(1800000000)
				f.runner.Now = func() time.Time { clock += 60; return time.Unix(clock, 0) }
				tree := f.pod.Tree
				b := f.pod.Commit("B", map[string]string{"b.txt": "b\n"})
				gittest.Git(t, tree, "branch", "side", b)

				first := f.push(true, nil)
				if first.Outcome != wire.OutcomePushed || first.Push.Bundle == "" {
					t.Fatalf("first: %+v %+v", first, first.Push)
				}
				// The sync: the branch moves to the signed copy.
				if !unbundle(t, f, first.Push.Bundle, first.Push.Published) {
					t.Fatal("the bundle does not carry the published commit")
				}
				gittest.Git(t, tree, "reset", "-q", "--hard", first.Push.Published)
				// The side branch, made at B before the push, gains S and is merged.
				gittest.Git(t, tree, "checkout", "-q", "side")
				f.pod.Commit("S", map[string]string{"s.txt": "s\n"})
				gittest.Git(t, tree, "checkout", "-q", f.pod.Branch)
				gittest.Git(t, tree, "merge", "-q", "--no-ff", "-m", "merge side", "side")

				var pairs []wire.Pair
				if mode == "pair" {
					pairs = []wire.Pair{{Published: first.Push.Published, Source: first.Push.Source}}
				}
				out := f.push(true, pairs)
				if out.Outcome != wire.OutcomePushed {
					t.Fatalf("got %+v %+v", out, out.Push)
				}
				var bs []string
				for line := range strings.SplitSeq(remoteGit(t, f, "log", "--format=%H %s", remoteRef(f)), "\n") {
					if id, subject, _ := strings.Cut(line, " "); subject == "B" {
						bs = append(bs, id)
					}
				}
				if len(bs) != 1 || bs[0] != first.Push.Published {
					t.Fatalf("the remote holds %d copies of B (%v); want one, the first push's %s", len(bs), bs,
						first.Push.Published)
				}
				if n := remoteGit(t, f, "rev-list", "--count", remoteRef(f), "--not", first.Push.Published); n != "2" {
					t.Fatalf("%s new commits, want 2: S and the merge", n)
				}
				if sign == "ssh" {
					verify(t, f, remoteRef(f))
					verify(t, f, remoteRef(f)+"^2")
				}
			})
		}
	}
}

// A commit maps to a published twin only when the twin is a faithful image of it: the same tree,
// and parents that are the commit's own parents as mapped. A commit the Agent reverts and applies
// again with cherry-pick has the key of the first one — patch-id, author line and message — and
// the published copy of that first one is not its image: its parents are older. Mapped to it, the
// push would offer the older copy as the new tip, refused as non-fast-forward without `force` and
// a rewind of the remote with it. The sync did not run.
func TestACommitRevertedAndAppliedAgainIsSignedAndNotMappedToAnOlderCopy(t *testing.T) {
	for _, force := range []bool{false, true} {
		for _, mode := range []string{"pair", "cherry"} {
			name := mode
			if force {
				name += "/force"
			}
			t.Run(name, func(t *testing.T) {
				f := newFixture(t, "ssh")
				tree := f.pod.Tree
				a := f.pod.Commit("A", map[string]string{"a.txt": "a\n"})
				f.pod.Commit("B", map[string]string{"b.txt": "b\n"})
				first := f.push(true, nil)
				if first.Outcome != wire.OutcomePushed {
					t.Fatalf("first: %+v %+v", first, first.Push)
				}
				gittest.Git(t, tree, "revert", "--no-edit", a)
				gittest.Git(t, tree, "cherry-pick", a)
				var pairs []wire.Pair
				if mode == "pair" {
					pairs = []wire.Pair{{Published: first.Push.Published, Source: first.Push.Source}}
				}
				req := f.request(true, pairs)
				req.Push.Force = force
				out := f.runner.Run(context.Background(), req)
				assertPushedTheAgentsTree(t, f, out, first.Push.Published, 2)
			})
		}
	}
}

// The same after a sync and the side-branch merge a published commit must not be signed twice
// for: the Agent then commits C, reverts B and applies it again. B maps to its signed copy; the
// commit that applies B again is new, and signed.
func TestARevertAndReapplyAfterASyncAndASideBranchMergeIsPushed(t *testing.T) {
	for _, mode := range []string{"pair", "cherry"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t, "ssh")
			tree := f.pod.Tree
			b := f.pod.Commit("B", map[string]string{"b.txt": "b\n"})
			gittest.Git(t, tree, "branch", "side", b)
			first := f.push(true, nil)
			if first.Outcome != wire.OutcomePushed || !unbundle(t, f, first.Push.Bundle, first.Push.Published) {
				t.Fatalf("first: %+v %+v", first, first.Push)
			}
			gittest.Git(t, tree, "reset", "-q", "--hard", first.Push.Published)
			gittest.Git(t, tree, "checkout", "-q", "side")
			f.pod.Commit("S", map[string]string{"s.txt": "s\n"})
			gittest.Git(t, tree, "checkout", "-q", f.pod.Branch)
			gittest.Git(t, tree, "merge", "-q", "--no-ff", "-m", "merge side", "side")
			f.pod.Commit("C", map[string]string{"c.txt": "c\n"})
			gittest.Git(t, tree, "revert", "--no-edit", b)
			gittest.Git(t, tree, "cherry-pick", b)
			var pairs []wire.Pair
			if mode == "pair" {
				pairs = []wire.Pair{{Published: first.Push.Published, Source: first.Push.Source}}
			}
			out := f.push(true, pairs)
			// S, the merge, C, the revert and B applied again.
			assertPushedTheAgentsTree(t, f, out, first.Push.Published, 5)
		})
	}
}

// assertPushedTheAgentsTree: the push ended `pushed`, the remote's tip is the published commit and
// a descendant of before with n new commits, each signed, and its tree is the Agent's.
func assertPushedTheAgentsTree(t *testing.T, f *fixture, out wire.Output, before string, n int) {
	t.Helper()
	if out.Outcome != wire.OutcomePushed {
		t.Fatalf("got %+v %+v", out, out.Push)
	}
	tip := remoteRef(f)
	if tip != out.Push.Published {
		t.Fatalf("the remote holds %s, the output says %s", tip, out.Push.Published)
	}
	if got := remoteGit(t, f, "rev-list", "--count", tip, "--not", before); got != strconv.Itoa(n) {
		t.Fatalf("%s new commits on the remote, want %d (it was rewound, or a commit was mapped to an older copy)",
			got, n)
	}
	if remoteGit(t, f, "rev-parse", tip+"^{tree}") != gittest.Git(t, f.pod.Tree, "rev-parse", f.pod.Tip()+"^{tree}") {
		t.Fatal("the remote's tree is not the Agent's")
	}
	if f.signer == "" {
		return // verify reads an ssh signature; a GPG fixture's commits are checked by their count
	}
	for c := range strings.FieldsSeq(remoteGit(t, f, "rev-list", tip, "--not", before)) {
		verify(t, f, c)
	}
}

// A merge the Agent made before its first push is mapped like any other commit. The Agent merges
// its own side branch x (commit X) as A, commits B and makes a side branch at B; the push publishes
// X′, A′ and B′, and the sync moves the branch to B′; the side branch gains S and is merged. A's
// key names its non-first parents as mapped — X′, the parent A′ has — so A maps to A′, B to B′, and
// the next push signs only S and the merge: no published commit is signed twice.
func TestAMergeBeforeTheFirstPushIsNeverSignedTwice(t *testing.T) {
	for _, sign := range []string{"ssh", "gpg"} {
		for _, mode := range []string{"pair", "cherry"} {
			t.Run(sign+"/"+mode, func(t *testing.T) {
				if _, err := exec.LookPath("gpg"); sign == "gpg" && err != nil {
					t.Skip("no gpg")
				}
				f := newFixture(t, sign)
				clock := int64(1800000000)
				f.runner.Now = func() time.Time { clock += 60; return time.Unix(clock, 0) }
				tree := f.pod.Tree
				gittest.Git(t, tree, "checkout", "-q", "-b", "x")
				f.pod.Commit("X", map[string]string{"x.txt": "x\n"})
				gittest.Git(t, tree, "checkout", "-q", f.pod.Branch)
				gittest.Git(t, tree, "merge", "-q", "--no-ff", "-m", "A merge x", "x")
				b := f.pod.Commit("B", map[string]string{"b.txt": "b\n"})
				gittest.Git(t, tree, "branch", "side", b)

				first := f.push(true, nil)
				if first.Outcome != wire.OutcomePushed || !unbundle(t, f, first.Push.Bundle, first.Push.Published) {
					t.Fatalf("first: %+v %+v", first, first.Push)
				}
				gittest.Git(t, tree, "reset", "-q", "--hard", first.Push.Published)
				gittest.Git(t, tree, "checkout", "-q", "side")
				f.pod.Commit("S", map[string]string{"s.txt": "s\n"})
				gittest.Git(t, tree, "checkout", "-q", f.pod.Branch)
				gittest.Git(t, tree, "merge", "-q", "--no-ff", "-m", "merge side", "side")

				var pairs []wire.Pair
				if mode == "pair" {
					pairs = []wire.Pair{{Published: first.Push.Published, Source: first.Push.Source}}
				}
				out := f.push(true, pairs)
				assertOneCopyOfEach(t, f, "X", "A merge x", "B", "S", "merge side")
				assertPushedTheAgentsTree(t, f, out, first.Push.Published, 2)
			})
		}
	}
}

// The ledger's pair is the one exact commit the last push published for: it is taken as it is,
// even when it is not a faithful image. A squash publishes Q for the Agent's A and B, and Q's
// parent is the published base, not A. The sync moves the branch to Q; a side branch the Agent
// made at B before the squash gains S and is merged. B maps to Q by the ledger, so A and B are not
// signed again beside the squashed commit: the next signed push publishes S and the merge alone.
func TestASideBranchMadeBeforeASquashIsMergedWithoutPublishingTheSquashedCommits(t *testing.T) {
	f := newFixture(t, "ssh")
	clock := int64(1800000000)
	f.runner.Now = func() time.Time { clock += 60; return time.Unix(clock, 0) }
	tree := f.pod.Tree
	f.pod.Commit("A", map[string]string{"a.txt": "a\n"})
	b := f.pod.Commit("B", map[string]string{"b.txt": "b\n"})
	gittest.Git(t, tree, "branch", "side", b)
	req := f.request(true, nil)
	msg := "one squashed commit"
	req.Push.Squash = &msg
	first := f.runner.Run(context.Background(), req)
	if first.Outcome != wire.OutcomePushed || !unbundle(t, f, first.Push.Bundle, first.Push.Published) {
		t.Fatalf("first: %+v %+v", first, first.Push)
	}
	gittest.Git(t, tree, "reset", "-q", "--hard", first.Push.Published)
	gittest.Git(t, tree, "checkout", "-q", "side")
	f.pod.Commit("S", map[string]string{"s.txt": "s\n"})
	gittest.Git(t, tree, "checkout", "-q", f.pod.Branch)
	gittest.Git(t, tree, "merge", "-q", "--no-ff", "-m", "merge side", "side")

	out := f.push(true, []wire.Pair{{Published: first.Push.Published, Source: first.Push.Source}})
	assertPushedTheAgentsTree(t, f, out, first.Push.Published, 2)
	if got := remoteGit(t, f, "log", "--format=%s", remoteRef(f), "--not", "main"); got !=
		"merge side\nS\n"+msg {
		t.Fatalf("published after main:\n%s", got)
	}
}

// The parents half of the faithful image. The Agent reverts its tip B and applies it again: the
// commit that applies B again has B's key and B′'s tree, yet B′'s parent is A′, not the revert.
// Mapped to B′, the push would answer `unchanged` and publish neither the revert nor B again.
func TestATipRevertedAndAppliedAgainIsSignedAndNotMappedToItsOwnCopy(t *testing.T) {
	for _, force := range []bool{false, true} {
		for _, mode := range []string{"pair", "cherry"} {
			name := mode
			if force {
				name += "/force"
			}
			t.Run(name, func(t *testing.T) {
				f := newFixture(t, "ssh")
				tree := f.pod.Tree
				f.pod.Commit("A", map[string]string{"a.txt": "a\n"})
				b := f.pod.Commit("B", map[string]string{"b.txt": "b\n"})
				first := f.push(true, nil)
				if first.Outcome != wire.OutcomePushed {
					t.Fatalf("first: %+v %+v", first, first.Push)
				}
				gittest.Git(t, tree, "revert", "--no-edit", b)
				gittest.Git(t, tree, "cherry-pick", b)
				var pairs []wire.Pair
				if mode == "pair" {
					pairs = []wire.Pair{{Published: first.Push.Published, Source: first.Push.Source}}
				}
				req := f.request(true, pairs)
				req.Push.Force = force
				out := f.runner.Run(context.Background(), req)
				if out.Push != nil && out.Push.Unchanged {
					t.Fatalf("the push answered unchanged: %+v", out.Push)
				}
				assertPushedTheAgentsTree(t, f, out, first.Push.Published, 2)
			})
		}
	}
}

// assertOneCopyOfEach: the remote holds each named subject exactly once.
func assertOneCopyOfEach(t *testing.T, f *fixture, subjects ...string) {
	t.Helper()
	n := map[string]int{}
	for s := range strings.SplitSeq(remoteGit(t, f, "log", "--format=%s", remoteRef(f)), "\n") {
		n[s]++
	}
	for _, s := range subjects {
		if n[s] != 1 {
			t.Fatalf("the remote holds %d copies of %q, want one (%v)", n[s], s, n)
		}
	}
}
