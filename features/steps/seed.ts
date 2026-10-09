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

/** Pinned tags, all multi-arch: `docker manifest inspect` resolves each. */
const GIT_IMAGE = "alpine/git:v2.47.2";
const HTTP_IMAGE = "nginx:1.27-alpine";
const NODE_IMAGE = "node:24-alpine";

/**
 * The echo server an `http` Effect calls (ADR-0068's B3 proof): it answers with every header it
 * received and the url, each in the encodings the Effector scrubs — raw, base64 in both alphabets,
 * percent-encoded, JSON-escaped — and repeats the Authorization and the url in response headers.
 * `/slow/<marker>/<seconds>` holds the answer that long, and every request that carries a
 * `m-…` segment is counted by it: `/count/<marker>` answers how many arrived, which is how a step
 * proves one send across an Orchestrator restart or an Effector rollout (B2.4). Its own port is
 * 8080; nothing about it is secret, and it holds no state but the counts.
 */
export const ECHO_SCRIPT = [
  `const http=require("http");const counts={};`,
  `const forms=(v)=>[["raw",v],["b64",Buffer.from(v).toString("base64")],`,
  `["b64url",Buffer.from(v).toString("base64url")],["pct",encodeURIComponent(v)],`,
  `["json",JSON.stringify(v).slice(1,-1)]];`,
  `http.createServer((req,res)=>{`,
  `const segs=req.url.split("?")[0].split("/");`,
  `if(segs[1]==="count"){res.end(String(counts[segs[2]]||0));return;}`,
  `const marker=segs.find((s)=>s.startsWith("m-"));if(marker)counts[marker]=(counts[marker]||0)+1;`,
  `const wait=segs[1]==="slow"?Number(segs[3]||0)*1000:0;`,
  `let body="";req.on("data",(d)=>body+=d);req.on("end",()=>setTimeout(()=>{`,
  `const lines=[];for(const [k,v] of Object.entries(req.headers))for(const [f,x] of forms(String(v)))lines.push("header "+k+" "+f+" "+x);`,
  `for(const [f,x] of forms(req.url))lines.push("url "+f+" "+x);lines.push("body "+body);`,
  `res.setHeader("content-type","text/plain");res.setHeader("x-echo-authorization",req.headers.authorization||"");`,
  `res.setHeader("x-echo-url",req.url);res.end(lines.join("\\n")+"\\n");},wait));`,
  `}).listen(8080);`,
].join("");

/**
 * The init container's script: make each served repository under `srv` from a work tree at `work`.
 * Idempotent, because it runs again whenever the pod's sandbox restarts — a node restart re-runs
 * init containers on the SAME emptyDir — and the repositories there may hold branches a scenario
 * pushed (ADR-0053). So a repository that exists is kept as it is, and a new one appears at its
 * path only once complete: it is cloned beside it and renamed into place, so a run cut halfway
 * leaves nothing a second run would mistake for done.
 */
export function makeRepoScript(srv = "/srv", work = "/tmp/w"): string {
  const serve = (name: string): string =>
    `[ -d ${srv}/${name} ] || { rm -rf ${srv}/${name}.new && git clone -q --bare ${work} ${srv}/${name}.new && ` +
    `git -C ${srv}/${name}.new update-server-info && mv ${srv}/${name}.new ${srv}/${name}; }`;
  return [
    `rm -rf ${work}`,
    `git init -q -b main ${work}`,
    `echo '# app' > ${work}/README.md`,
    // A small project with ONE failing test (ADR-0066): the @model tier's ticket. `greet()` returns
    // the wrong string, `node --test` says so, and the run's coder is asked to make it pass. Every
    // other tier reads the seed's refs and never its files, so they are indifferent to it.
    `printf '%s\\n' '{ "name": "app", "private": true, "type": "module", "scripts": { "test": "node --test" } }' > ${work}/package.json`,
    `printf '%s\\n' 'export function greet(name) {' '  return "Hello " + name;' '}' > ${work}/greet.js`,
    `printf '%s\\n' 'import test from "node:test";' 'import assert from "node:assert/strict";' 'import { greet } from "./greet.js";' '' 'test("greets by name", () => {' '  assert.equal(greet("ada"), "hello, ada");' '});' '' 'test("greets the world by default", () => {' '  assert.equal(greet(), "hello, world");' '});' > ${work}/test.js`,
    `git -C ${work} add -A`,
    `git -C ${work} -c user.email=e2e@jr2 -c user.name=e2e commit -qm init`,
    serve("app.git"),
    // A SECOND repository, same content, its own identity (ADR-0051): every kind workflow binds
    // `app.git`, so in every scenario's namespace that Repo is bound and `jr2 gc` never evicts it.
    // The eviction scenario needs a Repo nothing binds, and a per-run url spelling `app.git`
    // differently would normalize to the same identity — so it names this one instead.
    serve("other.git"),
    // A THIRD repository, its own project (ADR-0066): the allowed-after-route claim's billing
    // module. `total()` truncates where it must round, so one of its two tests fails with a message
    // that names the defect; the coder can find it, fix it, and run the suite again until it passes.
    `rm -rf ${work}`,
    `git init -q -b main ${work}`,
    `printf '%s\\n' '{ "name": "billing", "private": true, "type": "module", "scripts": { "test": "node --test" } }' > ${work}/package.json`,
    `printf '%s\\n' '// The total in cents of an amount in cents with a tax rate, to the nearest cent.' 'export function total(cents, rate) {' '  return Math.floor(cents * (1 + rate));' '}' > ${work}/billing.js`,
    `printf '%s\\n' 'import test from "node:test";' 'import assert from "node:assert/strict";' 'import { total } from "./billing.js";' '' 'test("a total with no tax is the amount", () => {' '  assert.equal(total(1999, 0), 1999);' '});' '' 'test("a total rounds to the nearest cent", () => {' '  assert.equal(total(1999, 0.075), 2149);' '});' > ${work}/billing.test.js`,
    `git -C ${work} add -A`,
    `git -C ${work} -c user.email=e2e@jr2 -c user.name=e2e commit -qm init`,
    serve("billing.git"),
  ].join(" && ");
}

const MAKE_REPO = makeRepoScript();

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
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: echo
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: echo
  template:
    metadata:
      labels:
        app: echo
    spec:
      containers:
        - name: echo
          image: ${NODE_IMAGE}
          command: ["node", "-e", ${JSON.stringify(ECHO_SCRIPT)}]
          ports:
            - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: echo
  namespace: ${NAMESPACE}
spec:
  selector:
    app: echo
  ports:
    - port: 80
      targetPort: 8080
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
  await kubectl(["--namespace", NAMESPACE, "rollout", "status", "deployment/echo", "--timeout=300s"]);
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
