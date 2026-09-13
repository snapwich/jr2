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
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/util/workqueue"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/snapwich/j2/operator/api/v1alpha1"
)

const (
	// defaultRefreshInterval applies when a Repo's spec carries none (the CRD
	// defaults it; a resource that skipped admission may not).
	defaultRefreshInterval = 5 * time.Minute
	// defaultCloneTimeout bounds one `git clone`; defaultFetchTimeout bounds
	// one `git fetch` or `git ls-remote`. A git child that hangs — a
	// black-holed network, a remote that never answers — would otherwise hold
	// this node's one reconcile worker, and with it every other Repo's
	// on-demand fetch, for as long as it hangs. ADR-0051's "freshness
	// degrades, absence does not" assumes a fetch FAILS; the budget is what
	// turns a hang into a failure.
	defaultCloneTimeout = 30 * time.Minute
	defaultFetchTimeout = 5 * time.Minute
	// evictRetry is how long a deleted Repo whose cache a pod on this node
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
// the Repo itself and by every pod on this node that mounts its cache, so
// controller-runtime's per-object queue is the single writer per key: no
// reconcile of one cache overlaps another.
type Agent struct {
	client.Client
	// Git runs one git invocation; the real one execs the binary.
	Git Git
	// CacheDir holds one bare clone per key (the DaemonSet's hostPath mount).
	CacheDir string
	// Namespace is the Instance's; every Repo and pod the agent sees is in it.
	Namespace string
	// Node is the node this agent runs on — the entry it owns in every Repo's
	// status, and the `spec.nodeName` a pod must carry to count as demand.
	Node string
	// Home is where ssh material is written ($HOME, an emptyDir).
	Home string
	// CloneTimeout bounds one clone and FetchTimeout one fetch or probe; zero
	// means the default.
	CloneTimeout time.Duration
	FetchTimeout time.Duration
	// Now is the clock; tests fix it.
	Now func() time.Time
}

// The agent's RBAC is `j2 up`'s to grant (the DaemonSet's Role, not the
// operator's): repos get/list/watch, repos/status get/update/patch, pods
// get/list/watch, secrets get — all namespaced.

// Reconcile brings `<cache-dir>/<key>` to what the Repo and the pods on this
// node ask for (ADR-0051):
//
//   - the Repo is gone → remove the cache once no pod on this node mounts it;
//   - no cache and a pod here mounts it → clone (a cold node pays once);
//   - no cache and nobody asks → probe the remote once per spec generation, so
//     `j2 status` sees a private repo's error before any run does (ADR-0048);
//   - a cache → pin gc, then fetch when a pod created since the last attempt
//     asks, when the refresh interval elapsed, or when the spec changed.
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
		return ctrl.Result{}, fmt.Errorf("list pods: %w", err)
	}

	var repo corev1alpha1.Repo
	if err := a.Get(ctx, req.NamespacedName, &repo); err != nil {
		if !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		if wanted {
			log.Info("Repo deleted but a pod on this node still mounts its cache; evicting later", "key", key)
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

// demand reports whether any pod on this node mounts the key's cache, and
// the creation time of the newest one. Demand is read off pods, not Sandbox
// resources: a Sandbox holds no finalizer, so its resource is gone the moment
// it is deleted while its pod is still terminating, and a cache is evicted
// "once no pod on that node mounts it" (ADR-0051) — a live bind mount, not a
// resource. A pod is created after its Sandbox, so a fetch after the newest
// pod's creation is a fetch after the Sandbox's, which is what its Ready
// compares the cache's lastFetched against.
func (a *Agent) demand(ctx context.Context, key string) (wanted bool, asked time.Time, err error) {
	var list corev1.PodList
	if err := a.List(ctx, &list, client.InNamespace(a.Namespace)); err != nil {
		return false, time.Time{}, err
	}
	for i := range list.Items {
		pod := &list.Items[i]
		if !a.mounts(pod, key) {
			continue
		}
		wanted = true
		if pod.CreationTimestamp.After(asked) {
			asked = pod.CreationTimestamp.Time
		}
	}
	return wanted, asked, nil
}

// mounts reports whether a pod on this node has a volume over the key's cache
// directory. A pod that has already terminated (phase Succeeded or Failed)
// holds no mount; one that is terminating (a DeletionTimestamp, any other
// phase) still does, until the kubelet is done with it.
func (a *Agent) mounts(pod *corev1.Pod, key string) bool {
	if pod.Spec.NodeName != a.Node || pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
		return false
	}
	for _, k := range a.keysOf(pod) {
		if k == key {
			return true
		}
	}
	return false
}

// keysOf lists the Repo keys a pod's hostPath volumes name under this
// Instance's node directory — the leaf of `HostPath(namespace, key)`.
func (a *Agent) keysOf(pod *corev1.Pod) []string {
	prefix := HostDir(a.Namespace) + "/"
	var keys []string
	for _, volume := range pod.Spec.Volumes {
		if volume.HostPath == nil || !strings.HasPrefix(volume.HostPath.Path, prefix) {
			continue
		}
		key := strings.TrimPrefix(volume.HostPath.Path, prefix)
		if key == "" || strings.Contains(key, "/") {
			continue
		}
		keys = append(keys, key)
	}
	return keys
}

// remote bounds one git call that talks to the remote. The reconcile context
// itself has no deadline.
func (a *Agent) remote(ctx context.Context, budget, fallback time.Duration) (context.Context, context.CancelFunc) {
	if budget <= 0 {
		budget = fallback
	}
	return context.WithTimeout(ctx, budget)
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
			Attempted:          corev1alpha1.RepoAttemptClone,
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
	cloneCtx, cancel := a.remote(ctx, a.CloneTimeout, defaultCloneTimeout)
	_, err = a.Git.Run(cloneCtx, "", env, "clone", "--bare", "--", repo.Spec.URL, dir)
	cancel()
	if err != nil {
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
		Attempted:          corev1alpha1.RepoAttemptClone,
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
// without paying for a clone (ADR-0048). The entry says it was a Probe, so a
// Sandbox that lands here after a failed one is held Pending for the clone,
// not failed for an error no clone produced.
func (a *Agent) probe(ctx context.Context, repo *corev1alpha1.Repo) (ctrl.Result, error) {
	if entry := a.own(repo); entry != nil && entry.Synced && entry.ObservedGeneration == repo.Generation {
		return ctrl.Result{}, nil
	}
	started := a.now()
	entry := corev1alpha1.RepoNodeStatus{
		Present:            false,
		Synced:             true,
		Attempted:          corev1alpha1.RepoAttemptProbe,
		ObservedGeneration: repo.Generation,
		LastAttempt:        &started,
	}
	env, err := a.credentials(ctx, repo)
	if err == nil {
		probeCtx, cancel := a.remote(ctx, a.FetchTimeout, defaultFetchTimeout)
		_, err = a.Git.Run(probeCtx, "", env, "ls-remote", "--heads", "--", repo.Spec.URL)
		cancel()
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
		Attempted:          corev1alpha1.RepoAttemptFetch,
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
		fetchCtx, cancel := a.remote(ctx, a.FetchTimeout, defaultFetchTimeout)
		_, err = a.Git.Run(fetchCtx, dir, env, "fetch", "origin")
		cancel()
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

// Sweep walks the cache directory for clones no Repo names: one a pod on
// this node still mounts is adopted — pinned, never refreshed, evicted once
// nothing mounts it (ADR-0004); one nothing mounts is removed. A mounted
// directory with no clone in it is the kubelet's (`DirectoryOrCreate` for a
// Sandbox whose Repo is already gone): nothing to adopt, and not the sweep's
// to remove while the pod's bind mount follows its inode. It runs at startup
// and then on an interval; Repos that exist are the reconciler's.
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
			return fmt.Errorf("list pods: %w", err)
		}
		if wanted {
			if !present(a.dir(key)) {
				continue
			}
			if err := a.pin(ctx, a.dir(key)); err != nil {
				log.Error(err, "Could not pin an adopted cache", "key", key)
			}
			continue
		}
		if err := a.remove(key); err != nil {
			return err
		}
		log.Info("Removed a cache no Repo names and no pod mounts", "key", key)
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

// hostRoot is the node directory the cache agent's DaemonSet owns; `j2 up`
// mounts `HostDir(namespace)` into the agent as its `--cache-dir`.
const hostRoot = "/var/lib/j2"

// HostDir is the node directory holding one Instance's caches: what the
// DaemonSet mounts, and the prefix a Sandbox pod's cache volumes share.
func HostDir(namespace string) string {
	return hostRoot + "/" + namespace + "/repos"
}

// HostPath is where a node keeps one Repo's bare clone for one Instance —
// the path the operator mounts read-only into a Sandbox pod there, and the
// path by which the agent recognizes a pod that mounts the cache.
func HostPath(namespace, key string) string {
	return HostDir(namespace) + "/" + key
}

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

// reposOfPod maps a pod event on this node to the Repos whose caches it
// mounts, so a pod landing here (or leaving) reconciles exactly those caches.
func (a *Agent) reposOfPod(_ context.Context, obj client.Object) []reconcile.Request {
	pod, ok := obj.(*corev1.Pod)
	if !ok || pod.Spec.NodeName != a.Node {
		return nil
	}
	keys := a.keysOf(pod)
	requests := make([]reconcile.Request, 0, len(keys))
	for _, key := range keys {
		requests = append(requests, reconcile.Request{NamespacedName: client.ObjectKey{Namespace: pod.Namespace, Name: key}})
	}
	return requests
}

// repoEvents is what wakes the agent about a Repo: its creation, its
// deletion, and a spec change (a new generation) — never a status write. The
// agent is the one writer of its own status entry, and a failed clone or
// probe writes that entry and then returns an error for the backoff; the
// write's own event would otherwise re-queue the key at once, ahead of the
// backoff, and a bad credential would be retried once per second from every
// node.
func repoEvents() predicate.Predicate {
	return predicate.GenerationChangedPredicate{}
}

// SetupWithManager registers the reconciler — keyed by Repo, woken by the
// pods on this node — with a failure backoff between minBackoff and
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
		For(&corev1alpha1.Repo{}, builder.WithPredicates(repoEvents())).
		Watches(&corev1.Pod{}, handler.EnqueueRequestsFromMapFunc(a.reposOfPod)).
		WithOptions(controller.Options{
			RateLimiter: workqueue.NewTypedItemExponentialFailureRateLimiter[reconcile.Request](minBackoff, maxBackoff),
		}).
		Named("repo-cache").
		Complete(a)
}
