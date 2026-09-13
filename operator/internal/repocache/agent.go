/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Package repocache is the cache agent (ADR-0051): the process that runs once
// per node, per Instance, and keeps `<cache-dir>/<key>` — one bare clone per
// Repo the Instance's Sandboxes on this node need — cloned, fetched, gc-pinned
// (ADR-0004), and evicted. It is the one writer of that directory and of this
// node's entry in every Repo's status; the operator reads the entries to place
// Sandboxes and to hold their Ready until the cache is present and fetched.
package repocache

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/util/workqueue"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

const (
	// defaultRefreshInterval applies when a Repo's spec carries none (the CRD
	// defaults it; a resource that skipped admission may not).
	defaultRefreshInterval = 5 * time.Minute
	// evictRetry is how long a deleted Repo whose cache a Sandbox on this node
	// still mounts waits before the agent looks again.
	evictRetry = time.Minute
	// sweepInterval is how often the agent re-walks its directory for caches
	// no Repo names.
	sweepInterval = 10 * time.Minute
	// cloningSuffix marks a clone in progress: `<cache-dir>/<key>.cloning`
	// exists from before `git clone` starts until the cache is pinned and
	// configured. A directory found with its marker is a half clone — never
	// present — and is removed before anything reads it.
	cloningSuffix = ".cloning"
)

// Agent is one node's cache agent. Reconciles are keyed by Repo and driven by
// the Repo itself and by every Sandbox that names it, so controller-runtime's
// per-object queue is the single writer per key: no reconcile of one cache
// overlaps another.
type Agent struct {
	client.Client
	// Git runs one git invocation; the real one execs the binary.
	Git Git
	// CacheDir holds one bare clone per key (the DaemonSet's hostPath mount).
	CacheDir string
	// Namespace is the Instance's; every Repo and Sandbox the agent sees is in it.
	Namespace string
	// Node is the node this agent runs on — the entry it owns in every Repo's
	// status, and the `status.node` a Sandbox must carry to count as demand.
	Node string
	// Home is where ssh material is written ($HOME, an emptyDir).
	Home string
	// Now is the clock; tests fix it.
	Now func() time.Time
}

// The agent's RBAC is `j2 up`'s to grant (the DaemonSet's Role, not the
// operator's): repos get/list/watch, repos/status get/update/patch, sandboxes
// get/list/watch, secrets get — all namespaced.

// Reconcile brings `<cache-dir>/<key>` to what the Repo and this node's
// Sandboxes ask for (ADR-0051):
//
//   - the Repo is gone → remove the cache once no Sandbox on this node mounts it;
//   - no cache and a Sandbox here names it → clone (a cold node pays once);
//   - no cache and nobody asks → probe the remote once per spec generation, so
//     `j2 status` sees a private repo's error before any run does (ADR-0048);
//   - a cache → pin gc, then fetch when a Sandbox created since the last
//     attempt asks, when the refresh interval elapsed, or when the spec changed.
//
// A clone or probe that fails returns an error so the queue retries with
// backoff; a fetch that fails degrades the cache to stale and waits for the
// interval — freshness degrades, absence does not.
func (a *Agent) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
	key := req.Name
	dir := a.dir(key)

	wanted, asked, err := a.demand(ctx, key)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("list Sandboxes: %w", err)
	}

	var repo corev1alpha1.Repo
	if err := a.Get(ctx, req.NamespacedName, &repo); err != nil {
		if !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		if wanted {
			log.Info("Repo deleted but a Sandbox on this node still mounts its cache; evicting later", "key", key)
			return ctrl.Result{RequeueAfter: evictRetry}, nil
		}
		if err := a.remove(key); err != nil {
			return ctrl.Result{}, err
		}
		log.Info("Evicted the cache of a deleted Repo", "key", key)
		return ctrl.Result{}, nil
	}

	if err := a.discardHalfClone(key); err != nil {
		return ctrl.Result{}, err
	}
	if !present(dir) {
		if wanted {
			return a.clone(ctx, &repo, key)
		}
		return a.probe(ctx, &repo)
	}
	return a.refresh(ctx, &repo, dir, asked)
}

// demand reports whether any Sandbox on this node names the key, and the
// creation time of the newest one — the instant its Ready compares the
// cache's lastFetched against, and so the instant a fetch must postdate.
func (a *Agent) demand(ctx context.Context, key string) (wanted bool, asked time.Time, err error) {
	var list corev1alpha1.SandboxList
	if err := a.List(ctx, &list, client.InNamespace(a.Namespace)); err != nil {
		return false, time.Time{}, err
	}
	for i := range list.Items {
		sandbox := &list.Items[i]
		if sandbox.Status.Node != a.Node {
			continue
		}
		for _, ref := range sandbox.Spec.Repos {
			if ref.Key != key {
				continue
			}
			wanted = true
			if sandbox.CreationTimestamp.After(asked) {
				asked = sandbox.CreationTimestamp.Time
			}
			break
		}
	}
	return wanted, asked, nil
}

// clone creates the cache for a Repo a Sandbox on this node is waiting on.
// The marker brackets the clone so a crash mid-way leaves a half clone that
// the next reconcile discards, never one that reads as present.
func (a *Agent) clone(ctx context.Context, repo *corev1alpha1.Repo, key string) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
	dir := a.dir(key)
	started := a.now()
	failed := func(err error) (ctrl.Result, error) {
		if clearErr := a.clear(key); clearErr != nil {
			return ctrl.Result{}, clearErr
		}
		if reportErr := a.report(ctx, repo, corev1alpha1.RepoNodeStatus{
			Present:            false,
			Synced:             false,
			ObservedGeneration: repo.Generation,
			LastAttempt:        &started,
			LastError:          err.Error(),
		}); reportErr != nil {
			return ctrl.Result{}, reportErr
		}
		return ctrl.Result{}, fmt.Errorf("clone Repo %s: %w", key, err)
	}

	env, err := a.credentials(ctx, repo)
	if err != nil {
		return failed(err)
	}
	if err := os.MkdirAll(a.CacheDir, 0o755); err != nil {
		return ctrl.Result{}, err
	}
	if err := os.WriteFile(a.marker(key), nil, 0o644); err != nil {
		return ctrl.Result{}, fmt.Errorf("mark clone: %w", err)
	}
	if _, err := a.Git.Run(ctx, "", env, "clone", "--bare", "--", repo.Spec.URL, dir); err != nil {
		return failed(err)
	}
	if err := a.pin(ctx, dir); err != nil {
		return failed(err)
	}
	if err := a.configureRemote(ctx, dir, repo.Spec.URL); err != nil {
		return failed(err)
	}
	if err := a.unmark(key); err != nil {
		return ctrl.Result{}, err
	}
	if err := a.report(ctx, repo, corev1alpha1.RepoNodeStatus{
		Present:            true,
		Synced:             true,
		ObservedGeneration: repo.Generation,
		LastAttempt:        &started,
		LastFetched:        &started,
	}); err != nil {
		return ctrl.Result{}, err
	}
	log.Info("Cloned", "key", key, "url", repo.Spec.URL)
	return ctrl.Result{RequeueAfter: refreshInterval(repo)}, nil
}

// probe checks a Repo nobody on this node has asked for yet, once per spec
// generation: the sync signal `j2 status` shows before any Sandbox exists,
// without paying for a clone (ADR-0048).
func (a *Agent) probe(ctx context.Context, repo *corev1alpha1.Repo) (ctrl.Result, error) {
	if entry := a.own(repo); entry != nil && entry.Synced && entry.ObservedGeneration == repo.Generation {
		return ctrl.Result{}, nil
	}
	started := a.now()
	entry := corev1alpha1.RepoNodeStatus{
		Present:            false,
		Synced:             true,
		ObservedGeneration: repo.Generation,
		LastAttempt:        &started,
	}
	env, err := a.credentials(ctx, repo)
	if err == nil {
		_, err = a.Git.Run(ctx, "", env, "ls-remote", "--heads", "--", repo.Spec.URL)
	}
	if err != nil {
		entry.Synced = false
		entry.LastError = err.Error()
	}
	if reportErr := a.report(ctx, repo, entry); reportErr != nil {
		return ctrl.Result{}, reportErr
	}
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("probe Repo %s: %w", repo.Name, err)
	}
	logf.FromContext(ctx).V(1).Info("Probed", "key", repo.Name)
	return ctrl.Result{}, nil
}

// refresh keeps a present cache pinned and fetched. The fetch is on demand
// (a Sandbox created since the last attempt), on the interval, or on a spec
// change — which also re-points origin, since the url may be what changed.
func (a *Agent) refresh(ctx context.Context, repo *corev1alpha1.Repo, dir string, asked time.Time) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
	if err := a.pin(ctx, dir); err != nil {
		return ctrl.Result{}, fmt.Errorf("pin Repo %s: %w", repo.Name, err)
	}
	interval := refreshInterval(repo)
	now := a.now()
	entry := a.own(repo)
	var last time.Time
	if entry != nil && entry.LastAttempt != nil {
		last = entry.LastAttempt.Time
	}
	stale := entry == nil || !entry.Present || entry.ObservedGeneration < repo.Generation
	due := last.IsZero() || asked.After(last) || !now.Time.Before(last.Add(interval))
	if !stale && !due {
		return ctrl.Result{RequeueAfter: last.Add(interval).Sub(now.Time)}, nil
	}

	next := corev1alpha1.RepoNodeStatus{
		Present:            true,
		Synced:             true,
		ObservedGeneration: repo.Generation,
		LastAttempt:        &now,
	}
	if entry != nil {
		next.LastFetched = entry.LastFetched
	}
	err := a.configureRemote(ctx, dir, repo.Spec.URL)
	var env []string
	if err == nil {
		env, err = a.credentials(ctx, repo)
	}
	if err == nil {
		_, err = a.Git.Run(ctx, dir, env, "fetch", "origin")
	}
	if err != nil {
		next.Synced = false
		next.LastError = err.Error()
		log.Info("Fetch failed; the cache is stale until the next attempt", "key", repo.Name, "error", err.Error())
	} else {
		next.LastFetched = &now
		log.V(1).Info("Fetched", "key", repo.Name)
	}
	if err := a.report(ctx, repo, next); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: interval}, nil
}

// pin makes object deletion impossible from inside the cache (ADR-0004): no
// automatic gc, no pruning, no maintenance — for the agent's own fetches and
// for any human running git in the directory. Idempotent and cheap, so it runs
// on every reconcile of a present cache, which is how an adopted checkout gets
// pinned too.
func (a *Agent) pin(ctx context.Context, dir string) error {
	for _, kv := range gcPins {
		if err := a.config(ctx, dir, kv[0], kv[1]); err != nil {
			return err
		}
	}
	return nil
}

// gcPins are the config keys that make object deletion impossible from
// inside a cache (ADR-0004).
var gcPins = [][2]string{
	{"gc.auto", "0"},
	{"gc.pruneExpire", "never"},
	{"maintenance.auto", "false"},
}

// fetchRefspecKey is the remote's fetch refspec list; the cache mirrors
// branches and tags into its own refs.
const fetchRefspecKey = "remote.origin.fetch"

// configureRemote points origin at the Repo's url and mirrors its branches
// and tags into the bare cache's own refs, so a Sandbox's `clone --shared`
// off the mount sees `origin/HEAD` and every branch (ADR-0004).
//
// Every git call that takes the url puts `--` before it: the url is a Repo
// CR field a per-run url reaches, and git reads a leading `-` as an option
// (`--upload-pack=<command>` runs a shell as this pod). The Orchestrator's
// identity refuses that spelling first; this is the second lock.
func (a *Agent) configureRemote(ctx context.Context, dir, url string) error {
	for _, args := range [][]string{
		{"--", "remote.origin.url", url},
		{"--replace-all", fetchRefspecKey, "+refs/heads/*:refs/heads/*"},
		{"--add", fetchRefspecKey, "+refs/tags/*:refs/tags/*"},
	} {
		if err := a.config(ctx, dir, args...); err != nil {
			return err
		}
	}
	return nil
}

// config runs one `git config` write in the cache.
func (a *Agent) config(ctx context.Context, dir string, args ...string) error {
	_, err := a.Git.Run(ctx, dir, nil, append([]string{"config"}, args...)...)
	return err
}

// Sweep walks the cache directory for clones no Repo names: one a Sandbox on
// this node still mounts is adopted — pinned, never refreshed, evicted once
// nothing mounts it (ADR-0004); one nothing mounts is removed. It runs at
// startup and then on an interval; Repos that exist are the reconciler's.
func (a *Agent) Sweep(ctx context.Context) error {
	log := logf.FromContext(ctx)
	entries, err := os.ReadDir(a.CacheDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("read %s: %w", a.CacheDir, err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		key := entry.Name()
		err := a.Get(ctx, client.ObjectKey{Namespace: a.Namespace, Name: key}, &corev1alpha1.Repo{})
		if err == nil {
			continue
		}
		if !apierrors.IsNotFound(err) {
			return fmt.Errorf("read Repo %s: %w", key, err)
		}
		wanted, _, err := a.demand(ctx, key)
		if err != nil {
			return fmt.Errorf("list Sandboxes: %w", err)
		}
		if wanted {
			if err := a.pin(ctx, a.dir(key)); err != nil {
				log.Error(err, "Could not pin an adopted cache", "key", key)
			}
			continue
		}
		if err := a.remove(key); err != nil {
			return err
		}
		log.Info("Removed a cache no Repo names and no Sandbox mounts", "key", key)
	}
	return nil
}

// discardHalfClone empties a directory whose clone marker survived — a clone
// the agent did not finish — so it is never read as present.
func (a *Agent) discardHalfClone(key string) error {
	if _, err := os.Stat(a.marker(key)); err != nil {
		return nil
	}
	return a.clear(key)
}

// clear empties the cache directory and drops its marker, keeping the
// directory itself: the kubelet creates it for a Sandbox pod's hostPath, and a
// bind mount follows the inode, so a directory deleted and recreated under a
// running pod would show that pod an empty cache forever. The retry clones
// into the same, now empty, directory.
func (a *Agent) clear(key string) error {
	entries, err := os.ReadDir(a.dir(key))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read cache %s: %w", key, err)
	}
	for _, entry := range entries {
		if err := os.RemoveAll(filepath.Join(a.dir(key), entry.Name())); err != nil {
			return fmt.Errorf("clear cache %s: %w", key, err)
		}
	}
	return a.unmark(key)
}

// remove deletes the cache and its marker, whether or not either exists —
// eviction, once nothing on this node mounts it.
func (a *Agent) remove(key string) error {
	if err := os.RemoveAll(a.dir(key)); err != nil {
		return fmt.Errorf("remove cache %s: %w", key, err)
	}
	return a.unmark(key)
}

func (a *Agent) unmark(key string) error {
	if err := os.Remove(a.marker(key)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove clone marker %s: %w", key, err)
	}
	return nil
}

func (a *Agent) dir(key string) string    { return filepath.Join(a.CacheDir, key) }
func (a *Agent) marker(key string) string { return filepath.Join(a.CacheDir, key+cloningSuffix) }

// now is the current instant at the API's own granularity, so what the agent
// writes compares exactly with what it reads back.
func (a *Agent) now() metav1.Time {
	clock := a.Now
	if clock == nil {
		clock = time.Now
	}
	return metav1.NewTime(clock().Truncate(time.Second))
}

// present reports a bare clone at dir. The kubelet creates the directory
// itself (`DirectoryOrCreate`) before the agent has cloned anything, so the
// directory's existence says nothing; its HEAD does.
func present(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "HEAD"))
	return err == nil
}

func refreshInterval(repo *corev1alpha1.Repo) time.Duration {
	if repo.Spec.RefreshInterval != nil && repo.Spec.RefreshInterval.Duration > 0 {
		return repo.Spec.RefreshInterval.Duration
	}
	return defaultRefreshInterval
}

// reposOfSandbox maps a Sandbox event on this node to the Repos it names, so
// a Sandbox landing here (or leaving) reconciles exactly those caches.
func (a *Agent) reposOfSandbox(_ context.Context, obj client.Object) []reconcile.Request {
	sandbox, ok := obj.(*corev1alpha1.Sandbox)
	if !ok || sandbox.Status.Node != a.Node {
		return nil
	}
	requests := make([]reconcile.Request, 0, len(sandbox.Spec.Repos))
	for _, ref := range sandbox.Spec.Repos {
		requests = append(requests, reconcile.Request{NamespacedName: client.ObjectKey{Namespace: sandbox.Namespace, Name: ref.Key}})
	}
	return requests
}

// SetupWithManager registers the reconciler — keyed by Repo, woken by the
// Sandboxes on this node — with a failure backoff between minBackoff and
// maxBackoff, and the sweep as a runnable that starts once the cache is synced.
func (a *Agent) SetupWithManager(mgr ctrl.Manager, minBackoff, maxBackoff time.Duration) error {
	if err := mgr.Add(manager.RunnableFunc(func(ctx context.Context) error {
		if !mgr.GetCache().WaitForCacheSync(ctx) {
			return errors.New("cache never synced")
		}
		log := logf.FromContext(ctx).WithName("sweep")
		ticker := time.NewTicker(sweepInterval)
		defer ticker.Stop()
		for {
			if err := a.Sweep(logf.IntoContext(ctx, log)); err != nil {
				log.Error(err, "Sweep failed")
			}
			select {
			case <-ctx.Done():
				return nil
			case <-ticker.C:
			}
		}
	})); err != nil {
		return err
	}
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.Repo{}).
		Watches(&corev1alpha1.Sandbox{}, handler.EnqueueRequestsFromMapFunc(a.reposOfSandbox)).
		WithOptions(controller.Options{
			RateLimiter: workqueue.NewTypedItemExponentialFailureRateLimiter[reconcile.Request](minBackoff, maxBackoff),
		}).
		Named("repo-cache").
		Complete(a)
}
