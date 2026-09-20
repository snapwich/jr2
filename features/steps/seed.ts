// The seed Repo the @kind tier's workflows bind (ADR-0051): a bare git repository served over
// HTTP from INSIDE the cluster, so the cache agent on every node can clone it the way it clones
// anything — by url, with no file baked into an image and no path pinned to a node. The tier's
// instance names it by that url (`http://seed.jr2-e2e-seed.svc/app.git`), which is its identity;
// nothing else about it is configured anywhere.
//
// One namespace, one Deployment, one Service, shared by every scenario and every worker: an init
// container makes the repository (one commit on `main`, `update-server-info` for the dumb HTTP
// protocol) into an emptyDir that nginx then serves. Applying is idempotent, so `--parallel`
// workers racing to seed the same cluster converge on the same objects; the wait is per process.
// The namespace outlives the suite on purpose — it is cluster furniture, not a scenario's state,
// and the next run's apply is a no-op.
//
// Since ADR-0053 the repository is also WRITTEN to: a scenario pushes a commit and then asks a pod
// to fetch it. nginx serves the dumb HTTP protocol and accepts no push, so the write goes in
// through a second container that mounts the same volume and idles for `kubectl exec` — the host
// pushes over the container's own filesystem, never over the wire. Every push lands on a branch of
// the pusher's own (`pushToSeed`), so parallel workers sharing this one repository never race for
// a ref, and `main` — the branch every kind workflow's Binding names — is never moved under a
// Sandbox that already cloned it.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** The seed Repo's url — the identity every kind workflow binds and the fence admits. */
export const SEED_URL = "http://seed.jr2-e2e-seed.svc/app.git";
// Two more urls on the same host appear in kind.feature, spelled there rather than here because
// the scenarios read them the way a user types them: `other.git` below, an identity no workflow
// binds (the per-run Repo `jr2 gc` may evict, ADR-0051); and `missing.git`, which nothing serves
// — the fence admits it and every clone fails with git's own words (ADR-0048).

const NAMESPACE = "jr2-e2e-seed";

/** Pinned tags, both multi-arch: `docker manifest inspect` resolves each. */
const GIT_IMAGE = "alpine/git:v2.47.2";
const HTTP_IMAGE = "nginx:1.27-alpine";

const MAKE_REPO = [
  "git init -q -b main /tmp/w",
  "echo '# app' > /tmp/w/README.md",
  "git -C /tmp/w add -A",
  "git -C /tmp/w -c user.email=e2e@jr2 -c user.name=e2e commit -qm init",
  "git clone -q --bare /tmp/w /srv/app.git",
  "git -C /srv/app.git update-server-info",
  // A SECOND repository, same content, its own identity (ADR-0051): every kind workflow binds
  // `app.git`, so in every scenario's namespace that Repo is bound and `jr2 gc` never evicts it.
  // The eviction scenario needs a Repo nothing binds, and a per-run url spelling `app.git`
  // differently would normalize to the same identity — so it names this one instead.
  "git clone -q --bare /tmp/w /srv/other.git",
  "git -C /srv/other.git update-server-info",
].join(" && ");

const MANIFEST = `
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: seed
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: seed
  template:
    metadata:
      labels:
        app: seed
    spec:
      initContainers:
        - name: make-repo
          image: ${GIT_IMAGE}
          command: ["sh", "-ec", ${JSON.stringify(MAKE_REPO)}]
          volumeMounts:
            - name: srv
              mountPath: /srv
      containers:
        - name: http
          image: ${HTTP_IMAGE}
          ports:
            - containerPort: 80
          volumeMounts:
            - name: srv
              mountPath: /usr/share/nginx/html
              readOnly: true
        # The write seat (ADR-0053). Read-write on the same volume nginx reads, commanded to idle:
        # its image's own entrypoint is \`git\`, which would exit at once. Nothing dials it — it
        # exists for \`kubectl exec\`, which is how a scenario pushes without a credential and
        # without a smart HTTP server.
        - name: git
          image: ${GIT_IMAGE}
          command: ["sh", "-ec", "while true; do sleep 3600; done"]
          volumeMounts:
            - name: srv
              mountPath: /srv
      volumes:
        - name: srv
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: seed
  namespace: ${NAMESPACE}
spec:
  selector:
    app: seed
  ports:
    - port: 80
      targetPort: 80
`;

let seeded: Promise<void> | undefined;

/** Make sure the seed is served, once per process; safe to call from every scenario. */
export function ensureSeed(): Promise<void> {
  seeded ??= seed().catch((err: unknown) => {
    seeded = undefined; // let the next scenario try again rather than inherit a failed attempt
    throw err;
  });
  return seeded;
}

async function seed(): Promise<void> {
  // The memo above is per PROCESS, and `--parallel` gives the tier four of them — so four workers
  // apply this manifest at once, against the one piece of cluster-scoped state the tier has (every
  // other object it touches is namespaced per scenario). `kubectl apply` creates with GET-then-POST,
  // so the workers that lose the race are told AlreadyExists — which is not a failure here: the
  // object exists, which is the whole ask of an `ensure`. The rollout wait below is the real
  // rendezvous, and it is idempotent for all four.
  await kubectl(["apply", "-f", "-"], MANIFEST, /* tolerate */ /AlreadyExists/);
  await kubectl(["--namespace", NAMESPACE, "rollout", "status", "deployment/seed", "--timeout=300s"]);
}

function kubectl(args: string[], stdin?: string, tolerate?: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", args, { stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 || (tolerate && tolerate.test(stderr))
        ? resolve()
        : reject(new Error(`kubectl ${args.join(" ")} exited ${code}: ${stderr.trim()} (seeding ${SEED_URL})`)),
    );
    if (stdin !== undefined) child.stdin!.end(stdin);
  });
}

/**
 * Push one commit to the seed, on a branch of the caller's own, and answer its sha (ADR-0053).
 *
 * Everything happens inside the write seat: a throwaway clone of the bare repository over the
 * container's own filesystem, one commit, a push back, and `update-server-info` — which is what
 * the DUMB HTTP protocol reads, so a push nobody re-indexed is a push no cache agent can see.
 * The branch is the caller's, never `main`: parallel workers share this one repository, and a
 * scenario that moved a branch a live Sandbox already cloned would be changing another scenario's
 * remote under it.
 *
 * The sha comes back from the seed itself rather than from the local commit, because what the
 * scenarios assert is that the POD reached the remote's now — and the remote's word for "now" is
 * the only honest source of it.
 */
export async function pushToSeed(branch: string): Promise<string> {
  // The branch rides into a shell line, so its shape is checked rather than quoted around: the
  // callers generate it, and a fixture that can be injected into is a fixture nobody trusts.
  assert.match(branch, /^[a-z0-9][a-z0-9-]{0,40}$/, "a seed branch is a plain lower-case label");
  const script = [
    `w=$(mktemp -d)`,
    `git clone -q /srv/app.git "$w"`,
    `git -C "$w" checkout -q -b ${branch}`,
    `printf '%s\\n' ${branch} > "$w/fetch-probe.txt"`,
    `git -C "$w" add -A`,
    `git -C "$w" -c user.email=e2e@jr2 -c user.name=e2e commit -qm 'a commit the pod must be able to reach'`,
    `git -C "$w" push -q origin ${branch}`,
    `rm -rf "$w"`,
    `git -C /srv/app.git update-server-info`,
    `git -C /srv/app.git rev-parse refs/heads/${branch}`,
  ].join("\n");
  const { stdout } = await exec("kubectl", [
    "--namespace",
    NAMESPACE,
    "exec",
    "deployment/seed",
    "-c",
    "git",
    "--",
    "sh",
    "-ec",
    script,
  ]);
  const sha = stdout.trim().split("\n").pop() ?? "";
  assert.match(sha, /^[0-9a-f]{40}$/, `the seed reported the pushed commit (got ${JSON.stringify(stdout)})`);
  return sha;
}
