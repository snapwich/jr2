package main

import (
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"

	"github.com/snapwich/jr2/effector/internal/harnessenv"
)

// The Harness starts with no core file (ADR-0076): a dumping signal that a confined child sends it
// writes nothing a child can read, and no process it starts can raise the limit again.
func TestNoCoreStartsItsProgramWithACoreLimitOfZero(t *testing.T) {
	sh, err := exec.LookPath("sh")
	must(t, err)
	out, err := exec.Command(os.Args[0], "nocore", "--", sh, "-c", "ulimit -c; ulimit -H -c; (ulimit -c 1) 2>/dev/null && echo raised; true").CombinedOutput()
	if err != nil {
		t.Fatalf("nocore: %v: %s", err, out)
	}
	if got := strings.Fields(string(out)); strings.Join(got, " ") != "0 0" {
		t.Fatalf("the program's core limit: %q, want soft 0, hard 0 and no raise", out)
	}
}

func TestNoCoreRefusesAStartWithNoProgram(t *testing.T) {
	cmd := exec.Command(os.Args[0], "nocore", "--")
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "usage: effector nocore") {
		t.Fatalf("want the usage refusal, got %v: %s", err, out)
	}
}

// With --harness-env, the program gets the Harness process's env: jr2's names without a code-loading
// one, HOME as the Harness's own (harnessenv.HarnessHome, before node reads it), and the whole
// start env, the container's HOME included, as data. Without JR2_HARNESS_ENV_NAMES nothing starts.
func TestNoCoreHarnessEnvGivesTheProgramTheHarnessEnv(t *testing.T) {
	cmd := exec.Command(os.Args[0], "nocore", "--harness-env", "--", "/usr/bin/env", "env")
	cmd.Env = []string{"JR2_HARNESS_ENV_NAMES=PORT,NODE_OPTIONS,HOME", "PORT=8080", "NODE_OPTIONS=--require /app/x.cjs",
		"LD_LIBRARY_PATH=/app/lib", "HOME=/home/jr2"}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	got := map[string]string{}
	for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		n, v, _ := strings.Cut(l, "=")
		got[n] = v
	}
	if len(got) != 3 || got["PORT"] != "8080" || got["HOME"] != harnessenv.HarnessHome ||
		got[harnessenv.StartEnvName] == "" {
		t.Fatalf("the program's env: %q", out)
	}
	data, err := harnessenv.Decode(got[harnessenv.StartEnvName])
	if err != nil || !slices.Contains(data, "LD_LIBRARY_PATH=/app/lib") ||
		!slices.Contains(data, "NODE_OPTIONS=--require /app/x.cjs") || !slices.Contains(data, "HOME=/home/jr2") {
		t.Fatalf("the start env: %v %q", err, data)
	}
	cmd = exec.Command(os.Args[0], "nocore", "--harness-env", "--", "/usr/bin/env", "env")
	cmd.Env = []string{"PORT=8080"}
	if out, err := cmd.CombinedOutput(); err == nil || !strings.Contains(string(out), "JR2_HARNESS_ENV_NAMES is not set") {
		t.Fatalf("a start with no names: %v %s", err, out)
	}
}
