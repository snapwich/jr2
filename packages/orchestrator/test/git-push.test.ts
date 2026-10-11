// The push credentials (ADR-0051, B10): one Secret per `git.credentials` entry, never per pod, and
// one refusal rule for `jr2 up` and the provision. In-process, socket-free (ADR-0010).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  declaredPushKinds,
  gitPushPlansOf,
  gitPushSecretName,
  placedPushRefusal,
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
