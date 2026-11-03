package harnessenv

import (
	"strings"
	"testing"
)

func envOf(t *testing.T, list []string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, kv := range list {
		n, v, _ := strings.Cut(kv, "=")
		out[n] = v
	}
	return out
}

// The Harness process gets the names that jr2 composed, without a denied one; the domain's data
// holds the whole start env, the image's names included, each envFrom key under its own name.
func TestSplitGivesTheHarnessJr2sNamesAndTheDomainEverything(t *testing.T) {
	start := []string{
		// The image's ENV.
		"PATH=/usr/local/bin:/usr/bin", "NODE_OPTIONS=--require /app/hook.cjs", "LD_LIBRARY_PATH=/app/lib",
		"AWS_CONFIG_FILE=/app/aws", "SHARED=from-the-image", "ONLY_IMAGE=1", "TZ=/app/zone",
		// The container's env, as jr2 composed it.
		"JR2_HARNESS_ENV_NAMES=JR2_HARNESS_JSON,HTTPS_PROXY,NODE_EXTRA_CA_CERTS,LD_PRELOAD,SHARED,PORT",
		"JR2_HARNESS_JSON={}", "HTTPS_PROXY=http://127.0.0.1:8080", "NODE_EXTRA_CA_CERTS=/etc/jr2/ca/ca.crt",
		"LD_PRELOAD=/app/evil.so", "SHARED=from-env", "PORT=8080",
		// harness.envFrom, prefixed by the Orchestrator.
		"JR2_ENVFROM_GOOGLE_CLOUD_PROJECT=p", "JR2_ENVFROM_SHARED=from-envFrom", "JR2_ENVFROM_ONLY_IMAGE=2",
		"JR2_ENVFROM_NODE_OPTIONS=--import /app/x.mjs", "JR2_ENVFROM_TZ=Europe/Paris",
	}
	out, err := Split(start)
	if err != nil {
		t.Fatal(err)
	}
	harness := envOf(t, out)
	data, err := Decode(harness[StartEnvName])
	if err != nil {
		t.Fatal(err)
	}
	delete(harness, StartEnvName)
	want := map[string]string{
		"JR2_HARNESS_JSON": "{}", "HTTPS_PROXY": "http://127.0.0.1:8080", "NODE_EXTRA_CA_CERTS": "/etc/jr2/ca/ca.crt",
		"SHARED": "from-env", "PORT": "8080", "GOOGLE_CLOUD_PROJECT": "p", "ONLY_IMAGE": "2", "TZ": "Europe/Paris",
		"HOME": HarnessHome,
	}
	if len(harness) != len(want) {
		t.Fatalf("the Harness's env: %v, want %v", harness, want)
	}
	for n, v := range want {
		if harness[n] != v {
			t.Errorf("the Harness's %s: %q, want %q (%v)", n, harness[n], v, harness)
		}
	}
	domain := envOf(t, data)
	for n, v := range map[string]string{
		"PATH": "/usr/local/bin:/usr/bin", "NODE_OPTIONS": "--import /app/x.mjs", "LD_LIBRARY_PATH": "/app/lib",
		"LD_PRELOAD": "/app/evil.so", "AWS_CONFIG_FILE": "/app/aws", "SHARED": "from-env", "ONLY_IMAGE": "2",
		"GOOGLE_CLOUD_PROJECT": "p", "TZ": "Europe/Paris", "PORT": "8080",
	} {
		if domain[n] != v {
			t.Errorf("the start env's %s: %q, want %q", n, domain[n], v)
		}
	}
	for n := range domain {
		if strings.HasPrefix(n, EnvFromPrefix) {
			t.Errorf("the start env holds %s under its prefix", n)
		}
	}
}

// Every denied name, and a TZ that names a file, stays out of the Harness's env even when jr2
// composed it; JR2_HARNESS_ENV_NAMES is required.
func TestSplitDeniesEachCodeLoadingNameAndRequiresTheNames(t *testing.T) {
	loaders := []string{"LD_AUDIT", "LD_PRELOAD", "LD_LIBRARY_PATH", "MALLOC_TRACE", "MALLOC_ARENA_MAX"}
	names := make([]string, 0, 1+len(Denied)+len(loaders))
	start := make([]string, 0, 1+len(Denied)+len(loaders))
	names = append(names, "TZ")
	start = append(start, "TZ=:/app/zone")
	for n := range Denied {
		names = append(names, n)
		start = append(start, n+"=/app/x")
	}
	for _, n := range loaders {
		names = append(names, n)
		start = append(start, n+"=/app/x")
	}
	out, err := Split(append(start, NamesName+"="+strings.Join(names, ",")))
	if err != nil {
		t.Fatal(err)
	}
	if got := envOf(t, out); len(got) != 2 || got[StartEnvName] == "" || got["HOME"] != HarnessHome {
		t.Fatalf("a denied name reached the Harness: %v", out)
	}
	if _, err := Split([]string{"PATH=/bin"}); err == nil || !strings.Contains(err.Error(), NamesName) {
		t.Fatalf("a start with no %s: %v", NamesName, err)
	}
	if _, err := Split([]string{NamesName + "=", "BIG=" + strings.Repeat("x", 100*1024)}); err == nil {
		t.Fatal("a start env too long for one variable was passed")
	}
}

// ADR-0076: node reads HOME once, at its start, into Module.globalPaths (`$HOME/.node_modules`,
// `$HOME/.node_libraries`), and the domain writes its HOME. So the Harness process starts with
// HarnessHome, whether jr2 composed a HOME (the fallback seat's /home/jr2), the image set one, or
// none is set; the domain keeps the container's HOME in the start env.
func TestSplitGivesTheHarnessItsOwnHomeBeforeNodeStarts(t *testing.T) {
	for name, start := range map[string][]string{
		"composed":   {NamesName + "=HOME,PORT", "HOME=/home/jr2", "PORT=8080"},
		"image only": {NamesName + "=PORT", "HOME=/home/node", "PORT=8080"},
		"envFrom":    {NamesName + "=PORT", EnvFromPrefix + "HOME=/home/x", "PORT=8080"},
		"none":       {NamesName + "=PORT", "PORT=8080"},
	} {
		out, err := Split(start)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		homes := 0
		for _, kv := range out {
			if strings.HasPrefix(kv, "HOME=") {
				homes++
			}
		}
		harness := envOf(t, out)
		if homes != 1 || harness["HOME"] != HarnessHome {
			t.Errorf("%s: the Harness's HOME: %v, want %s once", name, out, HarnessHome)
		}
		data, err := Decode(harness[StartEnvName])
		if err != nil {
			t.Fatal(err)
		}
		want := map[string]string{"composed": "/home/jr2", "image only": "/home/node", "envFrom": "/home/x", "none": ""}[name]
		if got := envOf(t, data)["HOME"]; got != want {
			t.Errorf("%s: the domain's HOME: %q, want %q", name, got, want)
		}
	}
}

// ADR-0076: jr2's own names come from the container's env alone. An envFrom key that starts with
// JR2_ (a shared Secret's JR2_MENU_ONLY, which would turn the domain off) stops the start, whether
// the kubelet or the image's ENV wrote the mark. A JR2_START_ENV in the start env never reaches the
// Harness ahead of the one Split writes, and is not in the domain's data.
func TestSplitRefusesAJr2EnvFromKeyAndDropsAForgedStartEnv(t *testing.T) {
	for _, key := range []string{"JR2_MENU_ONLY", "JR2_CONFINER", "JR2_START_ENV", "JR2_HARNESS_ENV_NAMES"} {
		_, err := Split([]string{NamesName + "=PORT", "PORT=8080", EnvFromPrefix + key + "=1"})
		if err == nil || !strings.Contains(err.Error(), key) {
			t.Errorf("an envFrom key %s: %v", key, err)
		}
	}
	forged := StartEnvName + "=" + "Rk9SR0VEPTEA" // base64 of "FORGED=1\x00"
	out, err := Split([]string{NamesName + "=PORT," + StartEnvName, "PORT=8080", forged})
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, kv := range out {
		if strings.HasPrefix(kv, StartEnvName+"=") {
			n++
			if kv == forged {
				t.Errorf("the forged %s reached the Harness", StartEnvName)
			}
		}
	}
	if n != 1 {
		t.Fatalf("%d %s entries: %v", n, StartEnvName, out)
	}
	data, err := Decode(envOf(t, out)[StartEnvName])
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := envOf(t, data)[StartEnvName]; ok {
		t.Errorf("the domain's data holds a %s: %v", StartEnvName, data)
	}
}
