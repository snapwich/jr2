package main

import (
	"fmt"
	"os"
	"syscall"

	"github.com/snapwich/jr2/effector/internal/harnessenv"
)

// noCore is `effector nocore [--harness-env] -- <path> <argv...>`: the Harness's start (ADR-0076).
// With --harness-env it also gives the program the Harness process's env, not the container's
// (harnessenv.Split): only the names that jr2 composed, without a name that loads code from a path,
// and the whole start env as data for the domain. Without JR2_HARNESS_ENV_NAMES it starts nothing.
// It is a static Go binary, as tini is, so no LD_* name changes what it runs. It sets the core
// file's limit to zero, soft and hard, and execs argv. The Harness process holds the control
// Stand-in and every held secret's Stand-in in its memory, and below Landlock ABI 6 a confined child
// of the same uid can still send it a signal. A signal whose default action dumps core (SIGQUIT,
// SIGABRT, SIGSEGV and the others) must then write no core file where a child can read it — the
// Harness's working folder is `/work` in the stock image. The limit is kept across execve and by
// each child, and no process without CAP_SYS_RESOURCE can raise a hard limit. A core_pattern that
// is a pipe sends the dump to the node, outside the pod.
func noCore(args []string) int {
	harnessEnv := len(args) > 0 && args[0] == "--harness-env"
	if harnessEnv {
		args = args[1:]
	}
	if len(args) < 2 || args[0] != "--" {
		_, _ = fmt.Fprintln(os.Stderr, "usage: effector nocore [--harness-env] -- <path> <argv...>")
		return 2
	}
	env := os.Environ()
	if harnessEnv {
		var err error
		if env, err = harnessenv.Split(env); err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "jr2: the Harness was not started: %v\n", err)
			return 126
		}
	}
	zero := syscall.Rlimit{Cur: 0, Max: 0}
	if err := syscall.Setrlimit(syscall.RLIMIT_CORE, &zero); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "jr2: the Harness was not started: setrlimit(RLIMIT_CORE): %v\n", err)
		return 126
	}
	err := syscall.Exec(args[1], args[1:], env)
	_, _ = fmt.Fprintf(os.Stderr, "jr2: the Harness was not started: %v\n", err)
	return 126
}
