/*
Copyright 2026 Rich Snapp.

SPDX-License-Identifier: MIT
*/

package lfstransfer

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var oidPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// objectPath is where git-lfs keeps an object under a store's `lfs/objects`.
func objectPath(lfsDir, oid string) string {
	return filepath.Join(lfsDir, "objects", oid[0:2], oid[2:4], oid)
}

// holds tells if the store at lfsDir has a file of the object's size at the
// object's path. It does not read the bytes: the transfer agent checks them
// when it copies.
func holds(lfsDir string, obj Object) bool {
	info, err := os.Stat(objectPath(lfsDir, obj.OID))
	return err == nil && info.Mode().IsRegular() && info.Size() == obj.Size
}

// checkout is what the program knows of the clone it runs in.
type checkout struct {
	// common is the git common dir: the clone's `.git`, which its linked
	// worktrees share. Its `lfs/` is the clone's own LFS store.
	common string
	// cache is the node cache, `/repos/<key>`, which the clone borrows from.
	// Its `lfs/` is the store that the cache agent fills.
	cache string
}

func (c checkout) cloneLFS() string { return filepath.Join(c.common, "lfs") }
func (c checkout) cacheLFS() string { return filepath.Join(c.cache, "lfs") }

func findCheckout(dir string) (checkout, error) {
	common, err := gitOut(dir, "rev-parse", "--git-common-dir")
	if err != nil {
		return checkout{}, err
	}
	if common == "" {
		return checkout{}, fmt.Errorf("%s is not a git checkout: git named no common directory", dir)
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(dir, common)
	}
	common = filepath.Clean(common)
	cache, err := cacheOf(common)
	if err != nil {
		return checkout{}, err
	}
	return checkout{common: common, cache: cache}, nil
}

// cacheOf is `/repos/<key>` for the common dir: its first alternate is the
// cache's object store, and the cache is that store's parent. It is the rule
// of uploadpack.CacheDir, which this program does not call because that runs
// git with no safeConfig.
func cacheOf(common string) (string, error) {
	alternates := filepath.Join(common, "objects", "info", "alternates")
	contents, err := os.ReadFile(alternates)
	if err != nil {
		return "", fmt.Errorf("this checkout borrows from no node cache (%s): %w", alternates, err)
	}
	objects, _, _ := strings.Cut(string(contents), "\n")
	objects = strings.TrimSpace(objects)
	if objects == "" {
		return "", fmt.Errorf("this checkout borrows from no node cache (%s names none)", alternates)
	}
	if !filepath.IsAbs(objects) {
		objects = filepath.Join(common, "objects", objects)
	}
	return filepath.Dir(filepath.Clean(objects)), nil
}

// errMismatch is the fault of a cache file whose bytes are not its oid's.
var errMismatch = errors.New("does not match its oid")

// copyOut copies the cache's file of the object to a new temp file under
// `<common>/lfs/tmp/`, and checks the sha256 and the size as it copies. It
// returns the temp file's path. git-lfs MOVES the file that the agent names,
// so the agent never names the cache's own file.
func copyOut(c checkout, obj Object) (string, error) {
	src, err := os.Open(objectPath(c.cacheLFS(), obj.OID))
	if err != nil {
		return "", err
	}
	defer func() { _ = src.Close() }()
	tmpDir := filepath.Join(c.cloneLFS(), "tmp")
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return "", err
	}
	dst, err := createTemp(tmpDir, "jr2-"+obj.OID+"-")
	if err != nil {
		return "", err
	}
	keep := false
	defer func() {
		_ = dst.Close()
		if !keep {
			_ = os.Remove(dst.Name())
		}
	}()
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(dst, hash), src)
	if err != nil {
		return "", err
	}
	if n != obj.Size || hex.EncodeToString(hash.Sum(nil)) != obj.OID {
		return "", fmt.Errorf("the node cache's file of %s (%d bytes) %w", obj.OID, n, errMismatch)
	}
	if err := dst.Close(); err != nil {
		return "", err
	}
	keep = true
	return dst.Name(), nil
}

// safeConfig is given to every git that the program runs. The cut and the
// attach call jr2-lfs in a clone whose .git/config the Agent can write, and
// the cut states that no hook and no filter runs in its window (ADR-0075).
// `check-attr` and `read-tree` read an index, and an index read starts the
// program that core.fsmonitor names. These keys stop that program and every
// hook. The env stops a replace ref from changing which blobs the program
// reads.
var safeConfig = []string{"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"}

// gitCommand is the one way that the program starts git: in dir, with
// safeConfig, GIT_NO_REPLACE_OBJECTS=1 and extra env (KEY=VALUE).
func gitCommand(dir string, extraEnv []string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", append(append([]string(nil), safeConfig...), args...)...)
	cmd.Dir = dir
	cmd.Env = append(append(os.Environ(), "GIT_NO_REPLACE_OBJECTS=1"), extraEnv...)
	return cmd
}

// createTemp makes a new file in dir with mode 0666 less the umask.
// os.CreateTemp makes it 0600, and git-lfs keeps the mode when it moves the
// file into the clone's store. git-lfs's own downloads follow the umask, so
// this copy does too.
func createTemp(dir, prefix string) (*os.File, error) {
	for range 100 {
		var r [8]byte
		if _, err := rand.Read(r[:]); err != nil {
			return nil, err
		}
		name := filepath.Join(dir, prefix+hex.EncodeToString(r[:]))
		f, err := os.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o666)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		return f, err
	}
	return nil, fmt.Errorf("cannot make a temp file in %s", dir)
}

// gitOut runs git in dir and gives its trimmed stdout.
func gitOut(dir string, args ...string) (string, error) {
	cmd := gitCommand(dir, nil, args...)
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(errOut.String())
		if detail == "" {
			detail = err.Error()
		}
		return "", fmt.Errorf("git %s in %s: %s", strings.Join(args, " "), dir, oneLine(detail))
	}
	return strings.TrimSpace(out.String()), nil
}

// gitConfig reads one key of the clone's config. An absent key is empty.
func gitConfig(dir, key string) string {
	v, err := gitOut(dir, "config", "--get", key)
	if err != nil {
		return ""
	}
	return v
}

// identityOf is the Repo identity in origin's fetch url, which the attach
// writes as `ext::<program> %S <identity>` (ADR-0053). git splits an ext::
// url on spaces, and reads `%%` as `%` and `% ` as a space in an argument, so
// this undoes the same escapes. The identity is the argument after `%S`.
func identityOf(url string) string {
	rest, ok := strings.CutPrefix(url, "ext::")
	if !ok {
		return ""
	}
	var args []string
	var cur strings.Builder
	started := false
	for i := 0; i < len(rest); i++ {
		ch := rest[i]
		switch {
		case ch == ' ':
			if started {
				args = append(args, cur.String())
				cur.Reset()
				started = false
			}
		case ch == '%' && i+1 < len(rest):
			started = true
			next := rest[i+1]
			i++
			switch next {
			case '%', ' ':
				cur.WriteByte(next)
			default:
				cur.WriteByte('%')
				cur.WriteByte(next)
			}
		default:
			started = true
			cur.WriteByte(ch)
		}
	}
	if started {
		args = append(args, cur.String())
	}
	for i, a := range args {
		if a == "%S" && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}
