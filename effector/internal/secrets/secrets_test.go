package secrets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadTakesEachFileAndOneTrailingNewline(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "jira", "jira-token-value\n")
	write(t, dir, "crlf", "crlf-token-value\r\n")
	write(t, dir, "..data", "kubelet")
	got, err := Read(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["jira"] != "jira-token-value" || got["crlf"] != "crlf-token-value" {
		t.Fatalf("got %v", got)
	}
}

func TestReadFollowsTheKubeletsSymlinks(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "..2026"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "..2026"), "jira", "jira-token-value")
	if err := os.Symlink("..2026", filepath.Join(dir, "..data")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("..data/jira", filepath.Join(dir, "jira")); err != nil {
		t.Fatal(err)
	}
	got, err := Read(dir)
	if err != nil || got["jira"] != "jira-token-value" {
		t.Fatalf("got %v, %v", got, err)
	}
}

// One mount holds both, as the provision projects it: a secret named `git` is a file, and the push
// credentials are the `@git` directory beside it.
func TestASecretNamedGitAndThePushCredentialsShareTheMount(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "git", "git-secret-value")
	if err := os.MkdirAll(filepath.Join(dir, "@git", "push-0"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "@git", "push-0"), "password", "push-token-value")
	write(t, filepath.Join(dir, "@git", "push-0"), "username", "x-access-token")
	got, err := Read(dir)
	if err != nil || len(got) != 1 || got["git"] != "git-secret-value" {
		t.Fatalf("got %v, %v", got, err)
	}
	creds, err := ReadGit(filepath.Join(dir, "@git"))
	if err != nil || len(creds) != 1 || creds["git:push-0/password"] != "push-token-value" {
		t.Fatalf("got %v, %v", creds, err)
	}
	// A file whose name is no secret's is still refused.
	write(t, dir, "@other", "some-value-here")
	if _, err := Read(dir); err == nil || !strings.Contains(err.Error(), "not a secret name") {
		t.Fatalf("got %v", err)
	}
}

// Each entry's own Secret, projected at @git/<its name>/ (ADR-0051): its `entry.json` says
// what it is, and the directory is its push and its signing key both. The list's order breaks a
// tie on the match's length.
func TestTheGitEntriesAreReadOffTheMount(t *testing.T) {
	dir := t.TempDir()
	for name, entry := range map[string]string{
		"jr2-git-push-aaaa": `{"match":"*","order":1,"push":["ssh","token"],"committer":{"name":"jr2 bot","email":"bot@jr2.test"}}`,
		"jr2-git-push-bbbb": `{"match":"github.com/ourorg/","order":0,"push":["ssh"],` +
			`"sign":{"format":"ssh","name":"jr2 bot","email":"bot@example.com"}}`,
	} {
		if err := os.MkdirAll(filepath.Join(dir, name), 0o755); err != nil {
			t.Fatal(err)
		}
		write(t, filepath.Join(dir, name), EntryFile, entry)
	}
	got, err := ReadGitEntries(dir)
	if err != nil || len(got) != 2 {
		t.Fatalf("got %+v, %v", got, err)
	}
	c := &Config{Git: got}
	ssh := c.EntryFor("", "git@github.com:ourorg/app.git")
	if ssh == nil || ssh.Push.SSHKey != "jr2-git-push-bbbb" || ssh.Sign.SSHKey != "jr2-git-push-bbbb" ||
		ssh.Sign.Email != "bot@example.com" {
		t.Fatalf("got %+v", ssh)
	}
	if other := c.EntryFor("", "https://gitlab.com/x/y.git"); other == nil || other.Push.Token != "jr2-git-push-aaaa" ||
		other.Push.SSHKey != "jr2-git-push-aaaa" || other.Sign != nil || other.Committer == nil ||
		other.Committer.Email != "bot@jr2.test" {
		t.Fatalf("got %+v", other)
	}
	for _, bad := range []string{`{"match":"*","order":0,"push":["both"]}`, `{"match":"*","order":0,"push":["ssh"],"x":1}`,
		`{"match":"","order":0,"push":["ssh"]}`, `{"match":"*","order":0,"push":[]}`,
		`{"match":"*","order":0,"push":["ssh"],"sign":{"format":"ssh","name":"","email":"e@x"}}`,
		`{"match":"*","order":0,"push":["ssh"],"committer":{"name":"x","email":""}}`} {
		write(t, filepath.Join(dir, "jr2-git-push-aaaa"), EntryFile, bad)
		if _, err := ReadGitEntries(dir); err == nil {
			t.Errorf("%s was read", bad)
		}
	}
	if got, err := ReadGitEntries(filepath.Join(dir, "absent")); err != nil || got != nil {
		t.Fatalf("no mount: %v %v", got, err)
	}
}

func TestReadRefusesAShortOrEmptyValueByName(t *testing.T) {
	for value, want := range map[string]string{"short": "shorter than 8", "\n": "is empty"} {
		dir := t.TempDir()
		write(t, dir, "tiny", value)
		_, err := Read(dir)
		if err == nil || !strings.Contains(err.Error(), "secret tiny") || !strings.Contains(err.Error(), want) {
			t.Fatalf("value %q: got %v", value, err)
		}
	}
}

func TestNoMountHoldsNothing(t *testing.T) {
	got, err := Read(filepath.Join(t.TempDir(), "absent"))
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestConfigAllowsATargetWithItsSecretsOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "effector.json")
	write(t, filepath.Dir(path), "effector.json",
		`{"version":1,"placement":"instance","targets":[{"scheme":"https","host":"jira.example.com","port":443,"secrets":["jira"]}]}`)
	c, err := ReadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if !c.Allows("https", "JIRA.example.com", 443, []string{"jira"}) {
		t.Fatal("the configured target is refused")
	}
	if !c.Allows("https", "jira.example.com", 443, nil) {
		t.Fatal("the configured target with no secret is refused")
	}
	for _, refused := range [][]any{
		{"https", "evil.example.com", 443, []string{"jira"}},
		{"http", "jira.example.com", 443, []string{"jira"}},
		{"https", "jira.example.com", 8443, []string{"jira"}},
		{"https", "jira.example.com", 443, []string{"github"}},
	} {
		if c.Allows(refused[0].(string), refused[1].(string), refused[2].(int), refused[3].([]string)) {
			t.Fatalf("%v is allowed", refused)
		}
	}
}

func TestConfigRefusesAnUnknownField(t *testing.T) {
	path := filepath.Join(t.TempDir(), "effector.json")
	write(t, filepath.Dir(path), "effector.json", `{"version":1,"placement":"instance","targets":[],"extra":1}`)
	if _, err := ReadConfig(path); err == nil {
		t.Fatal("an unknown field is accepted")
	}
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
