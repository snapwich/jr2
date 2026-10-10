// Package gittest builds, for tests, the repositories a Sandbox pod holds (ADR-0004, ADR-0051):
// a remote, the node's cache of it, and the Agent's pod-local clone with its branch Worktree —
// `/work/<slot>/default` and `/work/<slot>/<branch>` — and plants in the Agent's repository every
// program git could be made to run. A test then proves that none ran.
package gittest

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Pod is one test's pod-shaped tree.
type Pod struct {
	T      *testing.T
	Root   string
	Remote string // a bare repository, the Binding (file://)
	Cache  string // the node's cache: /repos/<key>
	Work   string // /work
	Slot   string
	Branch string
	GitDir string // /work/<slot>/default/.git — the Agent's common git dir
	Tree   string // /work/<slot>/<branch> — the Agent's Worktree
	Marks  string // where a planted program writes that it ran
}

// Git runs git as a person would, in dir, with a fixed identity and no user config.
func Git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"GIT_AUTHOR_NAME=Agent", "GIT_AUTHOR_EMAIL=agent@example.test",
		"GIT_COMMITTER_NAME=Agent", "GIT_COMMITTER_EMAIL=agent@example.test",
		"GIT_AUTHOR_DATE=1700000000 +0000", "GIT_COMMITTER_DATE=1700000000 +0000")
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("git %s in %s: %v: %s", strings.Join(args, " "), dir, err, stderr.String())
	}
	return strings.TrimSpace(out.String())
}

// NewPod makes a remote with one commit on main, its cache, and the Agent's clone and Worktree
// on branch, as the attach makes them.
func NewPod(t *testing.T, branch string) *Pod {
	t.Helper()
	root := t.TempDir()
	p := &Pod{T: t, Root: root, Slot: "app", Branch: branch, Marks: filepath.Join(root, "marks")}
	p.Remote = filepath.Join(root, "remote.git")
	p.Cache = filepath.Join(root, "repos", "app-key")
	p.Work = filepath.Join(root, "work")
	p.GitDir = filepath.Join(p.Work, p.Slot, "default", ".git")
	p.Tree = filepath.Join(p.Work, p.Slot, strings.ReplaceAll(branch, "/", "-"))
	must(t, os.MkdirAll(p.Marks, 0o755))
	seed := filepath.Join(root, "seed")
	Git(t, root, "init", "-q", "-b", "main", seed)
	must(t, os.WriteFile(filepath.Join(seed, "README.md"), []byte("# app\n"), 0o644))
	Git(t, seed, "add", "-A")
	Git(t, seed, "commit", "-qm", "init")
	Git(t, root, "clone", "-q", "--bare", seed, p.Remote)
	Git(t, root, "clone", "-q", "--mirror", p.Remote, p.Cache)
	Git(t, root, "clone", "-q", "--shared", "--", p.Cache, filepath.Join(p.Work, p.Slot, "default"))
	Git(t, filepath.Join(p.Work, p.Slot, "default"), "worktree", "add", "-q", p.Tree, "-b", branch, "origin/HEAD")
	return p
}

// Commit writes files in the Worktree and commits them; it answers the new tip.
func (p *Pod) Commit(msg string, files map[string]string) string {
	p.T.Helper()
	for name, body := range files {
		must(p.T, os.MkdirAll(filepath.Dir(filepath.Join(p.Tree, name)), 0o755))
		must(p.T, os.WriteFile(filepath.Join(p.Tree, name), []byte(body), 0o644))
	}
	Git(p.T, p.Tree, "add", "-A")
	Git(p.T, p.Tree, "commit", "-q", "--allow-empty", "-m", msg)
	return Git(p.T, p.Tree, "rev-parse", "HEAD")
}

// Tip is the Agent's branch tip, as git reads it.
func (p *Pod) Tip() string { return Git(p.T, p.Tree, "rev-parse", "refs/heads/"+p.Branch) }

// RemoteTip is the remote's ref, or "" when it has none.
func (p *Pod) RemoteTip(ref string) string {
	p.T.Helper()
	cmd := exec.Command("git", "--git-dir="+p.Remote, "rev-parse", "-q", "--verify", ref)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// Plant writes into the Agent's repository every program git could be made to run — hooks in
// .git/hooks and under core.hooksPath, fsmonitor, an alternate-refs command, an ssh command,
// clean/smudge/process filters, a pager, an external diff, a credential helper, a packObjects
// hook — each writing its name under Marks when it runs.
func (p *Pod) Plant() {
	p.T.Helper()
	prog := func(name string) string {
		path := filepath.Join(p.Root, "planted", name)
		must(p.T, os.MkdirAll(filepath.Dir(path), 0o755))
		script := "#!/bin/sh\ntouch '" + filepath.Join(p.Marks, name) + "'\ncat >/dev/null 2>&1 || true\n"
		must(p.T, os.WriteFile(path, []byte(script), 0o755))
		return path
	}
	hooks := []string{"pre-commit", "post-commit", "reference-transaction", "post-checkout", "post-rewrite",
		"pre-push", "pre-rebase", "post-merge", "post-index-change", "pre-auto-gc", "fsmonitor-watchman"}
	for _, h := range hooks {
		must(p.T, os.WriteFile(filepath.Join(p.GitDir, "hooks", h),
			[]byte("#!/bin/sh\ntouch '"+filepath.Join(p.Marks, "hook-"+h)+"'\n"), 0o755))
	}
	hookDir := filepath.Join(p.Root, "planted", "hooks")
	must(p.T, os.MkdirAll(hookDir, 0o755))
	for _, h := range hooks {
		must(p.T, os.WriteFile(filepath.Join(hookDir, h),
			[]byte("#!/bin/sh\ntouch '"+filepath.Join(p.Marks, "hookspath-"+h)+"'\n"), 0o755))
	}
	const off = "false"
	config := [][2]string{
		{"core.hooksPath", hookDir},
		{"core.fsmonitor", prog("fsmonitor")},
		{"core.alternateRefsCommand", prog("alternate-refs")},
		{"core.sshCommand", prog("ssh-command")},
		{"core.gitProxy", prog("git-proxy")},
		{"core.pager", prog("pager")},
		{"core.askPass", prog("askpass")},
		{"core.editor", prog("editor")},
		{"diff.external", prog("diff-external")},
		{"diff.planted.textconv", prog("textconv")},
		{"merge.planted.driver", prog("merge-driver")},
		{"filter.planted.clean", prog("filter-clean")},
		{"filter.planted.smudge", prog("filter-smudge")},
		{"filter.planted.process", prog("filter-process")},
		{"credential.helper", "!" + prog("credential-helper")},
		{"uploadpack.packObjectsHook", prog("pack-objects-hook")},
		{"gpg.program", prog("gpg-program")},
		{"gpg.ssh.program", prog("gpg-ssh-program")},
		{"remote.origin.receivepack", prog("receive-pack")},
		{"remote.origin.uploadpack", prog("upload-pack")},
		{"alias.update-ref", "!" + prog("alias")},
		{"trace2.eventTarget", filepath.Join(p.Marks, "trace2")},
		{"core.logAllRefUpdates", off},
		{"fetch.fsckObjects", off},
		{"transfer.fsckObjects", off},
		{"protocol.allow", "always"},
	}
	for _, kv := range config {
		Git(p.T, p.Tree, "config", kv[0], kv[1])
	}
	must(p.T, os.WriteFile(filepath.Join(p.Tree, ".gitattributes"),
		[]byte("* filter=planted diff=planted merge=planted\n"), 0o644))
}

// Ran lists what the planted programs left: each name that ran.
func (p *Pod) Ran() []string {
	p.T.Helper()
	entries, err := os.ReadDir(p.Marks)
	if err != nil {
		p.T.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
