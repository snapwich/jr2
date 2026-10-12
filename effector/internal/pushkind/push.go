// Package pushkind runs the `push` kind in the Sandbox Effector (ADR-0067, ADR-0051): the
// Workspace's branch to its Repo Slot's Binding, with the push credential of the
// `git.credentials` entry the url falls under — and, with `sign`, as signed copies of the Agent's
// commits.
//
// git never runs with the Agent's repository as its repository (package gitclean): the Agent's
// branch is read as data, its objects are imported into a new clean repository per call, and the
// remote is the Binding — never a remote of the Agent's config. A token goes Basic through a
// credential helper only, and the helper is this binary; an ssh key is a copy in the call's own
// directory.
//
// Outcomes, every one output: `pushed` (the published commit, its source — the Agent's commit —
// and what the remote held before), `rejected` (a stage — fetch, import, sign, push — and git's
// words), `diverged` (signing: the published commit is not in the Agent's history, and no
// fallback pairs it; nothing was pushed), `unknown` (the push may have reached the remote, and no
// answer came).
//
// Signed: the new commits are found by ancestry — the published tip must be an ancestor of the
// Agent's tip, which the sync step makes true after each push that publishes a commit not the
// Agent's own. When it is not (the sync did not run), a read-only fallback pairs the published
// commits with the Agent's: `pair` from the ledger's pairs — every push of the Repo Slot that
// published, which the start carries — then `cherry` by patch-id, author line and message. A
// squash the remote already holds as this push's exact image is this push's own commit (a restore
// that sends it again). On every push, before anything is signed, the same map runs over the new
// commits (ADR-0067): a commit whose published twin is a faithful image of it — its tree, its
// parents as mapped — is replaced by that twin, and is never signed again. Nothing unsigned leaves:
// every commit the remote lacks must be one this call signed. Author line and date stay the
// Agent's; the committer is the entry's name and email, at this Effector's clock.
package pushkind

import (
	"bytes"
	"context"
	"crypto/sha1" //nolint:gosec // a pairing key, not a security boundary
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/snapwich/jr2/effector/internal/beneath"
	"github.com/snapwich/jr2/effector/internal/gitclean"
	"github.com/snapwich/jr2/effector/internal/reaper"
	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// Runner runs pushes for one Sandbox Effector.
type Runner struct {
	Config *secrets.Config
	// WorkRoot is the Agent's work volume, read-only here (/work); ReposRoot the node caches
	// (/repos); GitRoot the git credentials' mount; Scratch this Effector's own writable dir.
	WorkRoot, ReposRoot, GitRoot, Scratch string
	// Helper is this binary's path: git's credential helper for a token.
	Helper string
	// CAFile is the instance's caBundle (ADR-0020), when one is mounted.
	CAFile   string
	Scrubber *scrub.Scrubber
	// Now is the committer's clock. Default time.Now.
	Now func() time.Time
	// ImportDeadline bounds every read of the Agent's objects. Default 120 s.
	ImportDeadline time.Duration
	// AllowLocal lets a push go to a local path — the tests' remotes, and nothing else. git's local
	// transport runs the remote repository's own config and hooks, and a local path in the pod can
	// be the Agent's repository, so outside the tests a local url is refused.
	AllowLocal bool
}

// Check names what makes a push a defect of jr2 or config, or "": a credential the Effector's
// config does not hold, or a url outside it. `jr2 up` refuses each before the converge.
func (r *Runner) Check(req *wire.StartRequest) string {
	spec := req.Push
	entry := r.Config.EntryFor(spec.Credential, spec.URL)
	switch {
	case entry == nil && spec.Credential == "":
		return "no git.credentials entry this Effector's config holds matches the push url"
	case entry == nil:
		return fmt.Sprintf("the push names git.credentials entry %q, which this Effector's config does not hold",
			spec.Credential)
	case entry.Push == nil:
		return fmt.Sprintf("git.credentials entry %q holds no push credential", entry.Match)
	case !gitclean.Matches(spec.URL, entry.Match):
		return fmt.Sprintf("the push url is not under git.credentials entry %q", entry.Match)
	case spec.Sign && entry.Sign == nil:
		return fmt.Sprintf("the push signs, and git.credentials entry %q holds no sign field", entry.Match)
	case spec.Squash != nil && !spec.Sign && entry.Committer == nil && entry.Sign == nil:
		return fmt.Sprintf("the push squashes unsigned, and git.credentials entry %q holds no committer", entry.Match)
	}
	return ""
}

// Pin reads the commit a push runs against when it names none: the Agent's branch tip, as data.
// The Orchestrator writes it to the intent row, so a restore repeats only that commit.
func Pin(workRoot string, repo wire.RepoRef, branch string) (string, error) {
	gitDir, err := beneath.Dir(workRoot, repo.GitDir)
	if err != nil {
		return "", err
	}
	defer func() { _ = gitDir.Close() }()
	return gitclean.ReadBranch(gitDir, branch)
}

type call struct {
	r     *Runner
	spec  *wire.PushSpec
	entry *secrets.GitEntry
	repo  *gitclean.Repo
	// built is what this call built from a secret, for the scrubber.
	built map[string]string
	// sshLog is where ssh's own stderr goes, beside git's (ADR-0068): the line ssh ends on — "No
	// user exists for uid", a refused connection, a host key — is what a reason names.
	sshLog string
	// agentGroup is the process group of the gpg-agent this call started: the call stops it and
	// waits for it to end before the push settles and releases the Lock's `gpg` class (ADR-0068).
	agentGroup int
}

// Run pushes, and answers the outcome scrubbed.
func (r *Runner) Run(ctx context.Context, req *wire.StartRequest) wire.Output {
	entry := r.Config.EntryFor(req.Push.Credential, req.Push.URL)
	c := &call{r: r, spec: req.Push, entry: entry, built: map[string]string{}}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(req.TimeoutMs)*time.Millisecond)
	defer cancel()
	out := c.run(ctx)
	c.stopAgent()
	if c.repo != nil {
		c.repo.Close()
	}
	s := r.Scrubber.With(c.built)
	out.Reason = s.String(out.Reason)
	if out.Push != nil {
		out.Push.Detail = s.String(out.Push.Detail)
	}
	return out
}

func rejected(stage, reason, detail string) wire.Output {
	return wire.Output{Outcome: wire.OutcomeRejected, Reason: reason, Push: &wire.PushResult{Stage: stage,
		Detail: detail}}
}

func (c *call) run(ctx context.Context) wire.Output {
	spec, r := c.spec, c.r
	sha := spec.Pin
	if sha == "" {
		return rejected("import", "the push has no pinned commit", "")
	}
	gitDir, err := beneath.Dir(r.WorkRoot, spec.Repo.GitDir)
	if err != nil {
		return rejected("import", "the Agent's repository could not be opened: "+err.Error(), "")
	}
	_ = gitDir.Close()
	cache := filepath.Join(r.ReposRoot, spec.Repo.Cache)
	env, protocols, err := c.credential()
	if err != nil {
		return rejected("push", err.Error(), "")
	}
	repo, err := gitclean.New(ctx, gitclean.Options{Scratch: r.Scratch, Caches: []string{cache},
		Protocols: protocols, Env: env})
	if err != nil {
		return rejected("import", "a clean repository could not be made: "+err.Error(), "")
	}
	c.repo = repo
	if err := c.configure(ctx); err != nil {
		return rejected("push", err.Error(), "")
	}

	// What the remote holds now.
	ref := "refs/heads/" + spec.Branch
	pub := ""
	fetched := "+" + ref + ":refs/jr2/published"
	if _, err := repo.Git(ctx, nil, "fetch", "-q", "--no-tags", "--", spec.URL, fetched); err != nil {
		stderr := stderrOf(err)
		if !strings.Contains(strings.ToLower(stderr), "couldn't find remote ref") {
			reason, detail := c.failure(stderr, ctx)
			return rejected("fetch", reason, detail)
		}
	} else if pub, err = repo.Line(ctx, "rev-parse", "-q", "--verify", "refs/jr2/published"); err != nil {
		return rejected("fetch", "the published commit could not be read", "")
	}
	base, err := repo.CacheTips(ctx, []string{cache})
	if err != nil {
		return rejected("import", "the Repo cache's refs could not be read", tail(stderrOf(err)))
	}
	base = slices.DeleteFunc(base, func(t string) bool { return t == pub })
	have := append(slices.Clone(base), nonEmpty(pub)...)

	deadline := r.ImportDeadline
	if deadline == 0 {
		deadline = 120 * time.Second
	}
	if err := repo.Import(ctx, filepath.Join(r.WorkRoot, spec.Repo.GitDir, "objects"), sha, have, deadline); err != nil {
		return rejected("import", err.Error(), "")
	}

	res := wire.PushResult{Published: sha, Source: sha, Previous: pub}
	// A squash is a new commit, signed or not (ADR-0067): it is made as a signed push's copies are.
	if spec.Sign || spec.Squash != nil {
		s, out := c.sign(ctx, sha, pub, base)
		if out != nil {
			return *out
		}
		res.Published, res.Via = s.target, s.via
		// The sync's bundle, whenever what is published is not the Agent's own commit — signed
		// copies, or one squashed commit, signed or not (ADR-0067) — a push that publishes nothing
		// new included: a pair or cherry that maps the published tip (a restore of a pinned push, a
		// push after a sync that did not finish) leaves the Agent's branch on its own commits, and
		// the sync moves it from this bundle.
		if res.Published != sha {
			res.Squashed = c.squashedOf(s)
			if res.Bundle, out = c.bundleOf(ctx, res.Published, sha); out != nil {
				return *out
			}
		}
	}
	if res.Published == pub {
		res.Unchanged = true
		return wire.Output{Outcome: wire.OutcomePushed, Push: &res}
	}
	return c.push(ctx, res)
}

// credential is the env and the protocols of this push's git calls: a token's file for the
// helper, an ssh command's key. Never a value.
func (c *call) credential() ([]string, string, error) {
	switch gitclean.Scheme(c.spec.URL) {
	case gitclean.SchemeHTTP:
		// A token goes over HTTPS only (ADR-0067): Basic over cleartext http is the token in the clear.
		return nil, "", errors.New("the url is http, and jr2 sends a push token over https only")
	case gitclean.SchemeHTTPS:
		if c.entry.Push.Token == "" {
			return nil, "", errors.New("the url is https and the git.credentials entry's push credential is an ssh key")
		}
		file := filepath.Join(c.r.GitRoot, c.entry.Push.Token, secrets.TokenFile)
		if _, err := os.Stat(file); err != nil {
			return nil, "", errors.New("the push token's file is not in this Effector's mount")
		}
		u, err := url.Parse(strings.TrimSpace(c.spec.URL))
		if err != nil || u.Host == "" {
			return nil, "", errors.New("the url's host could not be read")
		}
		// The helper answers only the Binding's own origin: the token never leaves its entry, a
		// redirect included (the clean repository follows none, and the helper checks again).
		return []string{"JR2_GIT_TOKEN_FILE=" + file, "JR2_GIT_TOKEN_HOST=" + u.Host}, "https", nil
	case gitclean.SchemeSSH:
		if c.entry.Push.SSHKey == "" {
			return nil, "", errors.New("the url is ssh and the git.credentials entry's push credential is a token")
		}
		return nil, "ssh", nil
	case gitclean.SchemeLocal:
		// A local repository: no credential crosses. Only the tests' remotes are one (AllowLocal).
		if !c.r.AllowLocal {
			return nil, "", errors.New("the url is a local path, which jr2 never pushes to: git's local transport " +
				"runs that repository's config and hooks")
		}
		return nil, "file", nil
	}
	return nil, "", errors.New("the url's scheme is not one jr2 pushes over")
}

// configure writes the credential's config into the clean repository: a helper, or an ssh
// command whose key is a copy in the call's own directory (a Secret mount's group-readable mode
// is one ssh refuses).
func (c *call) configure(ctx context.Context) error {
	repo := c.repo
	if c.r.CAFile != "" {
		if _, err := os.Stat(c.r.CAFile); err == nil {
			if _, err := repo.Git(ctx, nil, "config", "http.sslCAInfo", c.r.CAFile); err != nil {
				return err
			}
		}
	}
	switch gitclean.Scheme(c.spec.URL) {
	case gitclean.SchemeHTTPS:
		helper := c.r.Helper + " git-credential"
		if _, err := repo.Git(ctx, nil, "config", "--replace-all", "credential.helper", helper); err != nil {
			return err
		}
	case gitclean.SchemeSSH:
		dir := filepath.Join(c.r.GitRoot, c.entry.Push.SSHKey)
		key, err := copyKey(filepath.Join(dir, secrets.PushKeyFile), filepath.Join(repo.Work, "push-key"))
		if err != nil {
			return errors.New("the push key could not be read from this Effector's mount")
		}
		known := filepath.Join(dir, secrets.KnownHostsFile)
		if _, err := os.Stat(known); err != nil {
			return errors.New("the push key's known_hosts is not in this Effector's mount")
		}
		ssh, err := gitclean.Look("ssh")
		if err != nil {
			return fmt.Errorf("the url is ssh, and this Effector's image holds no ssh: %w", err)
		}
		// ssh's own stderr goes to a file of the call's, beside git's (ADR-0068): git's words for an ssh
		// failure name no cause. git runs this through the shell, which takes the redirection.
		c.sshLog = filepath.Join(repo.Work, "ssh.stderr")
		cmd := fmt.Sprintf("'%s' -F /dev/null -i '%s' -o IdentitiesOnly=yes -o IdentityAgent=none "+
			"-o UserKnownHostsFile='%s' -o StrictHostKeyChecking=yes -o BatchMode=yes 2>>'%s'", ssh, key, known,
			c.sshLog)
		if _, err := repo.Git(ctx, nil, "config", "core.sshCommand", cmd); err != nil {
			return err
		}
	}
	return nil
}

func copyKey(from, to string) (string, error) {
	raw, err := os.ReadFile(from)
	if err != nil {
		return "", err
	}
	if !bytes.HasSuffix(raw, []byte("\n")) {
		raw = append(raw, '\n')
	}
	return to, os.WriteFile(to, raw, 0o600)
}

func nonEmpty(s string) []string {
	if s == "" {
		return nil
	}
	return []string{s}
}

// push sends res.Published to the Binding's ref, and reads git's porcelain answer; pushed, res is
// the output.
func (c *call) push(ctx context.Context, res wire.PushResult) wire.Output {
	refspec := res.Published + ":refs/heads/" + c.spec.Branch
	if c.spec.Force {
		refspec = "+" + refspec
	}
	out, err := c.repo.Git(ctx, nil, "push", "--porcelain", "--no-verify", "--", c.spec.URL, refspec)
	stderr := stderrOf(err)
	if err != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return wire.Output{Outcome: wire.OutcomeUnknown,
			Reason: "the timeout passed while the push ran; the remote may hold it"}
	}
	for line := range strings.SplitSeq(string(out), "\n") {
		if len(line) < 2 || line[1] != '\t' {
			continue
		}
		fields := strings.Split(line, "\t")
		summary := ""
		if len(fields) > 2 {
			summary = fields[2]
		}
		switch line[0] {
		case ' ', '+', '*':
			return wire.Output{Outcome: wire.OutcomePushed, Push: &res}
		case '=':
			res.Unchanged = true
			return wire.Output{Outcome: wire.OutcomePushed, Push: &res}
		case '!':
			reason := "the remote refused it"
			switch {
			case strings.Contains(summary, "non-fast-forward"), strings.Contains(summary, "fetch first"),
				strings.Contains(summary, "stale info"):
				reason = "non-fast-forward: the remote's branch moved"
			case strings.Contains(summary, "remote rejected"):
				reason = "the remote rejected it (a hook, a branch protection, a policy)"
			}
			return rejected("push", reason, strings.TrimSpace(summary+"\n"+tail(stderr)))
		}
	}
	// No porcelain line: the connection or the authentication failed before any ref was offered.
	reason, detail := c.failure(stderr, ctx)
	return rejected("push", reason, detail)
}

// failure is why a fetch or a push could not reach the remote: classify's reason over git's stderr
// and ssh's own, with ssh's last line named in it, and both tails as the detail (ADR-0068). git's own
// words for an ssh failure ("Could not read from remote repository") name no cause; ssh's line
// does.
func (c *call) failure(stderr string, ctx context.Context) (string, string) {
	ssh := ""
	if c.sshLog != "" {
		if raw, err := os.ReadFile(c.sshLog); err == nil {
			ssh = strings.TrimSpace(string(raw))
		}
		// One call's ssh lines at a time: a later git call writes its own.
		_ = os.Remove(c.sshLog)
	}
	reason := classify(stderr+"\n"+ssh, ctx)
	if ssh == "" {
		return reason, tail(stderr)
	}
	lines := strings.Split(ssh, "\n")
	return reason + ": ssh: " + strings.TrimSpace(lines[len(lines)-1]),
		strings.TrimSpace(tail(stderr) + "\nssh:\n" + tail(ssh))
}

// classify says why a connection failed, from git's stderr: each is an answer of the outside
// world.
func classify(stderr string, ctx context.Context) string {
	s := strings.ToLower(stderr)
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return "the timeout passed"
	case strings.Contains(s, "host key verification failed"):
		return "the remote's ssh host key is not in known_hosts"
	case strings.Contains(s, "certificate"):
		return "the remote's TLS certificate is not trusted"
	case strings.Contains(s, "authentication failed"), strings.Contains(s, "permission denied"),
		strings.Contains(s, "could not read username"), strings.Contains(s, "access denied"),
		strings.Contains(s, " 401"), strings.Contains(s, " 403"), strings.Contains(s, "not authorized"):
		return "the remote refused the credential"
	case strings.Contains(s, "repository not found"), strings.Contains(s, "does not appear to be a git repository"),
		strings.Contains(s, "not found"):
		return "the remote has no such repository"
	}
	return "the remote could not be reached"
}

func stderrOf(err error) string {
	var ge *gitclean.Error
	if errors.As(err, &ge) {
		return ge.Stderr
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

func tail(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > 4 {
		lines = lines[len(lines)-4:]
	}
	return strings.Join(lines, "\n")
}

// --- signing -------------------------------------------------------------------------------------

// signed is what sign answers: the commit to publish, how the new commits were found, and whether
// this push made that commit — this call (made), or this same push sent before, whose squash the
// remote holds (own). Both are false when the published tip, or a commit the remote holds, stands
// for the Agent's tip.
type signed struct {
	target, via string
	made, own   bool
}

// squashedOf is the output's `squashed`: what the published commit is (ADR-0067). A commit this
// push made is named by this push's options; a commit an earlier push made — the published tip,
// mapped by the pair or by cherry — by that push's own `squashed`, which its pair carries: the
// newest pair whose published commit it is. Any other commit the remote holds that cherry maps is
// a copy of the Agent's commits: "".
func (c *call) squashedOf(s *signed) string {
	mine := s.made || s.own
	switch {
	case mine && c.spec.Squash != nil && c.spec.Sign:
		return wire.SquashedSigned
	case mine && c.spec.Squash != nil:
		return wire.SquashedUnsigned
	case !mine && c.pairFor(s.target) != nil:
		return c.pairFor(s.target).Squashed
	}
	return ""
}

// pairFor is the newest pair whose published commit is published, or nil.
func (c *call) pairFor(published string) *wire.Pair {
	for i, pair := range slices.Backward(c.spec.Pairs) {
		if pair.Published == published {
			return &c.spec.Pairs[i]
		}
	}
	return nil
}

// not is rev-list's word for "and none of these"; reverse and topoOrder list commits oldest first,
// parents before children, as a map that walks them needs.
const not, revList, reverse, topoOrder = "--not", "rev-list", "--reverse", "--topo-order"

// sign makes the commits to publish: signed copies of the Agent's new commits, or one squashed
// commit — signed with `sign`, made with the entry's committer without it (ADR-0067).
func (c *call) sign(ctx context.Context, sha, pub string, base []string) (*signed, *wire.Output) {
	repo := c.repo
	var signer *signerKey
	if c.spec.Sign {
		var err error
		if signer, err = c.signer(ctx); err != nil {
			return nil, ptr(rejected("sign", err.Error(), ""))
		}
	}
	mapped := map[string]string{}
	from, via, done, out := c.rangeOf(ctx, sha, pub, base, mapped)
	if done != nil || out != nil {
		return done, out
	}

	var target string
	mine := map[string]bool{}
	if c.spec.Squash != nil {
		parent := pub
		if parent == "" {
			args := append([]string{"merge-base", sha}, base...)
			if len(base) > 0 {
				parent, _ = repo.Line(ctx, args...)
			}
		}
		head, err := c.read(ctx, sha)
		if err != nil {
			return nil, ptr(rejected("sign", err.Error(), ""))
		}
		target, err = c.write(ctx, signer, head.tree, nonEmpty(parent), head.author, head.encoding,
			squashMessage(*c.spec.Squash))
		if err != nil {
			return nil, ptr(rejected("sign", err.Error(), ""))
		}
		mine[target] = true
	} else {
		args := append(append([]string{revList, reverse, topoOrder, sha, not}, from...), base...)
		list, err := repo.Lines(ctx, args...)
		if err != nil {
			return nil, ptr(rejected("sign", "the Agent's commits could not be listed", tail(stderrOf(err))))
		}
		// Map before you sign (ADR-0067): a commit whose published twin is a faithful image of it
		// is replaced by that twin, and is never signed again.
		tw, err := c.twins(ctx, list, pub)
		if err != nil {
			return nil, ptr(rejected("sign", err.Error(), ""))
		}
		for _, id := range list {
			commit, err := c.read(ctx, id)
			if err != nil {
				return nil, ptr(rejected("sign", err.Error(), ""))
			}
			parents := make([]string, 0, len(commit.parents))
			for _, p := range commit.parents {
				if m, ok := mapped[p]; ok {
					p = m
				}
				parents = append(parents, p)
			}
			twin, err := tw.of(ctx, id, commit, parents)
			if err != nil {
				return nil, ptr(rejected("sign", err.Error(), ""))
			}
			if twin != "" {
				mapped[id] = twin
				continue
			}
			id2, err := c.write(ctx, signer, commit.tree, parents, commit.author, commit.encoding, commit.message)
			if err != nil {
				return nil, ptr(rejected("sign", err.Error(), ""))
			}
			mapped[id] = id2
			mine[id2] = true
		}
		target = sha
		if m, ok := mapped[sha]; ok {
			target = m
		}
	}

	// Nothing unsigned leaves: every commit the remote lacks must be one this call signed.
	args := append(append([]string{revList, target, not}, nonEmpty(pub)...), base...)
	news, err := repo.Lines(ctx, args...)
	if err != nil {
		return nil, ptr(rejected("sign", "the commits to publish could not be listed", tail(stderrOf(err))))
	}
	for _, n := range news {
		if !mine[n] {
			return diverged(sha, pub, fmt.Sprintf("commit %s would be published unsigned", short(n)))
		}
	}
	return &signed{target: target, via: via, made: mine[target]}, nil
}

// bundleOf is the sync's bundle: the signed commits only. Its prerequisite is the Agent's own tip,
// so it carries commit objects and no tree or blob the Agent's store does not hold.
func (c *call) bundleOf(ctx context.Context, target, sha string) (string, *wire.Output) {
	repo := c.repo
	if _, err := repo.Git(ctx, nil, "update-ref", "refs/jr2/out", target); err != nil {
		return "", ptr(rejected("sign", "the signed tip could not be recorded", tail(stderrOf(err))))
	}
	file := filepath.Join(repo.Work, "sync.bundle")
	if _, err := repo.Git(ctx, nil, "bundle", "create", "-q", file, "refs/jr2/out", not, sha); err != nil {
		return "", ptr(rejected("sign", "the sync bundle could not be written", tail(stderrOf(err))))
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return "", ptr(rejected("sign", "the sync bundle could not be read", ""))
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

// rangeOf finds what to sign: the commits after `from`, and which Agent commit stands for the
// published tip (written into mapped) — by ancestry, the newest pair whose published commit is the
// remote's tip, or cherry; a squash whose exact image the remote holds is this push's own commit;
// none of them is `diverged`, with or without `force`. A non-nil signed or output ends the push
// there.
func (c *call) rangeOf(ctx context.Context, sha, pub string, base []string,
	mapped map[string]string) ([]string, string, *signed, *wire.Output) {
	repo := c.repo
	var from []string
	via := ""
	if pub != "" {
		switch {
		case pub == sha:
			return nil, "", &signed{target: sha, via: "ancestry"}, nil
		case repo.IsAncestor(ctx, pub, sha):
			from, via = []string{pub}, "ancestry"
		case c.pairFor(pub) != nil && repo.IsAncestor(ctx, c.pairFor(pub).Source, sha):
			// The sync did not run: the push that published the remote's tip names its own pair.
			source := c.pairFor(pub).Source
			if source == sha {
				return nil, "", &signed{target: pub, via: "pair"}, nil
			}
			mapped[source] = pub
			from, via = []string{source}, "pair"
		case c.ownSquash(ctx, pub, sha, base):
			// This push, sent before: the remote holds its squash (ADR-0067). It publishes nothing new.
			return nil, "", &signed{target: pub, own: true}, nil
		default:
			x, ok := c.cherry(ctx, pub, sha, base)
			switch {
			case ok && x == sha:
				return nil, "", &signed{target: pub, via: "cherry"}, nil
			case ok:
				mapped[x] = pub
				from, via = []string{x}, "cherry"
			default:
				// Whatever `force` says: a signed push that cannot pair cleanly publishes nothing
				// (ADR-0067). `force` replaces a remote whose branch moved, never a pairing.
				d, o := diverged(sha, pub, fmt.Sprintf("the published commit %s is not in the history of the Agent's %s, "+
					"and no fallback pairs it", short(pub), short(sha)))
				return nil, "", d, o
			}
		}
	}

	return from, via, nil, nil
}

// ownSquash says whether the published tip pub is this squash's exact image of the Agent's sha:
// the source's tree, author line and encoding, the Machine's message, and as its one parent the
// newest pair's published commit — on a first push, the merge base with the base — as sign makes
// it. Only the committer's date and the signature can differ. A full comparison, not a pairing.
func (c *call) ownSquash(ctx context.Context, pub, sha string, base []string) bool {
	if c.spec.Squash == nil {
		return false
	}
	parent := ""
	if n := len(c.spec.Pairs); n > 0 {
		parent = c.spec.Pairs[n-1].Published
	} else if len(base) > 0 {
		parent, _ = c.repo.Line(ctx, append([]string{"merge-base", sha}, base...)...)
	}
	tip, err1 := c.read(ctx, pub)
	source, err2 := c.read(ctx, sha)
	if err1 != nil || err2 != nil {
		return false
	}
	return tip.tree == source.tree && tip.author == source.author && tip.encoding == source.encoding &&
		tip.message == squashMessage(*c.spec.Squash) && slices.Equal(tip.parents, nonEmpty(parent))
}

// squashMessage is the squashed commit's message: the Machine's, ending in a newline.
func squashMessage(msg string) string {
	if !strings.HasSuffix(msg, "\n") {
		msg += "\n"
	}
	return msg
}

func diverged(sha, pub, reason string) (*signed, *wire.Output) {
	return nil, &wire.Output{Outcome: wire.OutcomeDiverged, Reason: reason + "; nothing was pushed",
		Push: &wire.PushResult{Published: pub, Source: sha}}
}

func ptr(o wire.Output) *wire.Output { return &o }

func short(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}

type commit struct {
	tree, author, encoding, message string
	parents                         []string
}

// read parses one commit object: its tree, parents, author line (the Agent's, kept whole: author
// date from the Agent), encoding, and message bytes. A gpgsig or mergetag header is dropped.
func (c *call) read(ctx context.Context, id string) (*commit, error) {
	raw, err := c.repo.Git(ctx, nil, "cat-file", "commit", id)
	if err != nil {
		return nil, fmt.Errorf("commit %s could not be read", short(id))
	}
	head, msg, _ := strings.Cut(string(raw), "\n\n")
	out := &commit{message: msg}
	for line := range strings.SplitSeq(head, "\n") {
		key, value, _ := strings.Cut(line, " ")
		switch key {
		case "tree":
			out.tree = value
		case "parent":
			out.parents = append(out.parents, value)
		case "author":
			out.author = value
		case "encoding":
			out.encoding = value
		}
	}
	if out.tree == "" || out.author == "" {
		return nil, fmt.Errorf("commit %s has no tree or author", short(id))
	}
	return out, nil
}

// write makes one commit object, signed by s, and answers its id. With no s it is unsigned (a
// squash without sign), committed by the entry's committer, else by its signer's identity.
func (c *call) write(ctx context.Context, s *signerKey, tree string, parents []string, author, encoding,
	message string) (string, error) {
	var body bytes.Buffer
	fmt.Fprintf(&body, "tree %s\n", tree)
	for _, p := range parents {
		fmt.Fprintf(&body, "parent %s\n", p)
	}
	now := time.Now
	if c.r.Now != nil {
		now = c.r.Now
	}
	fmt.Fprintf(&body, "author %s\n", author)
	// A signed commit's committer is the signer's; an unsigned squash's the entry's committer, or
	// the signer's identity when the entry names no committer (ADR-0067).
	name, email := "", ""
	if s != nil || c.entry.Committer == nil {
		name, email = c.entry.Sign.Name, c.entry.Sign.Email
	} else {
		name, email = c.entry.Committer.Name, c.entry.Committer.Email
	}
	fmt.Fprintf(&body, "committer %s <%s> %d +0000\n", name, email, now().Unix())
	if encoding != "" {
		fmt.Fprintf(&body, "encoding %s\n", encoding)
	}
	headers := body.String()
	payload := headers + "\n" + message
	if s == nil {
		id, err := c.repo.Git(ctx, strings.NewReader(payload), "hash-object", "-t", "commit", "-w", "--stdin")
		if err != nil {
			return "", errors.New("the squashed commit could not be written")
		}
		return strings.TrimSpace(string(id)), nil
	}
	sig, err := s.sign(ctx, payload)
	if err != nil {
		return "", err
	}
	sig = strings.TrimRight(sig, "\n")
	signedObj := headers + "gpgsig " + strings.ReplaceAll(sig, "\n", "\n ") + "\n\n" + message
	id, err := c.repo.Git(ctx, strings.NewReader(signedObj), "hash-object", "-t", "commit", "-w", "--stdin")
	if err != nil {
		return "", errors.New("a signed commit could not be written")
	}
	return strings.TrimSpace(string(id)), nil
}

// signerKey signs a payload with the entry's key: ssh by default, GPG when the entry says so.
type signerKey struct {
	c     *call
	ssh   string // the key's copy, for ssh-keygen -Y sign
	gnupg string // the GPG home, for gpg
}

func (c *call) signer(ctx context.Context) (*signerKey, error) {
	s := c.entry.Sign
	dir := filepath.Join(c.r.GitRoot, s.SSHKey+s.GPGKey)
	if s.SSHKey != "" {
		key, err := copyKey(filepath.Join(dir, secrets.SignSSHFile), filepath.Join(c.repo.Work, "sign-key"))
		if err != nil {
			return nil, errors.New("the signing key could not be read from this Effector's mount")
		}
		return &signerKey{c: c, ssh: key}, nil
	}
	home := filepath.Join(c.repo.Work, "gnupg")
	if err := os.Mkdir(home, 0o700); err != nil {
		return nil, err
	}
	if err := c.startAgent(ctx, home); err != nil {
		return nil, err
	}
	if _, err := c.tool(ctx, nil, "gpg", "-q", "--batch", "--no-autostart", "--homedir", home, "--import",
		filepath.Join(dir, secrets.SignGPGFile)); err != nil {
		return nil, errors.New("the GPG signing key could not be imported")
	}
	k := &signerKey{c: c, gnupg: home}
	// A key with a passphrase cannot sign here: the first cut takes none, and says so.
	if _, err := k.sign(ctx, "jr2 probe\n"); err != nil {
		return nil, fmt.Errorf("the GPG signing key %q has a passphrase, or does not sign; jr2 signs only with a "+
			"key that has none", s.GPGKey)
	}
	return k, nil
}

func (k *signerKey) sign(ctx context.Context, payload string) (string, error) {
	var out []byte
	var err error
	if k.ssh != "" {
		out, err = k.c.tool(ctx, strings.NewReader(payload), "ssh-keygen", "-q", "-Y", "sign", "-n", "git", "-f", k.ssh)
	} else {
		out, err = k.c.tool(ctx, strings.NewReader(payload), "gpg", "-q", "--batch", "--no-tty", "--no-autostart",
			"--homedir", k.gnupg, "--pinentry-mode", "loopback", "--passphrase", "", "-bsa")
	}
	if err != nil || len(bytes.TrimSpace(out)) == 0 {
		return "", errors.New("the signing key did not sign")
	}
	return string(out), nil
}

// startAgent starts the gpg-agent of this call's GPG home. It runs with `--no-detach`: it forks
// once and keeps the process group this call started it in, which is the Effect's (package
// reaper), so it never leaves the Effect. The agent makes its socket before it forks, so the
// launcher's exit 0 is its readiness: no socket path is read, and no gpgconf runs. gpg is then run
// with `--no-autostart`: no agent detaches behind the call's back.
func (c *call) startAgent(ctx context.Context, home string) error {
	if _, err := gitclean.Look("gpg-agent"); err != nil {
		return errors.New("the push signs with a GPG key, and this Effector's image holds no gpg-agent")
	}
	launcher, err := gitclean.Daemon(ctx, c.repo, "gpg-agent", "--homedir", home, "--daemon", "--no-detach",
		"--disable-scdaemon")
	if err != nil {
		return errors.New("gpg-agent could not be started: " + err.Error())
	}
	c.agentGroup = launcher.Process.Pid
	if err := launcher.Wait(); err != nil {
		return errors.New("gpg-agent did not start: " + err.Error())
	}
	return nil
}

// stopAgent ends the gpg-agent this call started — SIGTERM to its process group, which removes its
// sockets, then SIGKILL if it is still running after a while — and waits until it has exited
// (ADR-0068): only then may a credentialed command's child run beside this Effector again. The
// Effect's settle reaps it.
func (c *call) stopAgent() {
	if c.agentGroup == 0 {
		return
	}
	_ = syscall.Kill(-c.agentGroup, syscall.SIGTERM)
	if !reaper.Gone(c.agentGroup, 5*time.Second) {
		_ = syscall.Kill(-c.agentGroup, syscall.SIGKILL)
		reaper.Gone(c.agentGroup, 5*time.Second)
	}
	c.agentGroup = 0
}

// tool runs one of jr2's programs in the clean environment.
func (c *call) tool(ctx context.Context, stdin io.Reader, name string, args ...string) ([]byte, error) {
	cmdArgs := append([]string{name}, args...)
	return gitclean.Exec(ctx, c.repo, stdin, cmdArgs...)
}

// twinSet is what a commit of a push's new range may pair with: the ledger's pairs — each push's
// source whose published commit the remote still holds, the newest push's when two name one
// source — and the published commits after
// each new commit's merge base with the remote's tip, by cherry's key (a non-merge's stable
// patch-id, author line and message; a merge's tree, non-first parents, author line and message).
// It is read on every push, before anything is signed, whether ancestry found the new commits or
// not: a side branch made before a push and merged after it carries the Agent's unsigned original
// of a commit the remote holds signed, which ancestry calls new. Read-only.
type twinSet struct {
	c      *call
	ledger map[string]string
	byKey  map[string][]string
}

func (c *call) twins(ctx context.Context, list []string, pub string) (*twinSet, error) {
	tw := &twinSet{c: c, ledger: map[string]string{}, byKey: map[string][]string{}}
	if pub == "" || len(list) == 0 {
		return tw, nil
	}
	repo := c.repo
	// Oldest first, so the newest pair of one source is the one kept. A squash's pair names its
	// source alone: an earlier commit of the squashed range has no faithful twin, and a side branch
	// made at it publishes the commits it descends from (ADR-0067).
	for _, pair := range c.spec.Pairs {
		if slices.Contains(list, pair.Source) && (pair.Published == pub || repo.IsAncestor(ctx, pair.Published, pub)) {
			tw.ledger[pair.Source] = pair.Published
		}
	}
	bases := map[string]bool{}
	for _, id := range list {
		if _, ok := tw.ledger[id]; ok {
			continue
		}
		if mb, err := repo.Line(ctx, "merge-base", pub, id); err == nil && mb != "" {
			bases[mb] = true
		}
	}
	// Each base on its own: one base can be another's descendant (a merge's base is the remote's tip
	// itself), and together they would hide what the older one alone shows.
	seen := map[string]bool{}
	for _, twin := range tw.ledger {
		seen[twin] = true
	}
	for _, mb := range slices.Sorted(maps.Keys(bases)) {
		ids, err := repo.Lines(ctx, revList, pub, not, mb)
		if err != nil {
			return nil, errors.New("the published commits could not be listed")
		}
		for _, id := range ids {
			if seen[id] {
				continue
			}
			seen[id] = true
			k, err := c.key(ctx, id)
			if err != nil {
				return nil, err
			}
			tw.byKey[k] = append(tw.byKey[k], id)
		}
	}
	return tw, nil
}

// of answers the published twin of commit id, or "". The ledger's pair is taken as it is: it names
// the one exact commit a push published for id — a signed copy, or a squashed commit whose parent
// is the published base. Any other twin is the first published commit of id's key that is
// a faithful image of it: id's tree, and as parents id's own parents as mapped. The key is read
// with the mapped parents too, so a merge of the Agent's own side branch keys on the published
// copies of its non-first parents, as its published twin does. A key alone is not enough: a commit
// the Agent reverts and applies again has the key of the first one, whose published copy has older
// parents; paired with it, the push would offer that older copy as the new tip. Each published
// commit is taken once.
func (tw *twinSet) of(ctx context.Context, id string, commit *commit, parents []string) (string, error) {
	if twin, ok := tw.ledger[id]; ok {
		return twin, nil
	}
	if len(tw.byKey) == 0 {
		return "", nil
	}
	k, err := tw.c.keyOf(ctx, id, commit, parents)
	if err != nil {
		return "", err
	}
	for i, twin := range tw.byKey[k] {
		ok, err := tw.faithful(ctx, twin, commit.tree, parents)
		if err != nil {
			return "", err
		}
		if ok {
			tw.byKey[k] = slices.Delete(tw.byKey[k], i, i+1)
			return twin, nil
		}
	}
	return "", nil
}

func (tw *twinSet) faithful(ctx context.Context, twin, tree string, parents []string) (bool, error) {
	t, err := tw.c.read(ctx, twin)
	if err != nil {
		return false, err
	}
	return t.tree == tree && slices.Equal(t.parents, parents), nil
}

// --- the cherry fallback -------------------------------------------------------------------------

var nonHex = regexp.MustCompile(`[^0-9a-f]`)

// cherry pairs each published commit after the merge base with ONE Agent commit by a key — a
// non-merge's stable patch-id, author line and message; a merge's tree, non-first parents, author
// line and message. An Agent merge is keyed with its parents as mapped by the pairs made before it,
// as the twin set keys it: its published twin's non-first parents are the published copies. Every
// published commit must pair, the paired Agent commits must all come before any unpaired one, and
// the last paired commit must have the published tip's tree. It answers that commit, which then
// stands for the published tip; read-only.
func (c *call) cherry(ctx context.Context, pub, sha string, base []string) (string, bool) {
	repo := c.repo
	mb, err := repo.Line(ctx, "merge-base", pub, sha)
	if err != nil || mb == "" {
		return "", false
	}
	published, err := repo.Lines(ctx, append([]string{revList, reverse, topoOrder, pub, not, mb}, base...)...)
	if err != nil {
		return "", false
	}
	left := map[string][]string{}
	for _, id := range published {
		k, err := c.key(ctx, id)
		if err != nil {
			return "", false
		}
		left[k] = append(left[k], id)
	}
	agent, err := repo.Lines(ctx, append([]string{revList, reverse, topoOrder, sha, not, mb}, base...)...)
	if err != nil {
		return "", false
	}
	mapped := map[string]string{}
	x, unpaired := mb, false
	for _, id := range agent {
		commit, err := c.read(ctx, id)
		if err != nil {
			return "", false
		}
		parents := make([]string, 0, len(commit.parents))
		for _, p := range commit.parents {
			if m, ok := mapped[p]; ok {
				p = m
			}
			parents = append(parents, p)
		}
		k, err := c.keyOf(ctx, id, commit, parents)
		if err != nil {
			return "", false
		}
		if len(left[k]) > 0 {
			if unpaired {
				return "", false
			}
			mapped[id] = left[k][0]
			left[k] = left[k][1:]
			x = id
		} else {
			unpaired = true
		}
	}
	for _, ids := range left {
		if len(ids) != 0 {
			return "", false
		}
	}
	xt, err1 := repo.Line(ctx, "rev-parse", x+"^{tree}")
	pt, err2 := repo.Line(ctx, "rev-parse", pub+"^{tree}")
	if err1 != nil || err2 != nil || xt != pt {
		return "", false
	}
	return x, true
}

func (c *call) key(ctx context.Context, id string) (string, error) {
	commit, err := c.read(ctx, id)
	if err != nil {
		return "", err
	}
	return c.keyOf(ctx, id, commit, commit.parents)
}

// keyOf is cherry's key of commit id, read with the given parents: a merge's names its tree, its
// non-first parents, its author line and message; a non-merge's names its stable patch-id, author
// line and message, and its parents do not enter it.
func (c *call) keyOf(ctx context.Context, id string, commit *commit, parents []string) (string, error) {
	sum := sha1.Sum([]byte(commit.author + "\n" + strings.TrimRight(commit.message, "\n")))
	meta := hex.EncodeToString(sum[:])
	if len(parents) > 1 {
		return "M " + commit.tree + " " + strings.Join(parents[1:], " ") + " " + meta, nil
	}
	diff, err := c.repo.Git(ctx, nil, "diff-tree", "-p", "--no-ext-diff", "--no-textconv", "--full-index",
		"--root", id)
	if err != nil {
		return "", err
	}
	pid, err := c.repo.Git(ctx, bytes.NewReader(diff), "patch-id", "--stable")
	if err != nil {
		return "", err
	}
	first, _, _ := strings.Cut(strings.TrimSpace(string(pid)), " ")
	if nonHex.MatchString(first) {
		first = ""
	}
	return "P " + first + " " + meta, nil
}
