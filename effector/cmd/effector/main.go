// The Effector (ADR-0068): jr2's own process, which runs for a Machine the Effects that hold an
// Effect secret. A container becomes an Effector by running /opt/jr2/bin/effector as its command:
// the Instance Effector in the jr2-harness Kit image, a Sandbox Effector in the author's image
// (the Sandbox Image by default) beside the Agent in its Sandbox pod.
//
// Its env names only where its own mount holds things — never a value:
//
//	JR2_EFFECTOR_PORT     the listen port (default 8082)
//	JR2_EFFECTOR_KEY      the placement's signing key file (default /run/jr2/effector/key)
//	JR2_EFFECTOR_CONFIG   the targets jr2 up wrote (default /run/jr2/effector/effector.json)
//	JR2_EFFECTOR_SECRETS  the Effect secrets, one file each (default /run/jr2/secrets)
//	JR2_CA_FILE           the instance's caBundle, trusted beside the system roots (optional)
//	JR2_EFFECTOR_WORK     a Sandbox Effector's read-only view of the Agent's /work (unset: none)
//	JR2_EFFECTOR_REPOS    the node's Repo caches, read-only (default /repos)
//	JR2_EFFECTOR_GIT      the git credentials a push spends, a directory each (default /run/jr2/git)
//	JR2_EFFECTOR_SCRATCH  this Effector's own writable scratch (default $HOME)
//	JR2_EFFECTOR_DRAIN_SECONDS  how long a stopping replica waits for its Effects (default 30)
//	POD_NAME, POD_IP      the replica's name and address (the downward API)
//
// `effector git-credential get` is git's credential helper for a token push (package pushkind).
package main

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"log"
	"maps"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/snapwich/jr2/effector/internal/commandkind"
	"github.com/snapwich/jr2/effector/internal/httpkind"
	"github.com/snapwich/jr2/effector/internal/kinds"
	"github.com/snapwich/jr2/effector/internal/pushkind"
	"github.com/snapwich/jr2/effector/internal/scrub"
	"github.com/snapwich/jr2/effector/internal/secrets"
	"github.com/snapwich/jr2/effector/internal/server"
	"github.com/snapwich/jr2/effector/internal/sign"
	"github.com/snapwich/jr2/effector/internal/wire"
)

// allowLocalRemotes lets a push go to a local path. Only this binary's own tests set it (a local
// remote is the tests' remote): nothing in the built binary can, so git's local transport — which
// runs the remote repository's config and hooks — never runs in a pod.
var allowLocalRemotes bool

func main() {
	if len(os.Args) > 1 && os.Args[1] == "git-credential" {
		os.Exit(pushkind.Helper(os.Args[2:], os.Stdin, os.Stdout))
	}
	logger := log.New(os.Stdout, "", log.LstdFlags|log.LUTC)
	if err := run(logger); err != nil {
		logger.Printf("jr2.effector action=exit reason=%q", err.Error())
		os.Exit(1)
	}
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func run(logger *log.Logger) error {
	// Taken first: a request signed before this process started is refused (a replay the process
	// before this one saw), and every request this process can answer is signed after it.
	started := time.Now()
	if len(os.Args) > 1 {
		return errors.New("usage: effector (configured by its env; see ADR-0068)")
	}
	port := env("JR2_EFFECTOR_PORT", "8082")
	rawKey, err := os.ReadFile(env("JR2_EFFECTOR_KEY", "/run/jr2/effector/key"))
	if err != nil {
		return fmt.Errorf("no placement key: %w", err)
	}
	key := []byte(strings.TrimSpace(string(rawKey)))
	if len(key) < 32 {
		return errors.New("the placement key is shorter than 32 bytes")
	}
	config, err := secrets.ReadConfig(env("JR2_EFFECTOR_CONFIG", "/run/jr2/effector/effector.json"))
	if err != nil {
		return err
	}
	secretsDir := env("JR2_EFFECTOR_SECRETS", "/run/jr2/secrets")
	held, err := secrets.Read(secretsDir)
	if err != nil {
		return err
	}
	gitDir := env("JR2_EFFECTOR_GIT", "/run/jr2/git")
	gitHeld, err := secrets.ReadGit(gitDir)
	if err != nil {
		return err
	}
	roots, err := trust(os.Getenv("JR2_CA_FILE"))
	if err != nil {
		return err
	}
	drain, err := strconv.Atoi(env("JR2_EFFECTOR_DRAIN_SECONDS", "30"))
	if err != nil || drain < 0 {
		return errors.New("JR2_EFFECTOR_DRAIN_SECONDS is not a number of seconds")
	}
	hostname, _ := os.Hostname()
	replica := wire.Replica{
		Name:    env("POD_NAME", hostname),
		Address: net.JoinHostPort(env("POD_IP", "127.0.0.1"), port),
	}

	// Every secret this Effector holds is scrubbed, a push's key and token included.
	every := map[string]string{}
	maps.Copy(every, held)
	maps.Copy(every, gitHeld)
	scrubber := scrub.New(every)
	runner, err := kindsFor(config, held, scrubber, roots, secretsDir, gitDir)
	if err != nil {
		return err
	}
	srv := server.New(server.Options{
		// Bound to this replica's address and this process: a start signed for another replica,
		// or before this process started, starts nothing here.
		Verifier: sign.NewVerifier(key, replica.Address, started, nil),
		Runner:   runner,
		Scrubber: scrubber,
		Replica:  replica,
		Log:      logger,
	})
	httpServer := &http.Server{Addr: ":" + port, Handler: srv, ReadHeaderTimeout: 10 * time.Second}

	listener, err := net.Listen("tcp", httpServer.Addr)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(held))
	for name := range held {
		names = append(names, name)
	}
	logger.Printf("jr2.effector ready placement=%s replica=%s secrets=%s targets=%d",
		config.Placement, replica.Name, strings.Join(names, ","), len(config.Targets))

	sweep := time.NewTicker(time.Minute)
	defer sweep.Stop()
	go func() {
		for now := range sweep.C {
			srv.Sweep(now)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	served := make(chan error, 1)
	go func() { served <- httpServer.Serve(listener) }()
	select {
	case err := <-served:
		return err
	case <-stop:
	}
	// SIGTERM: refuse new Effects, finish the ones in flight, and stay until each outcome was read
	// or the drain time is spent — the pod's grace period carries this.
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(drain)*time.Second)
	defer cancel()
	srv.Drain(ctx)
	shutdown, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	return httpServer.Shutdown(shutdown)
}

// kindsFor is this placement's kinds: `http` alone in the Instance Effector; in a Sandbox
// Effector (JR2_EFFECTOR_WORK set) also upload, push and the credentialed command.
func kindsFor(config *secrets.Config, held map[string]string, scrubber *scrub.Scrubber, roots *x509.CertPool,
	secretsDir, gitDir string) (*kinds.Runner, error) {
	work := os.Getenv("JR2_EFFECTOR_WORK")
	r := &kinds.Runner{HTTP: &httpkind.Runner{Secrets: held, Config: config, Scrubber: scrubber, Roots: roots,
		WorkRoot: work}}
	if work == "" {
		return r, nil
	}
	home, _ := os.UserHomeDir()
	scratch := env("JR2_EFFECTOR_SCRATCH", home)
	if scratch == "" {
		return nil, errors.New("a Sandbox Effector needs a writable scratch: JR2_EFFECTOR_SCRATCH or HOME")
	}
	self, err := os.Executable()
	if err != nil {
		return nil, err
	}
	repos := env("JR2_EFFECTOR_REPOS", "/repos")
	r.Push = &pushkind.Runner{Config: config, WorkRoot: work, ReposRoot: repos, GitRoot: gitDir,
		Scratch: filepath.Join(scratch, "push"), Helper: self, CAFile: os.Getenv("JR2_CA_FILE"), Scrubber: scrubber,
		AllowLocal: allowLocalRemotes}
	// A credentialed command's PATH is this container's own, as its image set it: the tools are the
	// author's (ADR-0068).
	r.Command = &commandkind.Runner{Secrets: held, SecretsDir: secretsDir, WorkRoot: work, ReposRoot: repos,
		Scratch: filepath.Join(scratch, "command"), Scrubber: scrubber, Path: os.Getenv("PATH")}
	return r, nil
}

// trust is the system roots plus the instance's caBundle (ADR-0020), when one is mounted.
func trust(caFile string) (*x509.CertPool, error) {
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if caFile == "" {
		return pool, nil
	}
	pem, err := os.ReadFile(caFile)
	if errors.Is(err, os.ErrNotExist) {
		return pool, nil
	}
	if err != nil {
		return nil, err
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("%s holds no PEM certificate", caFile)
	}
	return pool, nil
}
