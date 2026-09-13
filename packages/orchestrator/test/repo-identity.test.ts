// A Repo's identity is its url, normalized (ADR-0051): host plus path, with scheme, user, `.git`,
// a trailing `/`, a default port, and the host's case dropped — so every spelling of one
// repository lands on ONE identity and ONE cache key. The key is what the cluster addresses the
// cache by (the Repo CR's name, the hostPath leaf, `/repos/<key>`), so its shape is a contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { repoIdentity, repoKey } from "../src/repo-identity.ts";

test("every spelling of one repository resolves to one identity — scheme, user, .git, port, host case dropped", () => {
  const spellings = [
    "git@github.com:Acme/App.git",
    "ssh://git@github.com:22/Acme/App.git",
    "git+ssh://git@github.com/Acme/App",
    "https://GitHub.com/Acme/App/",
    "https://user:token@github.com:443/Acme/App.git",
    "  https://github.com//Acme//App.git  ",
    "git://github.com:9418/Acme/App",
    "https://github.com/Acme/App/.git",
    "git@github.com:Acme/App/.git/",
  ];
  for (const url of spellings) assert.equal(repoIdentity(url).identity, "github.com/Acme/App", url);
  assert.equal(new Set(spellings.map(repoKey)).size, 1, "one identity → one key");
});

test("the scheme is named — https, http, ssh (scp-style and git+ssh alike), git, local", () => {
  assert.equal(repoIdentity("https://github.com/a/b").scheme, "https");
  assert.equal(repoIdentity("http://host/x.git").scheme, "http");
  assert.equal(repoIdentity("git@github.com:a/b.git").scheme, "ssh");
  assert.equal(repoIdentity("ssh://git@github.com/a/b").scheme, "ssh");
  assert.equal(repoIdentity("git+ssh://git@github.com/a/b").scheme, "ssh");
  assert.equal(repoIdentity("git://github.com/a/b").scheme, "git");
  assert.equal(repoIdentity("/srv/x.git").scheme, "local");
  assert.equal(repoIdentity("file:///srv/x.git").scheme, "local");
});

test("a non-default port is part of the identity; a default one is not", () => {
  assert.equal(repoIdentity("http://host:8080/x.git").identity, "host:8080/x");
  assert.equal(repoIdentity("http://host:80/x.git").identity, "host/x");
  assert.equal(repoIdentity("ssh://git@github.com:2222/a/b").identity, "github.com:2222/a/b");
  assert.equal(repoIdentity("http://seed.j2-e2e-seed.svc/app.git").identity, "seed.j2-e2e-seed.svc/app");
});

test("path case is kept — hosts are case-insensitive, paths are not", () => {
  assert.notEqual(
    repoIdentity("https://github.com/Acme/App").identity,
    repoIdentity("https://github.com/acme/app").identity,
  );
});

test("a local repository is its absolute path — file:// and a bare path alike, trailing / and .git dropped", () => {
  assert.equal(repoIdentity("file:///srv/x.git").identity, "/srv/x");
  assert.equal(repoIdentity("/srv/x.git/").identity, "/srv/x");
  assert.equal(repoIdentity("/srv//x").identity, "/srv/x");
  assert.equal(repoIdentity("/srv/x/.git").identity, "/srv/x", "the git dir as a segment, no trailing /");
  assert.equal(repoKey("file:///srv/x.git"), repoKey("/srv/x.git/"));
});

test("only ONE trailing .git comes off, and a url whose path is .git alone names no repository", () => {
  assert.equal(repoIdentity("https://host/x.git/.git").identity, "host/x.git");
  assert.throws(() => repoIdentity("https://host/.git"), /has no path/);
});

test("a relative path is refused — a Sandbox has no directory for it to be relative to", () => {
  assert.throws(() => repoIdentity("../infra"), /repo url must be absolute or remote/);
  assert.throws(() => repoIdentity("./x"), /repo url must be absolute or remote/);
  assert.throws(() => repoIdentity("infra"), /repo url must be absolute or remote/);
});

test("a url that begins with `-` is refused — git would read it as an option, and no repository is spelled so", () => {
  // The scp-style user part would otherwise carry anything up to `@`, so `--upload-pack=<command>`
  // resolved to a fenceable identity and reached `git clone` as an option (ADR-0051).
  assert.throws(
    () => repoIdentity("--upload-pack=sh -c evil #@github.com:ourorg/repo"),
    /repo url begins with "-", which git reads as an option/,
  );
  assert.throws(() => repoIdentity("  -x@github.com:ourorg/repo"), /begins with "-"/, "after trim");
  assert.throws(() => repoIdentity("-"), /begins with "-"/);
});

test("`.` and `..` segments resolve in every form — the scp spelling normalizes exactly as the URL forms do", () => {
  // `new URL()` resolves dot segments for `https://` and `ssh://`; the hand-parsed scp form must
  // land on the same identity, or one repository has two caches and a prefix fence on
  // `github.com/ourorg/` admits `github.com/ourorg/../evil/repo` (ADR-0051).
  assert.equal(repoIdentity("git@github.com:ourorg/../evil/repo.git").identity, "github.com/evil/repo");
  assert.equal(repoIdentity("git@github.com:ourorg/./repo").identity, "github.com/ourorg/repo");
  assert.equal(repoIdentity("git@github.com:../../x").identity, "github.com/x", "climbing past the root stops at it");
  assert.equal(
    repoIdentity("git@github.com:ourorg/../evil/repo").identity,
    repoIdentity("https://github.com/ourorg/../evil/repo").identity,
  );
  assert.equal(repoKey("git@github.com:a/../b/repo"), repoKey("ssh://git@github.com/b/repo"), "one key");
  assert.equal(repoIdentity("/srv/a/../x.git").identity, "/srv/x", "local paths too");
  assert.throws(() => repoIdentity("git@github.com:.."), /has no path/);
});

test("an empty url and an unsupported scheme are refused by name", () => {
  assert.throws(() => repoIdentity("   "), /repo url is empty/);
  assert.throws(() => repoIdentity("ftp://host/x.git"), /unsupported scheme "ftp"/);
  assert.throws(() => repoIdentity("https://github.com/"), /has no path/);
});

test("the key is <slug>-<8 hex of sha256(identity)>: a DNS-1123 label of at most 49 chars, slug from the last segment", () => {
  const { identity, key } = repoIdentity("git@github.com:Acme/App.git");
  assert.match(key, /^app-[0-9a-f]{8}$/);
  assert.equal(key, repoKey("https://github.com/Acme/App"));
  assert.equal(identity, "github.com/Acme/App");

  const long = repoIdentity(`https://host/org/${"Very_Long.Name-".repeat(6)}Tail`);
  assert.match(long.key, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "DNS-1123 label");
  assert.ok(long.key.length <= 49, `${long.key.length} chars`);
  assert.equal(long.key.slice(0, "very-long-name-".length), "very-long-name-");

  assert.match(repoIdentity("https://host/_-_").key, /^repo-[0-9a-f]{8}$/, "an empty slug reads `repo`");
  assert.match(repoKey("/srv/x.git"), /^x-[0-9a-f]{8}$/);
});

test("two repositories sharing a last segment get distinct keys — the hash carries the rest", () => {
  assert.notEqual(repoKey("git@github.com:a/app.git"), repoKey("git@github.com:b/app.git"));
});
