/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package repocache

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

// realGit runs git for a test's own setup, outside the agent's seam, and
// fails the test on an error.
func realGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=jr2", "GIT_AUTHOR_EMAIL=jr2@example.invalid",
		"GIT_COMMITTER_NAME=jr2", "GIT_COMMITTER_EMAIL=jr2@example.invalid")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// isolateGit keeps the developer's own git config out of the test, since a
// global gc or fetch setting would change what the cache does.
func isolateGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH")
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
}

// allObjects lists every object the repository can read, reachable or not.
func allObjects(t *testing.T, dir string) []string {
	t.Helper()
	out := realGit(t, dir, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")
	return strings.Fields(out)
}

func TestConsolidationFoldsEveryPackIntoOneAndDeletesNoObject(t *testing.T) {
	// ADR-0004: a cache that is only ever fetched gains a pack per fetch; the
	// agent folds them into one — and a force-pushed branch's commits, which
	// no ref reaches any more, stay for the clone that borrows them.
	isolateGit(t)
	ctx := context.Background()
	src := filepath.Join(t.TempDir(), "src")
	realGit(t, "", "init", "--initial-branch=main", src)
	realGit(t, src, "commit", "--allow-empty", "-m", "root")

	a := &Agent{Git: ExecGit(), CacheDir: t.TempDir()}
	cache := a.dir(key)
	realGit(t, "", "clone", "--bare", "--", src, cache)
	if err := a.pin(ctx, cache); err != nil {
		t.Fatalf("pin: %v", err)
	}
	if err := a.configureRemote(ctx, cache, src); err != nil {
		t.Fatalf("configure remote: %v", err)
	}
	fetch := func() {
		// unpackLimit=1 keeps every fetch a pack, as a real remote's are once
		// a fetch carries more than a handful of objects.
		realGit(t, cache, "-c", "fetch.unpackLimit=1", "fetch", "origin")
	}

	// A branch that is force-pushed away: its commit reaches the cache, then
	// the ref moves off it.
	realGit(t, src, "switch", "-c", "doomed")
	if err := os.WriteFile(filepath.Join(src, "doomed.txt"), []byte("doomed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	realGit(t, src, "add", "doomed.txt")
	realGit(t, src, "commit", "-m", "doomed")
	orphan := realGit(t, src, "rev-parse", "HEAD")
	fetch()
	realGit(t, src, "reset", "--hard", "main")
	realGit(t, src, "switch", "main")
	fetch()
	if got := realGit(t, cache, "rev-parse", "refs/heads/doomed"); got == orphan {
		t.Fatal("setup: the cache's doomed branch should have moved off the orphan")
	}
	if out := realGit(t, cache, "branch", "--contains", orphan); out != "" {
		t.Fatalf("setup: the orphan must be unreachable, but %q reaches it", out)
	}
	// A loose object nothing reaches, too.
	stray := filepath.Join(t.TempDir(), "stray")
	if err := os.WriteFile(stray, []byte("nothing reaches me\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	blob := realGit(t, cache, "hash-object", "-w", "--", stray)

	for i := range consolidatePacks {
		if err := os.WriteFile(filepath.Join(src, "f"), fmt.Appendf(nil, "%d\n", i), 0o644); err != nil {
			t.Fatal(err)
		}
		realGit(t, src, "add", "f")
		realGit(t, src, "commit", "-m", fmt.Sprint(i))
		fetch()
	}
	loose, packs := objectCounts(cache)
	if packs < consolidatePacks {
		t.Fatalf("setup: expected at least %d packs, got %d", consolidatePacks, packs)
	}
	before := allObjects(t, cache)

	a.consolidate(ctx, key, cache)

	after := allObjects(t, cache)
	for _, oid := range before {
		if !slices.Contains(after, oid) {
			t.Errorf("object %s was readable before consolidation and is gone after", oid)
		}
	}
	for _, oid := range []string{orphan, blob} {
		realGit(t, cache, "cat-file", "-e", oid)
	}
	looseAfter, packsAfter := objectCounts(cache)
	if packsAfter != 1 || looseAfter != 0 {
		t.Fatalf("expected one pack and no loose objects, got %d packs and %d loose (from %d and %d)", packsAfter, looseAfter, packs, loose)
	}
	for _, kv := range slices.Concat(gcPins, wirePins) {
		if got := realGit(t, cache, "config", "--get", kv[0]); got != kv[1] {
			t.Errorf("%s must stay %q after consolidation, got %q", kv[0], kv[1], got)
		}
	}
	if _, err := os.Stat(filepath.Join(cache, "packed-refs")); err != nil {
		t.Errorf("refs should be packed: %v", err)
	}
}

func TestConsolidationWaitsForItsCountsAndNeverPrunes(t *testing.T) {
	// ADR-0004: consolidation runs once loose objects or packs pass a count,
	// and whoever edits the command may add no `--prune` and no `gc`.
	for _, tc := range []struct {
		name         string
		loose, packs int
		want         bool
	}{
		{"below both counts", consolidateLoose - 1, consolidatePacks - 1, false},
		{"at the pack count", 0, consolidatePacks, true},
		{"at the loose count", consolidateLoose, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			git := &fakeGit{fail: map[string]string{}}
			a := &Agent{Git: git, CacheDir: t.TempDir()}
			dir := a.dir(key)
			fill(t, dir, tc.loose, tc.packs)
			a.consolidate(context.Background(), key, dir)
			if ran := len(git.calls) > 0; ran != tc.want {
				t.Fatalf("expected consolidation %v, got calls %v", tc.want, git.calls)
			}
			if !tc.want {
				return
			}
			if !slices.EqualFunc(git.calls, consolidation, slices.Equal) {
				t.Fatalf("expected %v, got %v", consolidation, git.calls)
			}
			for _, c := range git.calls {
				if c[0] == "gc" || c[0] == "prune" || slices.ContainsFunc(c, func(arg string) bool { return strings.HasPrefix(arg, "--prune") }) {
					t.Fatalf("consolidation must delete no object, got %v", c)
				}
			}
			if !slices.Contains(git.calls[0], "-k") {
				t.Fatalf("the repack must keep unreachable objects (-k), got %v", git.calls[0])
			}
		})
	}
}

func TestConsolidationIsBoundedByABudget(t *testing.T) {
	git := &fakeGit{fail: map[string]string{}}
	a := &Agent{Git: git, CacheDir: t.TempDir()}
	dir := a.dir(key)
	fill(t, dir, 0, consolidatePacks)
	a.consolidate(context.Background(), key, dir)
	for i, budget := range git.budgets {
		if budget <= 0 || budget > defaultConsolidateTimeout {
			t.Fatalf("call %v must carry the consolidation budget, got %v", git.calls[i], budget)
		}
	}
}

func TestAFailedConsolidationStopsAtTheFailedStep(t *testing.T) {
	git := &fakeGit{fail: map[string]string{"repack": "fatal: out of space"}}
	a := &Agent{Git: git, CacheDir: t.TempDir()}
	dir := a.dir(key)
	fill(t, dir, 0, consolidatePacks)
	a.consolidate(context.Background(), key, dir)
	if got := git.subcommands(); !slices.Equal(got, []string{"repack"}) {
		t.Fatalf("nothing runs after a failed repack, got %v", got)
	}
}

func TestTheRefreshConsolidatesAfterAFetchThatLanded(t *testing.T) {
	// The consolidation follows the fetch and its report, on the same worker:
	// the queue keys by Repo, so no fetch of this cache runs beside it.
	git := &fakeGit{}
	old := fixedNow.Add(-6 * time.Minute)
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(old), LastFetched: ts(old), ObservedGeneration: 1}),
	)
	dir := makePresent(t, a)
	fill(t, dir, 0, consolidatePacks)
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	got := git.subcommands()
	fetched, repacked := slices.Index(got, "fetch"), slices.Index(got, "repack")
	if fetched < 0 || repacked < fetched {
		t.Fatalf("expected a fetch, then the consolidation, got %v", git.calls)
	}
	if e := entry(t, a); e == nil || !e.LastFetched.Time.Equal(fixedNow) {
		t.Fatalf("the fetch is reported whatever the consolidation does, got %+v", e)
	}
}

func TestAFailedFetchIsNotConsolidated(t *testing.T) {
	git := &fakeGit{fail: map[string]string{"fetch": "fatal: unable to access"}}
	old := fixedNow.Add(-6 * time.Minute)
	a := newAgent(t, git,
		repo(1, corev1alpha1.RepoNodeStatus{Node: node, Present: true, Synced: true, LastAttempt: ts(old), LastFetched: ts(old), ObservedGeneration: 1}),
	)
	dir := makePresent(t, a)
	fill(t, dir, 0, consolidatePacks)
	if _, err := reconcile1(t, a); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if slices.Contains(git.subcommands(), "repack") {
		t.Fatalf("a fetch that failed brought no pack; nothing to consolidate, got %v", git.calls)
	}
}

// fill writes empty stand-ins for loose objects and packs, which is all
// objectCounts reads.
func fill(t *testing.T, dir string, loose, packs int) {
	t.Helper()
	fanout := filepath.Join(dir, "objects", "ab")
	pack := filepath.Join(dir, "objects", "pack")
	for _, d := range []string{fanout, pack} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for i := range loose {
		if err := os.WriteFile(filepath.Join(fanout, fmt.Sprintf("%038x", i)), nil, 0o444); err != nil {
			t.Fatal(err)
		}
	}
	for i := range packs {
		for _, ext := range []string{".pack", ".idx"} {
			if err := os.WriteFile(filepath.Join(pack, fmt.Sprintf("pack-%040x%s", i, ext)), nil, 0o444); err != nil {
				t.Fatal(err)
			}
		}
	}
}
