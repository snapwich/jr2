// Package harnessenv splits the Harness container's start env in two (ADR-0076), in
// `effector nocore --harness-env`, before node starts. The Harness process runs jr2's code with the
// control Stand-in in its memory, and node, glibc and OpenSSL each read names from the env that
// load code or configuration from a path: `NODE_OPTIONS=--require /app/x.js`, `LD_PRELOAD`,
// `OPENSSL_CONF`. The image's `ENV` is the image author's, and a path that it names can be a file
// that the domain writes. So:
//
//   - The Harness process gets only the names that jr2 composed for the container: the names in
//     JR2_HARNESS_ENV_NAMES (each name of the container's `env`), and each key of its `envFrom`,
//     which the Orchestrator gives the prefix JR2_ENVFROM_ so that it can be told from the image's
//     own names. Of those, it never gets a name of Denied (or a TZ that names a file).
//   - The domain gets the WHOLE start env, the image's `ENV` included, as it was before: the
//     Harness gets it as data, in one variable (StartEnvName), and makes the domain's env from it.
//     No program reads that name, and its value is base64, so it is never read as a path or code.
//   - The Harness process's HOME is HarnessHome, whatever the start env holds, from before node
//     starts. node reads HOME once, at its start, into the folders where a bare require() looks last
//     (`$HOME/.node_modules`, `$HOME/.node_libraries`). The domain writes its own HOME, so with that
//     HOME a module that the domain planted there runs in the Harness process. The domain keeps the
//     container's HOME, in StartEnvName.
//   - jr2's own names (`JR2_*`) come from the container's `env` alone. An `envFrom` key that starts
//     with `JR2_` stops the start: a shared Secret could otherwise set a switch of jr2's, such as
//     `JR2_MENU_ONLY`. A name that Split writes (StartEnvName, HOME) is never taken from the start
//     env for the Harness process.
//
// An `envFrom` key lands in the start env under its own name. A name that the container's `env`
// also sets keeps the `env` value, as Kubernetes gives `env` the higher place. A name that only the
// image sets gets the `envFrom` value, as it did without the prefix.
package harnessenv

import (
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"strings"
)

const (
	// NamesName lists the names of the container's `env`, comma-separated.
	NamesName = "JR2_HARNESS_ENV_NAMES"
	// EnvFromPrefix is the prefix the Orchestrator puts before each `envFrom` key.
	EnvFromPrefix = "JR2_ENVFROM_"
	// HarnessHome is the Harness process's HOME (ADR-0076): under /run/jr2, which the domain cannot
	// write. The folder does not exist, and no process can make it.
	HarnessHome = "/run/jr2/home"
	// StartEnvName holds the whole start env for the domain: base64 of `NAME=value` entries, each
	// ended by a NUL byte, as /proc/<pid>/environ holds them.
	StartEnvName = "JR2_START_ENV"
	// maxStartEnv is the longest value the kernel takes for one env entry (MAX_ARG_STRLEN, 128 KiB),
	// less the name.
	maxStartEnv = 128*1024 - len(StartEnvName) - 2
)

// Denied are names that the Harness process never gets, whoever set them: each loads code, or
// configuration that can load code, from a path, or writes to a path.
var Denied = map[string]string{
	"NODE_OPTIONS":              "node: flags such as --require, --import, --loader run a file's code",
	"NODE_PATH":                 "node: a folder of modules that a bare require() finds",
	"NODE_COMPILE_CACHE":        "node: a folder of compiled code that node reads and writes",
	"NODE_REPL_EXTERNAL_MODULE": "node: a module that node loads in place of its REPL",
	"NODE_REPL_HISTORY":         "node: a file that the REPL reads and writes",
	"NODE_V8_COVERAGE":          "node: a folder that node writes",
	"NODE_REDIRECT_WARNINGS":    "node: a file that node writes",
	"NODE_ICU_DATA":             "node: an ICU data file that node parses",
	"ICU_DATA":                  "ICU: a data folder that ICU parses",
	"ICU_TIMEZONE_FILES_DIR":    "ICU: a folder of time-zone data that ICU parses",
	"OPENSSL_CONF":              "OpenSSL 3 (node reads it): a configuration that can load a provider or an engine",
	"OPENSSL_CONF_INCLUDE":      "OpenSSL 3: the folder of the configuration's includes",
	"OPENSSL_MODULES":           "OpenSSL 3: the folder that providers load from",
	"OPENSSL_ENGINES":           "OpenSSL: the folder that engines load from",
	"SSLKEYLOGFILE":             "TLS: a file that the session keys are written to",
	"GCONV_PATH":                "glibc: a folder of iconv modules, shared objects that iconv loads",
	"LOCPATH":                   "glibc: a folder of locale data",
	"NLSPATH":                   "glibc: the path of message catalogs",
	"GETCONF_DIR":               "glibc: a folder of getconf programs",
	"HOSTALIASES":               "glibc: a file of host aliases for the resolver",
	"RES_OPTIONS":               "glibc: options of the resolver",
	"LOCALDOMAIN":               "glibc: the search list of the resolver",
	"TZDIR":                     "glibc and ICU: the folder of time-zone files",
	"GLIBC_TUNABLES":            "glibc: tunables of ld.so and malloc",
}

// DeniedPrefixes are name prefixes that the Harness process never gets.
var DeniedPrefixes = map[string]string{
	"LD_":     "ld.so: LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT and the rest load shared objects from a path",
	"MALLOC_": "glibc: MALLOC_TRACE writes a file, and the others tune the allocator",
}

// denied says whether name never reaches the Harness process with value.
func denied(name, value string) bool {
	if _, ok := Denied[name]; ok {
		return true
	}
	for p := range DeniedPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	// TZ names a zone (`UTC`, `Europe/Paris`, found under the system's zone folder) or, with a
	// leading `/` or `:/`, a file of the caller's.
	if name == "TZ" {
		v := strings.TrimPrefix(value, ":")
		return strings.HasPrefix(v, "/") || strings.Contains(v, "..")
	}
	return false
}

// Split is the start env (os.Environ()) made into the Harness process's env: the names jr2
// composed, without a denied one, HOME as HarnessHome, and StartEnvName with the whole start env,
// each `envFrom` key under its own name. An `envFrom` key that starts with `JR2_` is an error.
func Split(environ []string) ([]string, error) {
	vars := map[string]string{}
	var order []string
	for _, kv := range environ {
		name, value, ok := strings.Cut(kv, "=")
		if !ok || name == "" {
			continue
		}
		if _, seen := vars[name]; !seen {
			order = append(order, name)
		}
		vars[name] = value
	}
	rawNames, ok := vars[NamesName]
	if !ok {
		return nil, fmt.Errorf("%s is not set: the Harness cannot tell the names that jr2 composed from the image's, so it "+
			"does not start (ADR-0076)", NamesName)
	}
	composed := map[string]bool{}
	for n := range strings.SplitSeq(rawNames, ",") {
		if n = strings.TrimSpace(n); n != "" {
			composed[n] = true
		}
	}
	// The start env: each `envFrom` key under its own name, below the container's `env`.
	start := map[string]string{}
	fromEnvFrom := map[string]bool{}
	for _, name := range order {
		if !strings.HasPrefix(name, EnvFromPrefix) {
			start[name] = vars[name]
		}
	}
	for _, name := range order {
		key, ok := strings.CutPrefix(name, EnvFromPrefix)
		if !ok || key == "" {
			continue
		}
		if strings.HasPrefix(key, "JR2_") {
			return nil, fmt.Errorf("the harness.envFrom key %s starts with JR2_: jr2's own names come from the "+
				"container's env alone, so the Harness does not start (ADR-0076). Remove the key from that Secret "+
				"or ConfigMap, or give the source a prefix", key)
		}
		if !composed[key] {
			start[key] = vars[name]
		}
		fromEnvFrom[key] = true
	}
	// A name that this function writes is not taken from the start env: an image's ENV that sets
	// StartEnvName would otherwise come first in the Harness's env, and node reads the first.
	delete(start, StartEnvName)
	names := make([]string, 0, len(start))
	for n := range start {
		names = append(names, n)
	}
	slices.Sort(names)

	var data strings.Builder
	var harness []string
	for _, n := range names {
		data.WriteString(n + "=" + start[n] + "\x00")
		if (composed[n] || fromEnvFrom[n]) && n != NamesName && n != "HOME" && !denied(n, start[n]) {
			harness = append(harness, n+"="+start[n])
		}
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(data.String()))
	if len(encoded) > maxStartEnv {
		return nil, errors.New("the container's start env is too long to pass to the Harness as one variable " +
			"(more than about 96 KiB): make the image's ENV, harness.env or harness.envFrom shorter")
	}
	return append(harness, "HOME="+HarnessHome, StartEnvName+"="+encoded), nil
}

// Decode reads StartEnvName's value back into `NAME=value` entries (the tests' and a reader's).
func Decode(value string) ([]string, error) {
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, err
	}
	out := strings.Split(strings.TrimSuffix(string(raw), "\x00"), "\x00")
	if len(out) == 1 && out[0] == "" {
		return nil, nil
	}
	return out, nil
}
