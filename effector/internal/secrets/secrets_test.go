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
