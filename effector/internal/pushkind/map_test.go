package pushkind

import (
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/snapwich/jr2/effector/internal/gittest"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// B14, map before you sign: the pair and cherry map runs on every push, before signing, so a
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

				var last *wire.Pair
				if mode == "pair" {
					last = &wire.Pair{Published: first.Push.Published, Source: first.Push.Source}
				}
				out := f.push(true, last)
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
