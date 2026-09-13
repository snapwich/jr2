// kubectlRepos — the Repo-resource port's kubectl MAPPING against a fake process seam (ADR-0051).
// What matters here: `ensure` creates the resource the operator's cache agent will clone, with
// the credential resolved from `git.credentials` into a `secretRef` in Flux's shape; a bound
// ensure restates the Machine's resolution and the label `j2 gc` honors, a per-run one only moves
// the eviction clock; `reconcileBound` unlabels what no Machine binds any more; and `list` reads
// the agent's per-node status back into what `GET /repos` reports.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gitTokenSecretName } from "../src/config.ts";
import { repoIdentity } from "../src/repo-identity.ts";
import { kubectlRepos, repoStatusOf } from "../src/repos.ts";
import type { KubectlExec } from "../src/sandbox-kubectl.ts";

type Call = { args: string[]; input?: string };

/** Script kubectl by verb: each handler sees the full argv and returns stdout (or throws). */
function fakeExec(handlers: Record<string, (call: Call) => string>) {
  const calls: Call[] = [];
  const exec: KubectlExec = async (args, opts) => {
    const call = { args, input: opts?.input };
    calls.push(call);
    const handler = handlers[args[0]!];
    if (!handler) throw new Error(`unexpected kubectl ${args[0]}`);
    return { stdout: handler(call), stderr: "" };
  };
  return { exec, calls };
}

const HTTPS = "https://github.com/acme/app.git";
const SSH = "git@github.com:acme/app.git";
const { identity, key } = repoIdentity(HTTPS);
const NOW = new Date("2026-09-13T10:00:00.000Z");

const created = (calls: Call[]): any[] => calls.filter((c) => c.args[0] === "create").map((c) => JSON.parse(c.input!));
const applied = (calls: Call[], kind: string): any[] =>
  calls.filter((c) => c.args[0] === "apply" && c.input!.includes(`"kind":"${kind}"`)).map((c) => JSON.parse(c.input!));
const patches = (calls: Call[]): any[] =>
  calls.filter((c) => c.args[0] === "patch").map((c) => JSON.parse(c.args.at(-1)!));

test("ensure(bound) creates the resource: labeled bound, annotated with identity + last-attached, secretRef from the token entry", async () => {
  // The boot's ensure for a Repo a Machine binds. The credential is resolved HERE and carried by
  // the resource — the cache agent reads only the `secretRef`, the operator matches nothing
  // (ADR-0051). An https url under a token entry whose env var is set → the token materializes
  // as a Secret in Flux's shape, and the resource names it.
  const { exec, calls } = fakeExec({ apply: () => "ok", create: () => "created" });
  const port = kubectlRepos({
    namespace: "inst",
    credentials: [{ match: "github.com/acme/", token: "GH_TOKEN" }],
    env: { GH_TOKEN: "ghp_secret" },
    exec,
    now: () => NOW,
  });
  await port.ensure({ url: HTTPS, identity, key, bound: true });

  const [secret] = applied(calls, "Secret");
  assert.equal(secret.metadata.name, gitTokenSecretName("github.com/acme/"));
  assert.equal(secret.metadata.namespace, "inst");
  assert.deepEqual(secret.metadata.labels, { "app.kubernetes.io/managed-by": "j2" });
  assert.deepEqual(secret.stringData, { username: "x-access-token", password: "ghp_secret" }, "Flux's key names");
  assert.ok(
    calls.findIndex((c) => c.args[0] === "apply") < calls.findIndex((c) => c.args[0] === "create"),
    "the Secret exists before the resource names it",
  );

  const [cr] = created(calls);
  assert.equal(cr.apiVersion, "core.j2.dev/v1alpha1");
  assert.equal(cr.kind, "Repo");
  assert.equal(cr.metadata.name, key, "named by the cache key — never by a human");
  assert.equal(cr.metadata.namespace, "inst");
  assert.deepEqual(cr.metadata.labels, { "j2.dev/bound": "true" });
  assert.deepEqual(cr.metadata.annotations, {
    "j2.dev/identity": identity,
    "j2.dev/last-attached": NOW.toISOString(),
  });
  assert.deepEqual(cr.spec, {
    url: HTTPS,
    secretRef: { name: gitTokenSecretName("github.com/acme/") },
    refreshInterval: "5m",
  });
  assert.deepEqual(patches(calls), [], "a fresh create IS the current resolution — nothing to patch");
  // The namespace rides every call (the resources live beside the Sandboxes that name them).
  for (const c of calls)
    assert.deepEqual(c.args.slice(c.args.indexOf("--namespace"), c.args.indexOf("--namespace") + 2), [
      "--namespace",
      "inst",
    ]);
});

test("a token entry whose env var is UNSET writes no secretRef and mints no Secret — the clone is anonymous", async () => {
  const { exec, calls } = fakeExec({ apply: () => "ok", create: () => "created" });
  const port = kubectlRepos({
    namespace: "inst",
    credentials: [{ match: "*", token: "J2_GIT_TOKEN" }],
    env: {},
    exec,
  });
  await port.ensure({ url: HTTPS, identity, key, bound: true });
  assert.deepEqual(applied(calls, "Secret"), [], "no value → no Secret");
  assert.equal(created(calls)[0].spec.secretRef, undefined);
});

test("an ssh url under an entry naming an sshKey → secretRef IS that Secret, and the port never reads it", async () => {
  // ADR-0047's deploy key: `j2 up` offered to generate it into the named Secret; here it is only
  // referenced. No `apply` of any kind — the Orchestrator holds no key material.
  const { exec, calls } = fakeExec({ apply: () => "ok", create: () => "created" });
  const port = kubectlRepos({
    namespace: "inst",
    credentials: [{ match: "*", token: "J2_GIT_TOKEN", sshKey: "j2-git-ssh" }],
    env: { J2_GIT_TOKEN: "set-but-irrelevant-for-ssh" },
    exec,
  });
  await port.ensure({ url: SSH, identity, key, bound: true });
  assert.deepEqual(applied(calls, "Secret"), [], "the scheme picked sshKey; the token is not spent");
  assert.deepEqual(created(calls)[0].spec.secretRef, { name: "j2-git-ssh" });
});

test("no entry matches → no secretRef; the longest match wins when several do", async () => {
  const { exec, calls } = fakeExec({ apply: () => "ok", create: () => "created" });
  const port = kubectlRepos({
    namespace: "inst",
    credentials: [
      { match: "*", token: "ANY" },
      { match: "github.com/acme/", token: "ACME" },
    ],
    env: { ANY: "any", ACME: "acme" },
    exec,
  });
  await port.ensure({ url: HTTPS, identity, key, bound: true });
  assert.equal(applied(calls, "Secret")[0].stringData.password, "acme", "the longest prefix's token");
  assert.deepEqual(created(calls)[0].spec.secretRef, { name: gitTokenSecretName("github.com/acme/") });

  const none = fakeExec({ apply: () => "ok", create: () => "created" });
  await kubectlRepos({
    namespace: "inst",
    credentials: [{ match: "gitlab.com/", token: "GL" }],
    env: { GL: "gl" },
    exec: none.exec,
  }).ensure({ url: HTTPS, identity, key, bound: true });
  assert.deepEqual(applied(none.calls, "Secret"), []);
  assert.equal(created(none.calls)[0].spec.secretRef, undefined);
});

test("ensure(bound) on an EXISTING resource restates the Machine's resolution: label, clock, url, secretRef", async () => {
  // A redeploy: the resource is there from the last boot, and this boot's config may have moved
  // the credential. AlreadyExists is tolerated, then ONE merge patch says what the Machine
  // resolves now — `secretRef: null` when the config no longer names a credential, so a dropped
  // entry is not a credential that lingers.
  const { exec, calls } = fakeExec({
    apply: () => "ok",
    create: () => {
      throw new Error(`Error from server (AlreadyExists): repos.core.j2.dev "${key}" already exists`);
    },
    patch: () => "patched",
  });
  const port = kubectlRepos({ namespace: "inst", credentials: [], env: {}, exec, now: () => NOW });
  await port.ensure({ url: SSH, identity, key, bound: true });

  const patch = calls.find((c) => c.args[0] === "patch")!;
  assert.deepEqual(patch.args.slice(0, 3), ["patch", "repos.core.j2.dev", key]);
  assert.ok(patch.args.includes("merge"));
  assert.deepEqual(JSON.parse(patch.args.at(-1)!), {
    metadata: {
      labels: { "j2.dev/bound": "true" },
      annotations: { "j2.dev/identity": identity, "j2.dev/last-attached": NOW.toISOString() },
    },
    spec: { url: SSH, secretRef: null },
  });
});

test("ensure(per-run) creates if absent and otherwise only moves the eviction clock", async () => {
  // A run's url at first attach (ADR-0051): the resource is created unlabeled — no Machine binds
  // it, so `j2 gc` may evict it once `last-attached` ages out. Every later attach anywhere finds
  // it and re-stamps the clock; it never rewrites the spec (the first binder's) nor labels it.
  const { exec, calls } = fakeExec({ apply: () => "ok", create: () => "created" });
  const port = kubectlRepos({ namespace: "inst", credentials: [{ match: "*" }], env: {}, exec, now: () => NOW });
  await port.ensure({ url: HTTPS, identity, key, bound: false });
  const [cr] = created(calls);
  assert.equal(cr.metadata.labels, undefined, "not bound");
  assert.equal(cr.metadata.annotations["j2.dev/last-attached"], NOW.toISOString());
  assert.equal(cr.spec.url, HTTPS);

  const again = fakeExec({
    apply: () => "ok",
    create: () => {
      throw new Error("AlreadyExists");
    },
    patch: () => "patched",
  });
  const later = new Date("2026-09-14T00:00:00.000Z");
  await kubectlRepos({ namespace: "inst", credentials: [], env: {}, exec: again.exec, now: () => later }).ensure({
    url: SSH,
    identity,
    key,
    bound: false,
  });
  assert.deepEqual(patches(again.calls), [
    { metadata: { annotations: { "j2.dev/last-attached": later.toISOString() } } },
  ]);
});

test("a create failure that is not AlreadyExists propagates — the caller announces it", async () => {
  const { exec } = fakeExec({
    create: () => {
      throw new Error("Error from server (Forbidden): repos.core.j2.dev is forbidden");
    },
  });
  const port = kubectlRepos({ namespace: "inst", credentials: [], env: {}, exec });
  await assert.rejects(() => port.ensure({ url: HTTPS, identity, key, bound: true }), /Forbidden/);
});

test("reconcileBound unlabels every bound resource whose key the walk no longer names", async () => {
  // A slot unbound since the last deploy — or a Machine deregistered — leaves a resource labeled
  // bound that nothing binds. Only the label moves: the resource stays for `j2 gc`'s clock.
  const listing = {
    items: [
      { metadata: { name: "app-11111111", labels: { "j2.dev/bound": "true" } } },
      { metadata: { name: "old-22222222", labels: { "j2.dev/bound": "true" } } },
    ],
  };
  const { exec, calls } = fakeExec({ get: () => JSON.stringify(listing), label: () => "labeled" });
  const port = kubectlRepos({ namespace: "inst", credentials: [], env: {}, exec });
  await port.reconcileBound(["app-11111111", "new-33333333"]);

  const get = calls[0]!.args;
  assert.deepEqual(get.slice(0, 2), ["get", "repos.core.j2.dev"]);
  assert.ok(get.includes("j2.dev/bound=true"), "only the bound ones are read");
  const labels = calls.filter((c) => c.args[0] === "label").map((c) => c.args);
  assert.deepEqual(
    labels.map((a) => a[2]),
    ["old-22222222"],
    "the one nothing binds; the still-bound one is untouched",
  );
  assert.ok(labels[0]!.includes("j2.dev/bound-"), "kubectl's spelling for removing a label");
});

test("list() maps the resources — the Orchestrator's metadata and the cache agent's per-node status — to RepoStatus", async () => {
  const items = {
    items: [
      {
        metadata: {
          name: "app-11111111",
          labels: { "j2.dev/bound": "true" },
          annotations: { "j2.dev/identity": "github.com/acme/app", "j2.dev/last-attached": "2026-09-13T10:00:00Z" },
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
        metadata: { name: "x-22222222", annotations: { "j2.dev/identity": "github.com/nobody/x" } },
        spec: { url: "https://github.com/nobody/x.git" },
      },
    ],
  };
  const { exec, calls } = fakeExec({ get: () => JSON.stringify(items) });
  const port = kubectlRepos({ namespace: "inst", credentials: [], env: {}, exec });
  assert.deepEqual(await port.list(), [
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
  assert.deepEqual(calls[0]!.args.slice(0, 2), ["get", "repos.core.j2.dev"]);

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

test("the kube context rides every call when given (ADR-0009)", async () => {
  const { exec, calls } = fakeExec({ get: () => JSON.stringify({ items: [] }) });
  await kubectlRepos({ namespace: "inst", context: "kind-j2", credentials: [], env: {}, exec }).list();
  assert.deepEqual(calls[0]!.args.slice(-4, -2), ["--context", "kind-j2"]);
});
