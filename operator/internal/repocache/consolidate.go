/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package repocache

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	logf "sigs.k8s.io/controller-runtime/pkg/log"
)

const (
	// consolidateLoose and consolidatePacks are the counts past which a cache
	// is consolidated (ADR-0004): a cache that is only ever fetched gains a
	// pack per fetch, and every object lookup in every borrowing clone opens
	// each one. Git's own gc.auto thresholds are 6700 loose and 50 packs; a
	// cache is fetched, not committed to, so its loose objects are few and
	// its packs are what grows.
	consolidateLoose = 500
	consolidatePacks = 50
	// defaultConsolidateTimeout bounds one consolidation, as the clone's bound
	// does a clone: a repack of a large cache is of the same order. A repack
	// killed mid-way deletes nothing — git removes the old packs only after
	// the new one is in place.
	defaultConsolidateTimeout = defaultCloneTimeout
)

// consolidation is what the agent runs to fold a cache's packs into one
// (ADR-0004). `-k` is the invariant spelled as a flag: every unreachable
// object goes into the new pack, so a force-pushed branch's commits stay for
// the clone that borrows them. The rule for anyone who edits this list: no
// `--prune`, no `gc`, and the gcPins stay.
var consolidation = [][]string{
	{"repack", "-a", "-d", "-k"},
	{"commit-graph", "write", "--reachable"},
	{"pack-refs", "--all"},
}

// consolidate folds a cache's objects into one pack once its loose objects or
// packs pass their count, and deletes no object on the way (ADR-0004). It
// runs on the refresh path after a fetch; the queue gives one key one worker,
// so no fetch of the same cache runs beside it. A failure is logged and
// changes nothing else: the cache is as readable as before, and the next
// interval tries again.
func (a *Agent) consolidate(ctx context.Context, key, dir string) {
	log := logf.FromContext(ctx)
	loose, packs := objectCounts(dir)
	if loose < consolidateLoose && packs < consolidatePacks {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, defaultConsolidateTimeout)
	defer cancel()
	for _, args := range consolidation {
		if _, err := a.Git.Run(ctx, dir, nil, args...); err != nil {
			log.Info("Consolidation failed; the cache is unchanged in what it holds", "key", key, "step", args[0], "error", err.Error())
			return
		}
	}
	looseAfter, packsAfter := objectCounts(dir)
	log.Info("Consolidated", "key", key, "looseBefore", loose, "packsBefore", packs, "looseAfter", looseAfter, "packsAfter", packsAfter)
}

// objectCounts is the number of loose objects (files under objects/??) and
// packs (objects/pack/*.pack) in a bare cache. A directory that cannot be
// read counts as empty: a count only decides whether to consolidate.
func objectCounts(dir string) (loose, packs int) {
	objects := filepath.Join(dir, "objects")
	fanout, _ := os.ReadDir(objects)
	for _, entry := range fanout {
		if !entry.IsDir() || !isFanout(entry.Name()) {
			continue
		}
		files, _ := os.ReadDir(filepath.Join(objects, entry.Name()))
		loose += len(files)
	}
	files, _ := os.ReadDir(filepath.Join(objects, "pack"))
	for _, entry := range files {
		if strings.HasSuffix(entry.Name(), ".pack") {
			packs++
		}
	}
	return loose, packs
}

// isFanout reports a loose-object directory name: two hex digits.
func isFanout(name string) bool {
	return len(name) == 2 && strings.Trim(name, "0123456789abcdef") == ""
}
