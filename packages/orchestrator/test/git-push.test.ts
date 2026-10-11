// The push credentials (ADR-0051, B10): one Secret per `git.credentials` entry, never per pod, and
// one refusal rule for `jr2 up` and the provision. In-process, socket-free (ADR-0010).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  declaredPushKinds,
  gitPushPlansOf,
  gitPushSecretName,
  placedPushRefusal,
  pushRefusal,
  type GitPushManifest,
} from "../src/git-push.ts";
import { gitTokenSecretName, type GitCredential } from "../src/config.ts";

const LIST: GitCredential[] = [
  { match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" },
  {
    match: "github.com/ourorg/",
    push: { sshKey: "deploy-key" },
    sign: { gpgKey: "signing", name: "jr2 bot", email: "bot@example.test" },
  },
  { match: "gitlab.com/", token: "UNSET" },
];

test("each entry's push Secret: what it pushes and signs with, in Flux's key names, apart from the clone token's Secret", () => {
  const { plans, skipped } = gitPushPlansOf(LIST, (n) => (n === "JR2_GIT_TOKEN" ? "ghp_0123456789abcdef" : undefined));
  assert.equal(plans.length, 2, "an entry with nothing it can push with is not written");
  const [wild, ours] = plans;
  assert.deepEqual(wild!.entry, { match: "*", order: 0, secret: gitPushSecretName("*"), push: ["ssh", "token"] });
  assert.notEqual(wild!.entry.secret, gitTokenSecretName("*"), "never the cache agent's clone Secret");
  assert.deepEqual(
    wild!.sources.map((s) => [s.key, "literal" in s ? s.literal : `${s.from.secret}/${s.from.key}`]),
    [
      ["entry.json", JSON.stringify({ match: "*", order: 0, push: ["ssh", "token"] })],
      ["identity", "jr2-git-ssh/identity"],
      ["identity.pub", "jr2-git-ssh/identity.pub"],
      ["known_hosts", "jr2-git-ssh/known_hosts"],
      ["username", "x-access-token"],
      ["password", "ghp_0123456789abcdef"],
    ],
  );
  // A `push` field is the push credential alone; the signing key rides the same Secret.
  assert.deepEqual(ours!.entry.push, ["ssh"]);
  assert.equal(ours!.entry.sign, "gpg");
  assert.deepEqual(
    ours!.sources.filter((s) => !("literal" in s)).map((s) => [s.key, "from" in s ? s.from : undefined]),
    [
      ["identity", { secret: "deploy-key", key: "identity" }],
      ["identity.pub", { secret: "deploy-key", key: "identity.pub" }],
      ["known_hosts", { secret: "deploy-key", key: "known_hosts" }],
      ["sign.private.asc", { secret: "signing", key: "private.asc" }],
    ],
  );
  assert.match(String((ours!.sources[0] as { literal: string }).literal), /"sign":\{"format":"gpg","name":"jr2 bot"/);
  assert.match(skipped.get("gitlab.com/") ?? "", /its token's variable UNSET is not set/);
  assert.deepEqual(declaredPushKinds(LIST[2]!), ["token"], "as written, it pushes with its token");
});

test("the provision's refusal reads what jr2 up wrote: the longest match, its kinds, its signing key", () => {
  const manifest: GitPushManifest = {
    version: 1,
    entries: [
      { match: "*", order: 0, secret: "jr2-git-push-a", push: ["ssh", "token"] },
      { match: "github.com/ourorg/", order: 1, secret: "jr2-git-push-b", push: ["ssh"], sign: "gpg" },
    ],
  };
  const at = 'Sandbox "sb" refuses the push of Repo Slot "app" (u)';
  const ok = placedPushRefusal({ at, url: "git@github.com:ourorg/app.git", sign: true }, LIST, manifest);
  assert.ok("entry" in ok && ok.entry.secret === "jr2-git-push-b", "the longest match wins");
  const wild = placedPushRefusal({ at, url: "https://bitbucket.org/x/y.git", sign: false }, LIST, manifest);
  assert.ok("entry" in wild && wild.entry.secret === "jr2-git-push-a", "the wildcard pushes too");
  const https = placedPushRefusal({ at, url: "https://github.com/ourorg/app.git", sign: false }, LIST, manifest);
  assert.ok("refusal" in https && /over https can spend/.test(https.refusal));
  const unsigned = placedPushRefusal({ at, url: "https://bitbucket.org/x/y.git", sign: true }, LIST, manifest);
  assert.ok("refusal" in unsigned && /holds no sign field/.test(unsigned.refusal));
  const unset = placedPushRefusal({ at, url: "https://gitlab.com/x/y.git", sign: false }, LIST, manifest);
  assert.ok(
    "refusal" in unset &&
      /jr2 up placed no push credential for git\.credentials entry "gitlab\.com\/"/.test(unset.refusal),
  );
});

test("an entry whose config signs, and whose Secret jr2 up wrote with no signing key, is refused as that — not as a field to add", () => {
  const manifest: GitPushManifest = {
    version: 1,
    entries: [{ match: "github.com/ourorg/", order: 1, secret: "jr2-git-push-b", push: ["ssh"] }],
  };
  const out = placedPushRefusal({ at: "a push", url: "git@github.com:ourorg/app.git", sign: true }, LIST, manifest);
  assert.ok("refusal" in out);
  assert.match(out.refusal, /jr2 up placed no signing key for git\.credentials entry "github\.com\/ourorg\/"/);
  assert.doesNotMatch(out.refusal, /add sign:/);
});

// Each refusal names a fix; following it must clear the refusal, never trade it for the next one
// (run B3's slice 5 findings: a single-segment match that was not a prefix, http told to add a
// token before it was told https, an ssh-only entry told its https url pushes with a token, and a
// push field told to take a second credential).
test("each push refusal names a fix, and the fix it names is accepted", () => {
  const fixes: {
    name: string;
    list: GitCredential[];
    url: string;
    says: RegExp;
    fixed: { list: GitCredential[]; url: string };
  }[] = [
    {
      name: "no entry, a single-segment url",
      list: [],
      url: "https://gitea.local/app.git",
      says: /add one: git: \{ credentials: \[\{ match: "gitea\.local\/", token:/,
      fixed: { list: [{ match: "gitea.local/", token: "T" }], url: "https://gitea.local/app.git" },
    },
    {
      name: "no entry, ssh with a port",
      list: [],
      url: "ssh://git@host:2222/app.git",
      says: /match: "host:2222\/", sshKey:/,
      fixed: { list: [{ match: "host:2222/", sshKey: "k" }], url: "ssh://git@host:2222/app.git" },
    },
    {
      name: "no entry, http",
      list: [],
      url: "http://git.example.com/org/app.git",
      says: /bind the slot to the https url, and add the entry it then spends: .*match: "git\.example\.com\/org\/", token:/,
      fixed: { list: [{ match: "git.example.com/org/", token: "T" }], url: "https://git.example.com/org/app.git" },
    },
    {
      name: "http, an entry with a token",
      list: [{ match: "*", token: "T" }],
      url: "http://git.example.com/org/app.git",
      says: /bind the slot to the https url \(git\.credentials entry "\*" then pushes with its token\)/,
      fixed: { list: [{ match: "*", token: "T" }], url: "https://git.example.com/org/app.git" },
    },
    {
      name: "http, an ssh-only entry",
      list: [{ match: "git.example.com/", sshKey: "deploy" }],
      url: "http://git.example.com/org/app.git",
      says: /bind the slot to the ssh url \(git\.credentials entry "git\.example\.com\/" then pushes with its ssh key\)/,
      fixed: { list: [{ match: "git.example.com/", sshKey: "deploy" }], url: "git@git.example.com:org/app.git" },
    },
    {
      name: "http, a push sshKey entry",
      list: [{ match: "git.example.com/", push: { sshKey: "deploy" } }],
      url: "http://git.example.com/org/app.git",
      says: /bind the slot to the ssh url/,
      fixed: {
        list: [{ match: "git.example.com/", push: { sshKey: "deploy" } }],
        url: "ssh://git@git.example.com/org/app.git",
      },
    },
    {
      name: "http, an entry with no credential",
      list: [{ match: "*" }],
      url: "http://git.example.com/org/app.git",
      says: /bind the slot to the https url, and add push: \{ token: .* \} to git\.credentials entry "\*"/,
      fixed: { list: [{ match: "*", push: { token: "T" } }], url: "https://git.example.com/org/app.git" },
    },
    {
      name: "https, a push sshKey entry",
      list: [{ match: "git.example.com/", push: { sshKey: "deploy" } }],
      url: "https://git.example.com/org/app.git",
      says: /its push field names an ssh key, and a push field names one credential; bind the slot to the ssh url/,
      fixed: {
        list: [{ match: "git.example.com/", push: { sshKey: "deploy" } }],
        url: "git@git.example.com:org/app.git",
      },
    },
    {
      name: "ssh, a push token entry",
      list: [{ match: "git.example.com/", push: { token: "T" } }],
      url: "git@git.example.com:org/app.git",
      says: /its push field names a token, .*bind the slot to the https url/,
      fixed: {
        list: [{ match: "git.example.com/", push: { token: "T" } }],
        url: "https://git.example.com/org/app.git",
      },
    },
    {
      name: "https, an entry with a clone ssh key only",
      list: [{ match: "*", sshKey: "deploy" }],
      url: "https://git.example.com/org/app.git",
      says: /add token: "<the env var that holds the token>" to it/,
      fixed: { list: [{ match: "*", sshKey: "deploy", token: "T" }], url: "https://git.example.com/org/app.git" },
    },
    {
      name: "ssh, an entry with a clone token only",
      list: [{ match: "*", token: "T" }],
      url: "git@git.example.com:org/app.git",
      says: /add sshKey: "<a Secret with identity and known_hosts>" to it/,
      fixed: { list: [{ match: "*", token: "T", sshKey: "deploy" }], url: "git@git.example.com:org/app.git" },
    },
    {
      name: "https, an entry with no credential",
      list: [{ match: "*" }],
      url: "https://git.example.com/org/app.git",
      says: /add push: \{ token: .* \} to it/,
      fixed: { list: [{ match: "*", push: { token: "T" } }], url: "https://git.example.com/org/app.git" },
    },
  ];
  const signs = (entry: GitCredential) => entry.sign !== undefined;
  for (const c of fixes) {
    const before = pushRefusal({ at: "a push", url: c.url, sign: false }, c.list, declaredPushKinds, signs);
    assert.ok("refusal" in before, `${c.name}: refused`);
    assert.match(before.refusal, c.says, c.name);
    const after = pushRefusal({ at: "a push", url: c.fixed.url, sign: false }, c.fixed.list, declaredPushKinds, signs);
    assert.ok("entry" in after, `${c.name}: the fix is accepted — ${"refusal" in after ? after.refusal : ""}`);
    // The fix keeps what the entry pushed with before.
    const was = c.list.length === 0 ? [] : declaredPushKinds(c.list[0]!);
    for (const kind of was) assert.ok(declaredPushKinds(c.fixed.list[0]!).includes(kind), `${c.name}: keeps ${kind}`);
  }
});

test("at the provision, an http url whose entry's token was unset is told the https url, and the https url then names the unset token", () => {
  const list: GitCredential[] = [{ match: "*", token: "UNSET" }];
  const manifest: GitPushManifest = { version: 1, entries: [] };
  const http = placedPushRefusal({ at: "a push", url: "http://git.example.com/o/a.git", sign: false }, list, manifest);
  assert.ok("refusal" in http);
  assert.match(
    http.refusal,
    /bind the slot to the https url \(git\.credentials entry "\*" then pushes with its token\)/,
  );
  const https = placedPushRefusal(
    { at: "a push", url: "https://git.example.com/o/a.git", sign: false },
    list,
    manifest,
  );
  assert.ok("refusal" in https);
  assert.match(https.refusal, /jr2 up placed no push credential for git\.credentials entry "\*"/);
});
