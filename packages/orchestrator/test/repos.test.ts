// kubeRepos — the Repo-resource port's MAPPING against the fake API server (ADR-0051, ADR-0063).
// What matters here: `ensure` creates the resource the operator's cache agent will clone, with
// the credential resolved from `git.credentials` into a `secretRef` in Flux's shape; the boot's
// `bind` restates the Machine's resolution and the label `jr2 gc` honors — never the eviction
// clock; a provision's `ensure` moves the clock of what exists — whatever spelling the run
// brought — and restates the credential of a resource nothing binds; `reconcileBound` unlabels
// what no Machine binds any more; and `list` reads the agent's per-node status back into what
// `GET /repos` reports.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gitTokenSecretName } from "../src/config.ts";
import { kubeClient } from "../src/kube-client.ts";
import { repoIdentity } from "../src/repo-identity.ts";
import { kubeRepos, repoStatusOf, type KubeReposOptions } from "../src/repos.ts";
import { fakeKube, type FakeKube } from "./_fake-kube.ts";

const HTTPS = "https://github.com/acme/app.git";
const SSH = "git@github.com:acme/app.git";
const { identity, key } = repoIdentity(HTTPS);
const NOW = new Date("2026-09-13T10:00:00.000Z");

/** The port over a fresh fake API server (or the one given), in namespace `inst`. */
function portOn(api: FakeKube, opts: Omit<KubeReposOptions, "namespace" | "client">) {
  const client = kubeClient({ baseUrl: "https://kube.test", fetch: api.fetch, token: async () => api.token });
  return kubeRepos({ namespace: "inst", client, ...opts });
}

const created = (api: FakeKube): any[] =>
  api.calls.filter((c) => c.method === "POST" && c.target === "repos").map((c) => c.body);
/** Every Secret applied, with its `data` read back as the strings it carries. */
const applied = (api: FakeKube): any[] =>
  api.calls
    .filter((c) => c.contentType === "application/apply-patch+yaml" && c.target.startsWith("secrets/"))
    .map((c) => ({
      ...c.body,
      data: Object.fromEntries(
        Object.entries(c.body.data as Record<string, string>).map(([k, v]) => [k, Buffer.from(v, "base64").toString()]),
      ),
    }));
const patches = (api: FakeKube): any[] =>
  api.calls
    .filter((c) => c.contentType === "application/merge-patch+json" && c.target.startsWith("repos/"))
    .map((c) => c.body);

/** One standing resource in the store — `create` then answers AlreadyExists, `get` answers it. */
function standing(item: object): FakeKube {
  const api = fakeKube();
  api.seed("repos", { metadata: { name: key }, ...item } as never);
  return api;
}

test("ensure(bound) creates the resource: labeled bound, annotated with identity + last-attached, secretRef from the token entry", async () => {
  // The boot's ensure for a Repo a Machine binds. The credential is resolved HERE and carried by
  // the resource — the cache agent reads only the `secretRef`, the operator matches nothing
  // (ADR-0051). An https url under a token entry whose env var is set → the token materializes
  // as a Secret in Flux's shape, and the resource names it.
  const api = fakeKube();
  const port = portOn(api, {
    credentials: [{ match: "github.com/acme/", token: "GH_TOKEN" }],
    env: { GH_TOKEN: "ghp_secret" },
    now: () => NOW,
  });
  await port.ensure({ url: HTTPS, identity, key, bound: true });

  const [secret] = applied(api);
  assert.equal(secret.metadata.name, gitTokenSecretName("github.com/acme/"));
  assert.equal(secret.metadata.namespace, "inst");
  assert.deepEqual(secret.metadata.labels, { "app.kubernetes.io/managed-by": "jr2" });
  assert.deepEqual(secret.data, { username: "x-access-token", password: "ghp_secret" }, "Flux's key names");
  assert.ok(
    api.calls.findIndex((c) => c.target.startsWith("secrets/")) < api.calls.findIndex((c) => c.method === "POST"),
    "the Secret exists before the resource names it",
  );

  const [cr] = created(api);
  assert.equal(cr.apiVersion, "core.jr2.dev/v1alpha1");
  assert.equal(cr.kind, "Repo");
  assert.equal(cr.metadata.name, key, "named by the cache key — never by a human");
  assert.equal(cr.metadata.namespace, "inst");
  assert.deepEqual(cr.metadata.labels, { "jr2.dev/bound": "true" });
  assert.deepEqual(cr.metadata.annotations, {
    "jr2.dev/identity": identity,
    "jr2.dev/last-attached": NOW.toISOString(),
  });
  assert.deepEqual(cr.spec, {
    url: HTTPS,
    secretRef: { name: gitTokenSecretName("github.com/acme/") },
    refreshInterval: "5m",
  });
  assert.deepEqual(patches(api), [], "a fresh create IS the current resolution — nothing to patch");
  assert.ok(api.object("repos", key), "the resource lives in the instance's namespace");
});

test("a token entry whose env var is UNSET writes no secretRef and mints no Secret — the clone is anonymous", async () => {
  const api = fakeKube();
  const port = portOn(api, { credentials: [{ match: "*", token: "JR2_GIT_TOKEN" }], env: {} });
  await port.ensure({ url: HTTPS, identity, key, bound: true });
  assert.deepEqual(applied(api), [], "no value → no Secret");
  assert.equal(created(api)[0].spec.secretRef, undefined);
});

test("an ssh url under an entry naming an sshKey → secretRef IS that Secret, and the port never reads it", async () => {
  // ADR-0047's deploy key: `jr2 up` offered to generate it into the named Secret; here it is only
  // referenced. No `apply` of any kind — the Orchestrator holds no key material.
  const api = fakeKube();
  const port = portOn(api, {
    credentials: [{ match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" }],
    env: { JR2_GIT_TOKEN: "set-but-irrelevant-for-ssh" },
  });
  await port.ensure({ url: SSH, identity, key, bound: true });
  assert.deepEqual(applied(api), [], "the scheme picked sshKey; the token is not spent");
  assert.deepEqual(created(api)[0].spec.secretRef, { name: "jr2-git-ssh" });
});

test("no entry matches → no secretRef; the longest match wins when several do", async () => {
  const api = fakeKube();
  const port = portOn(api, {
    credentials: [
      { match: "*", token: "ANY" },
      { match: "github.com/acme/", token: "ACME" },
    ],
    env: { ANY: "any", ACME: "acme" },
  });
  await port.ensure({ url: HTTPS, identity, key, bound: true });
  assert.equal(applied(api)[0].data.password, "acme", "the longest prefix's token");
  assert.deepEqual(created(api)[0].spec.secretRef, { name: gitTokenSecretName("github.com/acme/") });

  const none = fakeKube();
  await portOn(none, { credentials: [{ match: "gitlab.com/", token: "GL" }], env: { GL: "gl" } }).ensure({
    url: HTTPS,
    identity,
    key,
    bound: true,
  });
  assert.deepEqual(applied(none), []);
  assert.equal(created(none)[0].spec.secretRef, undefined);
});

test("bind() on an EXISTING resource restates the Machine's resolution: label, url, secretRef — never the clock", async () => {
  // A redeploy: the resource is there from the last boot, and this boot's config may have moved
  // the url or the credential. AlreadyExists is tolerated, then ONE merge patch says what the
  // Machine resolves now — `secretRef: null` when the config no longer names a credential, so a
  // dropped entry is not a credential that lingers. `last-attached` is a run's clock: a boot
  // must not move it, or an unbound slot's Repo would age from the last boot, not the last run.
  const api = standing({ spec: { url: HTTPS, secretRef: { name: "old" } } });
  const port = portOn(api, { credentials: [], env: {}, now: () => NOW });
  await port.bind({ url: SSH, identity, key });

  const patch = api.calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.target, `repos/${key}`);
  assert.equal(patch.contentType, "application/merge-patch+json");
  assert.deepEqual(patch.body, {
    metadata: {
      labels: { "jr2.dev/bound": "true" },
      annotations: { "jr2.dev/identity": identity },
    },
    spec: { url: SSH, secretRef: null },
  });
});

test("bind() CREATES a resource with no last-attached — a boot is not an attach; gc dates it from creation", async () => {
  // A Repo the boot created and no run has attached carries no clock. `jr2 gc` falls back to
  // `creationTimestamp` (repo-sweep.ts) once the slot is unbound, and `jr2 status` reports no
  // "last attached" that was really a boot.
  const api = fakeKube();
  const port = portOn(api, { credentials: [], env: {}, now: () => NOW });
  await port.bind({ url: HTTPS, identity, key });
  const [cr] = created(api);
  assert.deepEqual(cr.metadata.labels, { "jr2.dev/bound": "true" });
  assert.deepEqual(cr.metadata.annotations, { "jr2.dev/identity": identity });
  assert.equal(patches(api).length, 0);
});

test("ensure(bound) on an EXISTING resource moves the clock and NOTHING else — two Machines spelling one identity never flip it", async () => {
  // The boot stated the identity with Machine A's https spelling. A run of Machine B, which
  // binds the same repository over ssh, provisions with `bound: true` — and must not rewrite
  // `spec.url` to ssh, nor the next run of A rewrite it back: every rewrite is a generation the
  // cache agent re-points origin and refetches on, and an ssh spelling without a key would leave
  // A's runs attaching stale. So a provision's ensure of what exists is the eviction clock only —
  // no spec, no secretRef, no label — the same patch a per-run ensure sends.
  const runs = [
    { url: SSH, at: new Date("2026-09-13T11:00:00.000Z") },
    { url: HTTPS, at: new Date("2026-09-13T12:00:00.000Z") },
  ];
  for (const run of runs) {
    const api = standing({ spec: { url: HTTPS } });
    const port = portOn(api, { credentials: [{ match: "*", sshKey: "jr2-git-ssh" }], env: {}, now: () => run.at });
    await port.ensure({ url: run.url, identity, key, bound: true });
    assert.deepEqual(patches(api), [{ metadata: { annotations: { "jr2.dev/last-attached": run.at.toISOString() } } }]);
    assert.equal(applied(api).length, 0, "no Secret minted for a resource the run does not write");
    assert.equal(api.object("repos", key).spec.url, HTTPS, "the spelling that stands, stands");
  }
});

test("ensure(bound) CREATES an absent resource labeled bound — a run that outpaces the boot is not on gc's clock", async () => {
  // The boot's bind is never awaited by serving, so a provision can reach the port first, or the
  // boot's create may have been refused. The resource is born here as the Machine's: labeled
  // bound, this spelling's url — and the boot's bind then restates it, so the walk's spelling is
  // still the one that stands.
  const api = fakeKube();
  const port = portOn(api, { credentials: [], env: {}, now: () => NOW });
  await port.ensure({ url: SSH, identity, key, bound: true });
  const [cr] = created(api);
  assert.deepEqual(cr.metadata.labels, { "jr2.dev/bound": "true" });
  assert.equal(cr.spec.url, SSH);
  assert.equal(patches(api).length, 0);
});

test("ensure(per-run) creates if absent: unlabeled, on the clock, this spelling's url", async () => {
  // A run's url at first attach (ADR-0051): the resource is created unlabeled — no Machine binds
  // it, so `jr2 gc` may evict it once `last-attached` ages out. Nothing is read: absent is absent.
  const api = fakeKube();
  const port = portOn(api, { credentials: [{ match: "*" }], env: {}, now: () => NOW });
  await port.ensure({ url: HTTPS, identity, key, bound: false });
  const [cr] = created(api);
  assert.equal(cr.metadata.labels, undefined, "not bound");
  assert.equal(cr.metadata.annotations["jr2.dev/last-attached"], NOW.toISOString());
  assert.equal(cr.spec.url, HTTPS);
  assert.deepEqual(patches(api), []);
});

test("ensure(per-run) of an EXISTING resource nothing binds restates its secretRef against the url that STANDS", async () => {
  // The clone failed with the credential the first attach resolved — none, say — and the user did
  // what the error told them: added the `git.credentials` entry. No boot restates an unbound
  // resource, so the next attach must, or "start the run again" would move the clock and nothing
  // else. The credential is resolved against the STANDING url, not this run's spelling: the
  // resource was born https, this run says ssh, and the cache clones https — so the Secret is
  // the token's, and the url is not rewritten (a rewrite is a generation the cache refetches on).
  const later = new Date("2026-09-14T00:00:00.000Z");
  const api = standing({
    metadata: { name: key, annotations: { "jr2.dev/identity": identity, "jr2.dev/last-attached": NOW.toISOString() } },
    spec: { url: HTTPS, refreshInterval: "5m" },
  });
  const port = portOn(api, {
    credentials: [{ match: "github.com/acme/", token: "GH_TOKEN", sshKey: "jr2-git-ssh" }],
    env: { GH_TOKEN: "ghp_fixed" },
    now: () => later,
  });
  await port.ensure({ url: SSH, identity, key, bound: false });

  const [secret] = applied(api);
  assert.equal(secret.data.password, "ghp_fixed", "the token as the env holds it now — a rotation lands too");
  assert.deepEqual(patches(api), [
    {
      metadata: { annotations: { "jr2.dev/last-attached": later.toISOString() } },
      spec: { secretRef: { name: gitTokenSecretName("github.com/acme/") } },
    },
  ]);
});

test("ensure(per-run) of an EXISTING unbound resource clears a secretRef the config no longer names", async () => {
  const api = standing({
    metadata: { name: key, annotations: { "jr2.dev/identity": identity } },
    spec: { url: HTTPS, secretRef: { name: "jr2-git-deadbeef" } },
  });
  const port = portOn(api, { credentials: [], env: {}, now: () => NOW });
  await port.ensure({ url: HTTPS, identity, key, bound: false });
  assert.deepEqual(applied(api), []);
  assert.equal(api.object("repos", key).spec.secretRef, undefined, "a merge patch's null removed it");
  assert.deepEqual(patches(api), [
    { metadata: { annotations: { "jr2.dev/last-attached": NOW.toISOString() } }, spec: { secretRef: null } },
  ]);
});

test("ensure(per-run) of an EXISTING resource ANOTHER Machine binds moves the clock only — the boot is its writer", async () => {
  // This run's slot is per-run, but the resource is labeled bound: some registered Machine binds
  // the identity, and the boot restates its credential at every deploy. The label decides, not
  // the run's `bound`, so two writers never trade the spec.
  const api = standing({
    metadata: { name: key, labels: { "jr2.dev/bound": "true" }, annotations: { "jr2.dev/identity": identity } },
    spec: { url: HTTPS, secretRef: { name: "the-boots" } },
  });
  const port = portOn(api, {
    credentials: [{ match: "*", token: "GH_TOKEN" }],
    env: { GH_TOKEN: "ghp_x" },
    now: () => NOW,
  });
  await port.ensure({ url: SSH, identity, key, bound: false });
  assert.deepEqual(applied(api), [], "no Secret minted for a resource the run does not write");
  assert.deepEqual(patches(api), [{ metadata: { annotations: { "jr2.dev/last-attached": NOW.toISOString() } } }]);
});

test("a create failure that is not AlreadyExists propagates — the caller announces it", async () => {
  const api = fakeKube();
  api.refuse((c) =>
    c.method === "POST" ? api.status(403, "Forbidden", "repos.core.jr2.dev is forbidden") : undefined,
  );
  const port = portOn(api, { credentials: [], env: {} });
  await assert.rejects(() => port.ensure({ url: HTTPS, identity, key, bound: true }), /Forbidden/);
});

test("reconcileBound unlabels every bound resource whose key the walk no longer names", async () => {
  // A slot unbound since the last deploy — or a Machine deregistered — leaves a resource labeled
  // bound that nothing binds. Only the label moves: the resource stays for `jr2 gc`'s clock.
  const api = fakeKube();
  api.seed("repos", { metadata: { name: "app-11111111", labels: { "jr2.dev/bound": "true" } } });
  api.seed("repos", { metadata: { name: "old-22222222", labels: { "jr2.dev/bound": "true" } } });
  api.seed("repos", { metadata: { name: "run-44444444" } });
  const port = portOn(api, { credentials: [], env: {} });
  await port.reconcileBound(["app-11111111", "new-33333333"]);

  assert.equal(api.listCalls("repos")[0]!.query.labelSelector, "jr2.dev/bound=true", "only the bound ones are read");
  assert.deepEqual(
    api.calls.filter((c) => c.method === "PATCH").map((c) => [c.target, c.body]),
    [["repos/old-22222222", { metadata: { labels: { "jr2.dev/bound": null } } }]],
    "the one nothing binds; the still-bound one is untouched",
  );
  assert.equal(
    api.object("repos", "old-22222222").metadata.labels?.["jr2.dev/bound"],
    undefined,
    "a merge patch's null removes the label",
  );
});

test("reconcileBound on a cluster with no Repo CRD unlabels nothing and does not throw", async () => {
  // An instance that binds nothing runs the reconcile on every boot (server.ts), and
  // `operator.manage: false` without the operator is a cluster where the type is absent. No type,
  // no Repos — the complete answer — so the boot announces no error for a failure that is not one.
  const api = fakeKube();
  // The API server's answer for a kind nothing serves: 404 on the collection itself.
  api.refuse((c) =>
    c.target === "repos" ? api.status(404, "NotFound", "the server could not find the requested resource") : undefined,
  );
  const port = portOn(api, { credentials: [], env: {} });
  await port.reconcileBound([]);
  assert.deepEqual(
    api.calls.filter((c) => c.method === "PATCH"),
    [],
  );
});

test("any other refusal of the bound listing propagates — the boot announces it", async () => {
  const api = fakeKube();
  api.refuse((c) =>
    c.target === "repos" ? api.status(403, "Forbidden", "repos.core.jr2.dev is forbidden") : undefined,
  );
  const port = portOn(api, { credentials: [], env: {} });
  await assert.rejects(() => port.reconcileBound([]), /Forbidden/);
});

test("list() maps the resources — the Orchestrator's metadata and the cache agent's per-node status — to RepoStatus", async () => {
  const items = {
    items: [
      {
        metadata: {
          name: "app-11111111",
          labels: { "jr2.dev/bound": "true" },
          annotations: { "jr2.dev/identity": "github.com/acme/app", "jr2.dev/last-attached": "2026-09-13T10:00:00Z" },
        },
        spec: { url: SSH, refreshInterval: "5m" },
        status: {
          nodes: [
            {
              node: "n1",
              present: false,
              synced: false,
              attempted: "Probe",
              lastAttempt: "2026-09-13T10:00:05Z",
              lastError: "Permission denied (publickey).",
            },
            {
              node: "n2",
              present: true,
              synced: true,
              attempted: "Clone",
              lastAttempt: "2026-09-13T10:00:05Z",
              lastFetched: "2026-09-13T10:00:05Z",
            },
          ],
          conditions: [{ type: "Synced", status: "False" }],
        },
      },
      // A per-run resource nobody has asked a node for yet: no status at all.
      {
        metadata: { name: "x-22222222", annotations: { "jr2.dev/identity": "github.com/nobody/x" } },
        spec: { url: "https://github.com/nobody/x.git" },
      },
    ],
  };
  const api = fakeKube();
  for (const item of items.items) api.seed("repos", item as never);
  const port = portOn(api, { credentials: [], env: {} });
  const listed = await port.list();
  assert.deepEqual(listed, [
    {
      key: "app-11111111",
      url: SSH,
      identity: "github.com/acme/app",
      bound: true,
      lastAttached: "2026-09-13T10:00:00Z",
      nodes: [
        {
          node: "n1",
          present: false,
          synced: false,
          attempted: "Probe",
          lastAttempt: "2026-09-13T10:00:05Z",
          lastError: "Permission denied (publickey).",
        },
        {
          node: "n2",
          present: true,
          synced: true,
          attempted: "Clone",
          lastAttempt: "2026-09-13T10:00:05Z",
          lastFetched: "2026-09-13T10:00:05Z",
        },
      ],
    },
    {
      key: "x-22222222",
      url: "https://github.com/nobody/x.git",
      identity: "github.com/nobody/x",
      bound: false,
      nodes: [],
    },
  ]);
  assert.equal(api.listCalls("repos").length, 1);

  // An empty `lastError` (the agent's "synced" shape) is absent, not an empty string.
  assert.deepEqual(
    repoStatusOf({
      metadata: { name: "k" },
      spec: { url: "u" },
      status: { nodes: [{ node: "n", present: true, synced: true, lastError: "" }] },
    }).nodes,
    [{ node: "n", present: true, synced: true }],
  );
});
