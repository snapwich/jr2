/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package repocache

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/util/retry"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	corev1alpha1 "github.com/snapwich/jr2/operator/api/v1alpha1"
)

const (
	// defaultLFSTimeout bounds one `git lfs fetch` for the asks of one
	// Reconcile (ADR-0053). The Orchestrator waits this long, plus a little,
	// for the answer, so an asker gets git-lfs's words and not a time-out.
	defaultLFSTimeout = 10 * time.Minute
	// lfsErrorLimit caps the git-lfs words that go into one answer item.
	lfsErrorLimit = 1000
	// lfsPointerVersion is the first line of every Git LFS pointer.
	lfsPointerVersion = "version https://git-lfs.github.com/spec/v1"
)

// lfsAsker is one pod on this node that mounts the cache and carries an LFS
// ask that the agent did not serve yet.
type lfsAsker struct {
	pod string
	ask corev1alpha1.LFSAsk
}

// lfsDemand reads the LFS asks of the pods on this node that mount the key's
// cache. It gives the asks that are due — an `at` later than the `asked` of
// the pod's item in this node's entry — and the names of all pods that mount
// the cache. A pod with no item is due. A value that does not parse is not an
// ask, and the agent says so in its log.
func (a *Agent) lfsDemand(ctx context.Context, repo *corev1alpha1.Repo, key string) ([]lfsAsker, map[string]bool, error) {
	var list corev1.PodList
	if err := a.List(ctx, &list, client.InNamespace(a.Namespace)); err != nil {
		return nil, nil, fmt.Errorf("list pods: %w", err)
	}
	served := map[string]time.Time{}
	if entry := a.own(repo); entry != nil {
		for _, item := range entry.LFS {
			if at, err := time.Parse(time.RFC3339Nano, item.Asked); err == nil {
				served[item.Pod] = at
			}
		}
	}
	mounting := map[string]bool{}
	var due []lfsAsker
	for i := range list.Items {
		pod := &list.Items[i]
		if !a.mounts(pod, key) {
			continue
		}
		mounting[pod.Name] = true
		raw, ok := pod.Annotations[corev1alpha1.LFSAnnotation(key)]
		if !ok {
			continue
		}
		ask, err := corev1alpha1.ParseLFSAsk(raw)
		if err != nil {
			logf.FromContext(ctx).Info("unparseable LFS ask on a pod; treating as absent", "pod", pod.Name, "key", key, "error", err.Error())
			continue
		}
		if last, ok := served[pod.Name]; ok && !ask.At.After(last) {
			continue
		}
		due = append(due, lfsAsker{pod: pod.Name, ask: ask})
	}
	slices.SortFunc(due, func(x, y lfsAsker) int { return strings.Compare(x.pod, y.pod) })
	return due, mounting, nil
}

// serveLFS answers the due LFS asks of the pods on this node (ADR-0053). It
// runs in every Reconcile of a Repo, but it does work only when a pod asked:
// it never fetches on the interval, on a clone or in a sweep. With the cache
// present, it gets the asked objects that are not in `<cache>/lfs/objects`.
// With no cache, it answers each due pod with an error that says so. Then it
// writes one answer item for each pod that it served, and removes the items
// of pods that no longer mount the cache.
func (a *Agent) serveLFS(ctx context.Context, repo *corev1alpha1.Repo, key, dir string, isPresent bool) error {
	due, mounting, err := a.lfsDemand(ctx, repo, key)
	if err != nil {
		return err
	}
	stale := false
	if entry := a.own(repo); entry != nil {
		stale = slices.ContainsFunc(entry.LFS, func(item corev1alpha1.RepoLFSAnswer) bool { return !mounting[item.Pod] })
	}
	if len(due) == 0 && !stale {
		return nil
	}
	started := a.now()
	answers := make([]corev1alpha1.RepoLFSAnswer, 0, len(due))
	if !isPresent {
		for _, d := range due {
			answers = append(answers, corev1alpha1.RepoLFSAnswer{
				Pod: d.pod, Asked: d.ask.AtRaw, Attempted: &started,
				Error: fmt.Sprintf("the node cache of Repo %s is not present on node %s: it is absent or still cloning", key, a.Node),
			})
		}
	} else if len(due) > 0 {
		answers = a.getLFS(ctx, repo, dir, due, started)
	}
	return a.reportLFS(ctx, repo, answers, mounting)
}

// getLFS gets the objects that the due asks name and that the cache does not
// hold, and gives one answer for each due pod. The asks are grouped by LFS
// server, which is the same for each pod unless their bases name different
// servers, so the usual case is one `git lfs fetch`.
func (a *Agent) getLFS(ctx context.Context, repo *corev1alpha1.Repo, dir string, due []lfsAsker, started metav1.Time) []corev1alpha1.RepoLFSAnswer {
	log := logf.FromContext(ctx)
	failures := map[string]string{} // pod → why its ask cannot be served
	env, credErr := a.credentials(ctx, repo)
	type group struct {
		objects []corev1alpha1.LFSObject
		words   string
	}
	groups := map[string]*group{}
	endpointOf := map[string]string{} // pod → LFS server
	for _, d := range due {
		if credErr != nil {
			failures[d.pod] = credErr.Error()
			continue
		}
		endpoint, err := a.lfsEndpoint(ctx, dir, repo.Spec.URL, d.ask.Base)
		if err != nil {
			failures[d.pod] = err.Error()
			continue
		}
		endpointOf[d.pod] = endpoint
		g := groups[endpoint]
		if g == nil {
			g = &group{}
			groups[endpoint] = g
		}
		for _, o := range d.ask.Objects {
			if !slices.ContainsFunc(g.objects, func(x corev1alpha1.LFSObject) bool { return x.OID == o.OID }) && !a.hasLFS(dir, o.OID) {
				g.objects = append(g.objects, o)
			}
		}
	}
	for endpoint, g := range groups {
		if len(g.objects) == 0 {
			continue
		}
		g.words = a.fetchLFS(ctx, dir, env, endpoint, g.objects)
		if g.words != "" {
			log.Info("LFS fetch failed", "key", repo.Name, "objects", len(g.objects), "error", g.words)
		} else {
			log.V(1).Info("Fetched LFS objects", "key", repo.Name, "objects", len(g.objects))
		}
	}
	answers := make([]corev1alpha1.RepoLFSAnswer, 0, len(due))
	for _, d := range due {
		answer := corev1alpha1.RepoLFSAnswer{Pod: d.pod, Asked: d.ask.AtRaw, Attempted: &started}
		if why, ok := failures[d.pod]; ok {
			answer.Error = cutLFSWords(why)
		} else {
			var missing []string
			for _, o := range d.ask.Objects {
				if !a.hasLFS(dir, o.OID) {
					missing = append(missing, o.OID)
				} else if err := readable(dir, o.OID); err != nil {
					log.Error(err, "Could not make an LFS object readable", "key", repo.Name, "oid", o.OID)
				}
			}
			if len(missing) > 0 {
				words := groups[endpointOf[d.pod]].words
				if words == "" {
					words = fmt.Sprintf("git-lfs did not get %d object(s), for example %s", len(missing), missing[0])
				}
				answer.Error = cutLFSWords(words)
			}
		}
		answers = append(answers, answer)
	}
	return answers
}

// lfsEndpoint is the LFS server for an ask (ADR-0051): `lfs.url`, else
// `remote.origin.lfsurl`, from `.lfsconfig` at the Binding's base, else the
// url that git-lfs derives from the Repo's url. An empty base is the cache's
// HEAD. The agent always gives git-lfs the server as `lfs.url`, so the
// `.lfsconfig` at the cache's HEAD cannot override the base's.
//
// The base comes from inside a pod. The ask's parser refuses a leading `-`, a
// NUL and a newline, and git resolves it after `--end-of-options`. A server
// that `.lfsconfig` names must use http(s) or the Repo url's own scheme, so a
// base cannot point the agent at a file on the node.
func (a *Agent) lfsEndpoint(ctx context.Context, dir, repoURL, base string) (string, error) {
	if strings.HasPrefix(base, "-") || strings.ContainsAny(base, "\x00\r\n") {
		return "", fmt.Errorf("bad base %q", base)
	}
	name := base
	if name == "" {
		name = "HEAD"
	}
	commit, err := a.Git.Run(ctx, dir, nil, "rev-parse", "--verify", "--quiet", "--end-of-options", name+"^{commit}")
	if err != nil || commit == "" {
		if base == "" {
			return derivedLFSURL(repoURL), nil
		}
		return "", fmt.Errorf("cannot read .lfsconfig: the base %q is not in the node cache", base)
	}
	blob, err := a.Git.Run(ctx, dir, nil, "rev-parse", "--verify", "--quiet", "--end-of-options", commit+":.lfsconfig")
	if err != nil || blob == "" {
		return derivedLFSURL(repoURL), nil
	}
	for _, k := range []string{"lfs.url", "remote.origin.lfsurl"} {
		value, err := a.Git.Run(ctx, dir, nil, "config", "--blob", blob, "--get", k)
		if err != nil || value == "" {
			continue
		}
		if !lfsSchemeAllowed(value, repoURL) {
			return "", fmt.Errorf(".lfsconfig at %s names %s %q: the node cache accepts an http(s) LFS server, or one on the scheme of the Repo's url", name, k, value)
		}
		return value, nil
	}
	return derivedLFSURL(repoURL), nil
}

// derivedLFSURL is the LFS server that git-lfs derives from a Repo's url: for
// http(s), the url with `.git/info/lfs` (or `/info/lfs` after a `.git`) added;
// for any other url (ssh, file), the url itself, which git-lfs reads the same
// way as the remote's url.
func derivedLFSURL(repoURL string) string {
	u, err := url.Parse(repoURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return repoURL
	}
	trimmed := strings.TrimSuffix(repoURL, "/")
	if path.Ext(trimmed) == ".git" {
		return trimmed + "/info/lfs"
	}
	return trimmed + ".git/info/lfs"
}

// lfsSchemeAllowed reports that an LFS server from `.lfsconfig` uses http(s)
// or the Repo url's own scheme. A url with no scheme (`user@host:path`) is ssh.
func lfsSchemeAllowed(lfsURL, repoURL string) bool {
	scheme := urlScheme(lfsURL)
	return scheme == "https" || scheme == "http" || scheme == urlScheme(repoURL)
}

func urlScheme(raw string) string {
	if i := strings.Index(raw, "://"); i > 0 {
		return strings.ToLower(raw[:i])
	}
	return "ssh"
}

// fetchLFS gets objects into `<cache>/lfs/objects` with one `git lfs fetch`
// and gives git-lfs's words when it fails, else "". git-lfs fetches what a
// commit's tree points to, so the agent writes a commit whose tree holds one
// pointer for each object. It writes the pointers, the tree and the commit
// into a temporary object directory that reads the cache's objects as an
// alternate, and removes that directory after: the cache's object store gains
// no object. git-lfs writes nothing in the cache but its own `lfs` folder
// and, the first time, its `lfs.repositoryformatversion` key.
//
// The env holds the Repo's credential (a helper for the url's own origin) and
// GIT_TERMINAL_PROMPT=0. The agent adds http.followRedirects=false for every
// Repo. An LFS server on another host gets no token, and a download href gets
// only the headers of the batch answer (ADR-0051).
func (a *Agent) fetchLFS(ctx context.Context, dir string, env []string, endpoint string, objects []corev1alpha1.LFSObject) string {
	scratch := a.Home
	if scratch == "" {
		scratch = os.TempDir()
	}
	tmp, err := os.MkdirTemp(scratch, "jr2-lfs-")
	if err != nil {
		return fmt.Sprintf("make a temporary folder: %v", err)
	}
	defer func() { _ = os.RemoveAll(tmp) }()
	pointers := filepath.Join(tmp, "pointers")
	if err := os.MkdirAll(filepath.Join(tmp, "objects"), 0o700); err != nil {
		return fmt.Sprintf("make a temporary folder: %v", err)
	}
	if err := os.MkdirAll(pointers, 0o700); err != nil {
		return fmt.Sprintf("make a temporary folder: %v", err)
	}
	files := make([]string, 0, len(objects))
	for _, o := range objects {
		file := filepath.Join(pointers, o.OID)
		pointer := fmt.Sprintf("%s\noid sha256:%s\nsize %d\n", lfsPointerVersion, o.OID, o.Size)
		if err := os.WriteFile(file, []byte(pointer), 0o600); err != nil {
			return fmt.Sprintf("write a pointer: %v", err)
		}
		files = append(files, file)
	}
	env = append(slices.Clone(env),
		"GIT_OBJECT_DIRECTORY="+filepath.Join(tmp, "objects"),
		"GIT_ALTERNATE_OBJECT_DIRECTORIES="+filepath.Join(dir, "objects"),
		"GIT_INDEX_FILE="+filepath.Join(tmp, "index"),
		"GIT_AUTHOR_NAME=jr2", "GIT_AUTHOR_EMAIL=jr2@localhost",
		"GIT_COMMITTER_NAME=jr2", "GIT_COMMITTER_EMAIL=jr2@localhost",
	)
	out, err := a.Git.Run(ctx, dir, env, append([]string{"hash-object", "-w", "--"}, files...)...)
	if err != nil {
		return out
	}
	blobs := strings.Fields(out)
	if len(blobs) != len(objects) {
		return fmt.Sprintf("git hash-object gave %d ids for %d pointers", len(blobs), len(objects))
	}
	args := []string{"update-index", "--add"}
	for i, o := range objects {
		args = append(args, "--cacheinfo", "100644,"+blobs[i]+","+o.OID)
	}
	if out, err := a.Git.Run(ctx, dir, env, args...); err != nil {
		return out
	}
	tree, err := a.Git.Run(ctx, dir, env, "write-tree")
	if err != nil {
		return tree
	}
	commit, err := a.Git.Run(ctx, dir, env, "commit-tree", tree, "-m", "jr2: LFS ask")
	if err != nil {
		return commit
	}
	budget := a.LFSTimeout
	if budget <= 0 {
		budget = defaultLFSTimeout
	}
	fetchCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	out, err = a.Git.Run(fetchCtx, dir, env,
		"-c", "lfs.url="+endpoint,
		"-c", "http.followRedirects=false",
		"-c", "lfs.fetchinclude=",
		"-c", "lfs.fetchexclude=",
		"lfs", "fetch", "origin", commit)
	if err != nil {
		if out == "" {
			out = err.Error()
		}
		return out
	}
	return ""
}

// lfsObjectPath is where git-lfs keeps one object in a cache.
func lfsObjectPath(dir, oid string) string {
	return filepath.Join(dir, "lfs", "objects", oid[0:2], oid[2:4], oid)
}

// hasLFS reports that the cache holds an object.
func (a *Agent) hasLFS(dir, oid string) bool {
	info, err := os.Stat(lfsObjectPath(dir, oid))
	return err == nil && info.Mode().IsRegular()
}

// readable makes an object and the folders above it readable by every uid,
// so a pod's uid 1000 reads it through its read-only mount of the cache.
func readable(dir, oid string) error {
	file := lfsObjectPath(dir, oid)
	if err := addMode(file, 0o444); err != nil {
		return err
	}
	for _, folder := range []string{
		filepath.Join(dir, "lfs"),
		filepath.Join(dir, "lfs", "objects"),
		filepath.Dir(filepath.Dir(file)),
		filepath.Dir(file),
	} {
		if err := addMode(folder, 0o555); err != nil {
			return err
		}
	}
	return nil
}

func addMode(p string, bits os.FileMode) error {
	info, err := os.Stat(p)
	if err != nil {
		return err
	}
	if info.Mode().Perm()&bits == bits {
		return nil
	}
	return os.Chmod(p, info.Mode().Perm()|bits)
}

// cutLFSWords bounds git-lfs's words for an answer item. git-lfs puts its
// summary last, so the end is what stays.
func cutLFSWords(words string) string {
	words = strings.TrimSpace(words)
	if len(words) > lfsErrorLimit {
		words = "…" + words[len(words)-lfsErrorLimit:]
	}
	return words
}

// reportLFS writes the LFS items of this node's entry and only them: it puts
// in an item for each served pod, removes the items of pods that no longer
// mount the cache, and keeps every other field of the entry. With no entry
// for this node, there is nothing to put the items in, and the agent writes
// nothing: an entry needs the clone's or the probe's fields first.
func (a *Agent) reportLFS(ctx context.Context, repo *corev1alpha1.Repo, served []corev1alpha1.RepoLFSAnswer, mounting map[string]bool) error {
	key := client.ObjectKeyFromObject(repo)
	err := retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		var current corev1alpha1.Repo
		if err := a.Get(ctx, key, &current); err != nil {
			return client.IgnoreNotFound(err)
		}
		base := current.DeepCopy()
		var entry *corev1alpha1.RepoNodeStatus
		for i := range current.Status.Nodes {
			if current.Status.Nodes[i].Node == a.Node {
				entry = &current.Status.Nodes[i]
			}
		}
		if entry == nil {
			if len(served) > 0 {
				logf.FromContext(ctx).Info("No status entry for this node yet; the LFS answer waits", "key", repo.Name)
			}
			return nil
		}
		var items []corev1alpha1.RepoLFSAnswer
		for _, item := range entry.LFS {
			if mounting[item.Pod] && !slices.ContainsFunc(served, func(s corev1alpha1.RepoLFSAnswer) bool { return s.Pod == item.Pod }) {
				items = append(items, item)
			}
		}
		items = append(items, served...)
		slices.SortFunc(items, func(x, y corev1alpha1.RepoLFSAnswer) int { return strings.Compare(x.Pod, y.Pod) })
		if equality.Semantic.DeepEqual(items, entry.LFS) || (len(items) == 0 && len(entry.LFS) == 0) {
			return nil
		}
		entry.LFS = items
		return a.Status().Patch(ctx, &current, client.MergeFromWithOptions(base, client.MergeFromWithOptimisticLock{}))
	})
	if err != nil {
		return fmt.Errorf("report LFS answers of node %s on Repo %s: %w", a.Node, repo.Name, err)
	}
	return nil
}
