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
//
// Since ADR-0067 a push LEAVES a pod for the seed: a Sandbox Effector pushes over ssh. The same
// Deployment runs sshd (from the git image, which carries it) as a third container on the same
// volume, serving `push.git` to the user `git`, port 22 of the same Service. Its keys are made
// in-cluster by an init container, once per pod — the host key, the deploy key the user `git`
// authorizes, and a signing key — so the four `--parallel` workers that apply this manifest at
// once never race to make them; a scenario reads them back (`seedKeys`) into its own namespace's
// Secrets. They are test keys for a test remote, and nothing else trusts them.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pushRemoteLogScript } from "../lib/model-evidence.ts";

const exec = promisify(execFile);

/** The seed Repo's url — the identity every kind workflow binds and the fence admits. */
export const SEED_URL = "http://seed.jr2-e2e-seed.svc/app.git";
/** The seed's push remote (ADR-0067): `push.git`, the same content as `app.git`, over ssh. */
export const PUSH_URL = "ssh://git@seed.jr2-e2e-seed.svc/srv/push.git";
/** The seed's GPG push remote (ADR-0068): `gpg.git`, the same content, over ssh. Its own
 * `git.credentials` entry signs with a GPG key the scenario writes (`jr2.config.ts`). */
export const GPG_PUSH_URL = "ssh://git@seed.jr2-e2e-seed.svc/srv/gpg.git";
/** The host the push remote's known_hosts line names. */
const PUSH_HOST = "seed.jr2-e2e-seed.svc";
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
 * The echo server an `http` Effect calls (ADR-0068's scrubbing proof): it answers with every header it
 * received and the url, each in the encodings the Effector scrubs — raw, base64 in both alphabets,
 * percent-encoded, JSON-escaped — and repeats the Authorization and the url in response headers.
 * `/slow/<marker>/<seconds>` holds the answer that long, and every request that carries a
 * `m-…` segment is counted by it: `/count/<marker>` answers how many arrived, which is how a step
 * proves one send across an Orchestrator restart or an Effector rollout. Its own port is
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
    // The push remote (ADR-0067): the same content, its own identity, written by pushes over ssh.
    serve("push.git"),
    // The GPG push remote (ADR-0068): the same content, its own identity, so its own
    // git.credentials entry signs with GPG while push.git's signs with ssh.
    serve("gpg.git"),
    // A SECOND repository, same content, its own identity (ADR-0051): every kind workflow binds
    // `app.git`, so in every scenario's namespace that Repo is bound and `jr2 gc` never evicts it.
    // The eviction scenario needs a Repo nothing binds, and a per-run url spelling `app.git`
    // differently would normalize to the same identity — so it names this one instead.
    serve("other.git"),
    // A THIRD repository, its own project (ADR-0066): the billing module the command-Effect claims
    // bind (`allowed-after-route`, `answered`; `model-instance/workflows/_seed.ts`). `total()`
    // truncates where it must round, so one of its two tests fails with a message that names the
    // defect, and the Worktree holds nothing else to fix.
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

/** The init container's keys: made once per pod, in its own volume, never on the host. */
const MAKE_KEYS = [
  "mkdir -p /keys",
  "[ -f /keys/host ] || ssh-keygen -q -t ed25519 -N '' -C seed-host -f /keys/host",
  "[ -f /keys/deploy ] || ssh-keygen -q -t ed25519 -N '' -C jr2-e2e-deploy -f /keys/deploy",
  "[ -f /keys/sign ] || ssh-keygen -q -t ed25519 -N '' -C signer@jr2.test -f /keys/sign",
].join(" && ");

/** The ssh seat: the user `git`, the deploy key authorized, `push.git` its own, sshd in front. */
const SERVE_SSH = [
  "id git >/dev/null 2>&1 || adduser -D -u 1001 -s /bin/sh git",
  // Alpine's adduser locks the account (`!`), and sshd refuses a locked account even for a key.
  "sed -i 's/^git:!/git:*/' /etc/shadow",
  "mkdir -p /home/git/.ssh",
  "cp /keys/deploy.pub /home/git/.ssh/authorized_keys",
  "chown -R git:git /home/git /srv/push.git /srv/gpg.git",
  "chmod 700 /home/git/.ssh && chmod 600 /home/git/.ssh/authorized_keys",
  "exec /usr/sbin/sshd -D -e -h /keys/host -o PasswordAuthentication=no -o PermitRootLogin=no -o AllowUsers=git",
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
        - name: make-keys
          image: ${GIT_IMAGE}
          command: ["sh", "-ec", ${JSON.stringify(MAKE_KEYS)}]
          volumeMounts:
            - name: keys
              mountPath: /keys
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
            - name: keys
              mountPath: /keys
              readOnly: true
        # The push remote (ADR-0067): sshd as root, on the same volume, for the user \`git\`.
        - name: ssh
          image: ${GIT_IMAGE}
          command: ["sh", "-ec", ${JSON.stringify(SERVE_SSH)}]
          ports:
            - containerPort: 22
          volumeMounts:
            - name: srv
              mountPath: /srv
            - name: keys
              mountPath: /keys
              readOnly: true
      volumes:
        - name: srv
          emptyDir: {}
        - name: keys
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
    - name: http
      port: 80
      targetPort: 80
    - name: ssh
      port: 22
      targetPort: 22
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
  // The seed lives across runs. Before `pushRemoteBranch` wrote as `git`, it wrote objects as root
  // (see `inSeed`): five root folders in `objects/` refused about one push of three objects in 17.
  // Giving the whole remote back to its owner is idempotent, so each worker does it.
  await inSeed(`chown -R "$(stat -c %u:%g /srv/push.git)" /srv/push.git`);
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

/**
 * Run a script in the seed's write seat, as root, and answer its stdout. `asPushUser` runs it as
 * the user `git` in the push remote's container instead: a script that writes to `push.git` runs
 * so. sshd serves each push as `git`, and git puts each object it receives in `objects/<xx>/`. An
 * object that root writes makes that folder root's when it is new, and each later push with an
 * object there is `[remote rejected] (unable to migrate objects to permanent storage)`.
 */
async function inSeed(script: string, opts: { asPushUser?: boolean } = {}): Promise<string> {
  const run = opts.asPushUser
    ? ["ssh", "--", "su", "git", "-s", "/bin/sh", "-c", `set -e\n${script}`]
    : ["git", "--", "sh", "-ec", script];
  const { stdout } = await exec("kubectl", ["--namespace", NAMESPACE, "exec", "deployment/seed", "-c", ...run]);
  return stdout;
}

/** The push remote's keys, as a scenario's Secrets need them (ADR-0051's ssh Secret shape). */
export async function seedKeys(): Promise<{
  deploy: string;
  deployPub: string;
  sign: string;
  signPub: string;
  knownHosts: string;
}> {
  const read = (file: string) => inSeed(`cat /keys/${file}`);
  const host = (await read("host.pub")).trim().split(/\s+/);
  return {
    deploy: await read("deploy"),
    deployPub: await read("deploy.pub"),
    sign: await read("sign"),
    signPub: await read("sign.pub"),
    knownHosts: `${PUSH_HOST} ${host[0]} ${host[1]}\n`,
  };
}

/** What the push remote holds on a branch, or "" when it has none. */
export async function pushRemoteTip(branch: string): Promise<string> {
  assert.match(branch, /^[a-z0-9][a-z0-9/-]{0,60}$/, "a branch is a plain lower-case label");
  const out = await inSeed(
    `git -c safe.directory='*' -C /srv/push.git rev-parse -q --verify refs/heads/${branch} || true`,
  );
  return out.trim();
}

/** How many commits the push remote holds from `main` to `commit`: what a push of it carried. */
export async function pushRemoteCommitsFromMain(commit: string): Promise<number> {
  assert.match(commit, /^[0-9a-f]{40}$/);
  const out = await inSeed(`git -c safe.directory='*' -C /srv/push.git rev-list --count main..${commit}`);
  const n = Number(out.trim());
  assert.ok(Number.isInteger(n), `rev-list --count answered ${JSON.stringify(out)}`);
  return n;
}

/** The push remote's log from `main` to `commit`, one line per commit (ADR-0066's kept evidence). */
export async function pushRemoteLogFromMain(commit: string): Promise<string> {
  return inSeed(pushRemoteLogScript(commit));
}

/** The GPG push remote's branch tip and that commit's raw object, or "" for both when it has none. */
export async function gpgRemoteCommit(branch: string): Promise<{ tip: string; raw: string }> {
  assert.match(branch, /^[a-z0-9][a-z0-9-]{0,60}$/, "a branch is a plain lower-case label");
  const out = await inSeed(
    `t=$(git -c safe.directory='*' -C /srv/gpg.git rev-parse -q --verify refs/heads/${branch} || true); ` +
      `echo "TIP $t"; [ -z "$t" ] || git -c safe.directory='*' -C /srv/gpg.git cat-file commit "$t"`,
  );
  const [first, ...rest] = out.split("\n");
  return { tip: (first ?? "").replace(/^TIP ?/, "").trim(), raw: rest.join("\n") };
}

/**
 * Verify a commit on the push remote with the seed's signing key as the one allowed signer, and
 * answer its author and committer lines — what a forge checks, done by git itself in the pod.
 */
export async function verifyOnPushRemote(commit: string): Promise<{ verified: boolean; who: string; out: string }> {
  assert.match(commit, /^[0-9a-f]{40}$/);
  const script = [
    `printf 'signer@jr2.test namespaces="git" %s\\n' "$(cat /keys/sign.pub)" > /tmp/allowed_signers`,
    `if git -c safe.directory='*' -c gpg.ssh.allowedSignersFile=/tmp/allowed_signers -C /srv/push.git verify-commit ${commit} 2>/tmp/verify.out; then echo VERIFIED; else echo UNVERIFIED; fi`,
    `cat /tmp/verify.out`,
    `git -c safe.directory='*' -C /srv/push.git log -1 --format='WHO %an <%ae>|%cn <%ce>' ${commit}`,
  ].join("\n");
  const out = await inSeed(script);
  return {
    verified: out.includes("VERIFIED") && !out.includes("UNVERIFIED"),
    who: (out.split("\n").find((l) => l.startsWith("WHO ")) ?? "").slice(4),
    out,
  };
}

/** A commit on a new branch of the push remote: a colleague's open pull request. */
export async function pushRemoteBranch(branch: string): Promise<string> {
  assert.match(branch, /^[a-z0-9][a-z0-9/-]{0,60}$/, "a branch is a plain lower-case label");
  // As the push remote's user: the commit's object, its ref and its log are `git`'s, as a push makes them.
  const out = await inSeed(
    [
      `cd /srv/push.git`,
      `git -c user.email=e2e@jr2 -c user.name=e2e commit-tree -m 'a colleague' -p refs/heads/main 'refs/heads/main^{tree}' > /tmp/c.$$`,
      `git update-ref refs/heads/${branch} $(cat /tmp/c.$$)`,
      `cat /tmp/c.$$; rm /tmp/c.$$`,
    ].join("\n"),
    { asPushUser: true },
  );
  return out.trim();
}

/** `large.git` beside `app.git`, once per seed: thousands of files, commits and refs. A cluster's
 * furniture, as `app.git` is, and made here, because only the load needs it. Parallel workers can
 * each start a build, so each one builds under a temporary name and renames at the end: while a
 * build runs, `large.git` does not exist, and a worker that loses the rename removes its copy. */
export async function ensureLargeSeed(): Promise<void> {
  await inSeed(
    [
      `[ -e /srv/large.git/HEAD ] && exit 0`,
      `t=/srv/.large-$$.git`,
      `git init -q -b main --bare "$t"`,
      `cd "$t"`,
      `git config http.receivepack false`,
      `awk 'BEGIN { for (c = 1; c <= 1500; c++) { print "commit refs/heads/main"; print "committer e <e@e> " 1700000000 + c " +0000"; print "data 1"; print "x"; for (f = 0; f < (c == 1 ? 20000 : 5); f++) { n = (c == 1 ? f : (c * 7 + f * 13) % 20000); print "M 100644 inline d" n % 200 "/f" n ".txt"; d = "line " c " " f; for (i = 0; i < 40; i++) d = d " pad"; print "data " length(d) + 1; print d; print "" } if (c % 2 == 0) { print "reset refs/heads/ref/" c; print "from refs/heads/main"; print "" } } }' | git -c safe.directory='*' fast-import --quiet`,
      `git -c safe.directory='*' repack -adq`,
      `git -c safe.directory='*' update-server-info`,
      `cd /`,
      `mv -T "$t" /srv/large.git || rm -rf "$t"`,
    ].join("\n"),
  );
}

/** One commit on `main` of `large.git`: the remote that moves under the load. */
export async function moveLargeSeed(n: number): Promise<void> {
  await inSeed(
    [
      `cd /srv/large.git`,
      `t=$(git -c safe.directory='*' rev-parse 'refs/heads/main^{tree}')`,
      `c=$(git -c safe.directory='*' -c user.email=e@e -c user.name=e commit-tree -m m${n} -p refs/heads/main $t)`,
      `git -c safe.directory='*' update-ref refs/heads/main $c`,
      `git -c safe.directory='*' update-server-info`,
    ].join("\n"),
  );
}

/** A repository of one scenario, beside `app.git`: `files` small files on `main`, and `branches`. It
 * is the scenario's own, so that the scenario can remove it, and the files make a Worktree slow
 * enough to kill in the middle. */
export async function ownSeedRepo(name: string, files: number, branches: readonly string[] = []): Promise<string> {
  await inSeed(
    [
      `git init -q -b main --bare /srv/${name}.git`,
      `cd /srv/${name}.git`,
      `git config http.receivepack false`,
      `awk 'BEGIN { print "commit refs/heads/main"; print "committer e <e@e> 1700000000 +0000"; print "data 1"; print "x"; for (f = 0; f < ${files}; f++) { print "M 100644 inline d" f % 200 "/f" f ".txt"; print "data 2"; print "x"; print "" } print "" }' | git -c safe.directory='*' fast-import --quiet`,
      ...branches.map((b) => `git -c safe.directory='*' branch ${b} main`),
      `git -c safe.directory='*' repack -adq`,
      `git -c safe.directory='*' update-server-info`,
    ].join("\n"),
  );
  return `http://seed.jr2-e2e-seed.svc/${name}.git`;
}

/** Remove a repository of {@link ownSeedRepo}: from now on, its remote fails each fetch. */
export async function dropSeedRepo(name: string): Promise<void> {
  await inSeed(`rm -rf /srv/${name}.git`);
}

// --- Git LFS (ADR-0051, ADR-0053, ADR-0067, ADR-0075) ----------------------------------------------
//
// The seed's LFS server: its own Deployment and Service (`lfs`), beside `seed`, so that the seed's
// manifest does not change and its pod does not roll (every worktree applies its own copy of it).
// It speaks the Git LFS batch API with the basic transfer, holds no credential, and keeps each
// object in an emptyDir at `/data/<repo>/<oid>`. A scenario names it in the `.lfsconfig` of a
// repository it makes at run time (`lfsSeedRepo`), so the cache agent and the Effector find it as
// they find any LFS server: by `lfs.url` at the Binding's base. It is cluster furniture, as the
// seed is: the next run's apply is a no-op.

/** The LFS server's host, as a pod reaches it. */
export const LFS_HOST = "lfs.jr2-e2e-seed.svc";

/**
 * The LFS server: `POST /<repo>/info/lfs/objects/batch`, `GET` and `PUT /<repo>/objects/<oid>`,
 * `POST /<repo>/verify`. A download of an object it does not hold is that object's 404 error; an
 * upload of an object it holds gets no action, which is how the batch API says "held". A `PUT` whose
 * bytes do not hash to the oid is 422 and stores nothing. Every request is one line on stdout. On the
 * host, `SEED_LFS_LISTEN` and `SEED_LFS_STORE` set its port and its store. The names are not
 * `LFS_PORT`: Kubernetes sets that variable in each pod of the namespace, for the Service `lfs`.
 */
export const LFS_SERVER_SCRIPT = [
  `const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto");`,
  `const D=process.env.SEED_LFS_STORE||"/data";const OID=/^[0-9a-f]{64}$/;const REPO=/^[a-z0-9][a-z0-9-]{0,80}$/;`,
  `const at=(r,o)=>path.join(D,r,o);`,
  `const holds=(r,o,n)=>{try{const s=fs.statSync(at(r,o));return n===undefined||s.size===n;}catch{return false;}};`,
  `const body=(req)=>new Promise((ok)=>{let b="";req.on("data",(d)=>b+=d);req.on("end",()=>{try{ok(JSON.parse(b));}catch{ok({});}});});`,
  `http.createServer(async(req,res)=>{`,
  `const s=new URL(req.url,"http://x").pathname.split("/").filter(Boolean);`,
  `const send=(code,obj)=>{console.log(req.method+" "+req.url+" "+code);res.writeHead(code,{"content-type":"application/vnd.git-lfs+json"});res.end(obj===undefined?"":JSON.stringify(obj));};`,
  `const repo=s[0];if(!repo||!REPO.test(repo))return send(404,{message:"no such repository"});`,
  `const base="http://"+req.headers.host+"/"+repo;`,
  `if(req.method==="POST"&&s.slice(1).join("/")==="info/lfs/objects/batch"){`,
  `const b=await body(req);const up=b.operation==="upload";`,
  `const objects=(b.objects||[]).map(({oid,size})=>{`,
  `if(!OID.test(String(oid)))return {oid,size,error:{code:422,message:"not an oid"}};`,
  `const held=holds(repo,oid,size);`,
  `if(up)return held?{oid,size}:{oid,size,actions:{upload:{href:base+"/objects/"+oid},verify:{href:base+"/verify"}}};`,
  `return held?{oid,size,actions:{download:{href:base+"/objects/"+oid}}}:{oid,size,error:{code:404,message:"Object does not exist"}};});`,
  `return send(200,{transfer:"basic",objects});}`,
  `const oid=s[2];`,
  `if(s[1]==="objects"&&OID.test(oid||"")&&req.method==="GET"){`,
  `if(!holds(repo,oid))return send(404,{message:"Object does not exist"});`,
  `console.log("GET "+req.url+" 200");res.writeHead(200,{"content-type":"application/octet-stream","content-length":fs.statSync(at(repo,oid)).size});`,
  `return fs.createReadStream(at(repo,oid)).pipe(res);}`,
  `if(s[1]==="objects"&&OID.test(oid||"")&&req.method==="PUT"){`,
  `fs.mkdirSync(path.join(D,repo),{recursive:true});const tmp=at(repo,oid)+".put-"+process.hrtime.bigint();`,
  `const h=crypto.createHash("sha256");const out=fs.createWriteStream(tmp);req.on("data",(d)=>h.update(d));req.pipe(out);`,
  `return out.on("finish",()=>{if(h.digest("hex")!==oid){fs.rmSync(tmp,{force:true});return send(422,{message:"the bytes do not hash to the oid"});}`,
  `fs.renameSync(tmp,at(repo,oid));send(200);});}`,
  `if(s[1]==="verify"&&req.method==="POST"){const b=await body(req);return holds(repo,String(b.oid),b.size)?send(200,{}):send(404,{message:"Object does not exist"});}`,
  `send(404,{message:"not found"});`,
  `}).listen(Number(process.env.SEED_LFS_LISTEN||8080));`,
].join("");

/**
 * Make objects in the LFS server's store: one object of random bytes for each size, written and
 * hashed in 1 MiB pieces, so a large one never sits in memory. Run in the LFS server's container
 * with `node -e <this> <repo> <size>...`; it prints one `<oid> <size>` line for each object.
 */
export const MAKE_LFS_OBJECTS = [
  `const fs=require("fs"),path=require("path"),crypto=require("crypto");`,
  `const [repo,...sizes]=process.argv.slice(1);const dir=path.join(process.env.SEED_LFS_STORE||"/data",repo);fs.mkdirSync(dir,{recursive:true});`,
  `for(const n of sizes.map(Number)){const tmp=path.join(dir,".make-"+process.pid);const fd=fs.openSync(tmp,"w");const h=crypto.createHash("sha256");`,
  `for(let left=n;left>0;){const b=crypto.randomBytes(Math.min(left,1<<20));h.update(b);fs.writeSync(fd,b);left-=b.length;}`,
  `fs.closeSync(fd);const oid=h.digest("hex");fs.renameSync(tmp,path.join(dir,oid));console.log(oid+" "+n);}`,
].join("");

const LFS_MANIFEST = `
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: lfs
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: lfs
  template:
    metadata:
      labels:
        app: lfs
    spec:
      containers:
        - name: lfs
          image: ${NODE_IMAGE}
          command: ["node", "-e", ${JSON.stringify(LFS_SERVER_SCRIPT)}]
          ports:
            - containerPort: 8080
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: lfs
  namespace: ${NAMESPACE}
spec:
  selector:
    app: lfs
  ports:
    - port: 80
      targetPort: 8080
`;

let lfsServed: Promise<void> | undefined;

/** Make sure the seed and its LFS server are served, once per process. */
export function ensureLfsServer(): Promise<void> {
  lfsServed ??= (async () => {
    await ensureSeed();
    await kubectl(["apply", "-f", "-"], LFS_MANIFEST, /AlreadyExists/);
    await kubectl(["--namespace", NAMESPACE, "rollout", "status", "deployment/lfs", "--timeout=300s"]);
  })().catch((err: unknown) => {
    lfsServed = undefined;
    throw err;
  });
  return lfsServed;
}

/** One Git LFS object: its sha-256 and its size in bytes. */
export type LfsObject = { oid: string; size: number };

/** Make objects of random bytes, one for each size, in the LFS server's store for `repo`. */
export async function makeLfsObjects(repo: string, sizes: readonly number[]): Promise<LfsObject[]> {
  assert.match(repo, /^[a-z0-9][a-z0-9-]{0,80}$/, "an LFS repository is a plain lower-case label");
  const { stdout } = await exec(
    "kubectl",
    [
      "--namespace",
      NAMESPACE,
      "exec",
      "deployment/lfs",
      "-c",
      "lfs",
      "--",
      "node",
      "-e",
      MAKE_LFS_OBJECTS,
      repo,
      ...sizes.map(String),
    ],
    { maxBuffer: 1 << 20, timeout: 1_800_000 },
  );
  const objects = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [oid, size] = line.split(" ");
      return { oid: oid ?? "", size: Number(size) };
    });
  assert.equal(objects.length, sizes.length, `the LFS server made each object: ${stdout}`);
  for (const o of objects) assert.match(o.oid, /^[0-9a-f]{64}$/);
  return objects;
}

/** An object that the LFS server never holds: its oid names no bytes that anyone has. */
export function lfsObjectNobodyHolds(): LfsObject {
  return { oid: randomBytes(32).toString("hex"), size: 1234 };
}

/** Does the LFS server hold this object of `repo`, with its size? */
export async function lfsServerHolds(repo: string, o: LfsObject): Promise<boolean> {
  assert.match(repo, /^[a-z0-9][a-z0-9-]{0,80}$/);
  assert.match(o.oid, /^[0-9a-f]{64}$/);
  const { stdout } = await exec("kubectl", [
    "--namespace",
    NAMESPACE,
    "exec",
    "deployment/lfs",
    "-c",
    "lfs",
    "--",
    "sh",
    "-c",
    `[ "$(stat -c %s /data/${repo}/${o.oid} 2>/dev/null)" = "${o.size}" ] && echo held || echo absent`,
  ]);
  return stdout.trim() === "held";
}

/** The LFS server's request lines, since the pod started. */
export async function lfsServerLog(): Promise<string> {
  const { stdout } = await exec("kubectl", ["--namespace", NAMESPACE, "logs", "deployment/lfs", "-c", "lfs"], {
    maxBuffer: 64 << 20,
  });
  return stdout;
}

/** The text of a Git LFS pointer to `o`, in the canonical form. */
export function lfsPointer(o: LfsObject): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${o.oid}\nsize ${o.size}\n`;
}

/** The files of one commit: a path, and the object whose pointer that file holds. */
export type LfsCommit = Record<string, LfsObject>;

/**
 * What a repository of {@link lfsSeedRepo} holds: commits on `main`, and branches off its tip. A branch
 * of `branchServers` commits its own `.lfsconfig`, which names that store of the seed's LFS server in
 * place of the repository's own. With `lfsconfig: false`, no commit has a `.lfsconfig`, so git-lfs
 * finds the LFS server from the Repo's url.
 */
export type LfsRepoSpec = {
  main: readonly LfsCommit[];
  branches?: Record<string, LfsCommit>;
  branchServers?: Record<string, string>;
  lfsconfig?: boolean;
};

/** The `.lfsconfig` line that names the store `store` of the seed's LFS server. */
const lfsconfigOf = (store: string) => `printf '[lfs]\\n\\turl = http://${LFS_HOST}/${store}/info/lfs\\n'`;

/**
 * The script that makes an LFS repository `<srv>/<name>.git` from a work tree at `work`: a first
 * commit with `.gitattributes` (`*.bin` is stored with Git LFS) and `.lfsconfig` (the seed's LFS
 * server), then one commit on `main` for each entry of `spec.main`, and a branch off the tip for each
 * entry of `spec.branches`. Each file holds its pointer, written as text, so that the script needs no
 * git-lfs. The seed's git image has git-lfs, and its clean filter keeps a pointer's text as it is.
 * With `owner`, the repository is given to that uid, as sshd serves it to the user `git`. With
 * `objects`, each file of that folder is an object, named by its oid, and it moves into the
 * repository's own `lfs/objects/<aa>/<bb>/<oid>`, where a git-lfs-transfer server keeps it.
 */
export function lfsRepoScript(
  srv: string,
  work: string,
  name: string,
  spec: LfsRepoSpec,
  opts: { owner?: number; objects?: string } = {},
): string {
  assert.match(name, /^[a-z0-9][a-z0-9-]{0,80}$/, "an LFS repository is a plain lower-case label");
  const commit = (files: LfsCommit, message: string): string[] => [
    ...Object.entries(files).map(([file, o]) => {
      assert.match(file, /^[a-z0-9][a-z0-9/._-]{0,80}\.bin$/, "a large file is a plain path that ends in .bin");
      return `mkdir -p "$(dirname ${work}/${file})" && printf '%s' '${lfsPointer(o)}' > ${work}/${file}`;
    }),
    `git -C ${work} add -A`,
    `git -C ${work} -c user.email=e2e@jr2 -c user.name=e2e commit -qm '${message}'`,
  ];
  const repo = `${srv}/${name}.git`;
  return [
    `rm -rf ${work} ${repo}`,
    `git init -q -b main ${work}`,
    `printf '%s\\n' '*.bin filter=lfs diff=lfs merge=lfs -text' > ${work}/.gitattributes`,
    ...(spec.lfsconfig === false ? [] : [`${lfsconfigOf(name)} > ${work}/.lfsconfig`]),
    `echo '# ${name}' > ${work}/README.md`,
    `git -C ${work} add -A`,
    `git -C ${work} -c user.email=e2e@jr2 -c user.name=e2e commit -qm init`,
    ...spec.main.flatMap((files, i) => commit(files, `main ${i + 1}`)),
    ...Object.entries(spec.branches ?? {}).flatMap(([branch, files]) => {
      assert.match(branch, /^[a-z0-9][a-z0-9-]{0,60}$/, "a branch is a plain lower-case label");
      const store = spec.branchServers?.[branch];
      if (store !== undefined) assert.match(store, /^[a-z0-9][a-z0-9-]{0,80}$/, "a store is a plain lower-case label");
      return [
        `git -C ${work} checkout -q -b ${branch} main`,
        ...(store === undefined ? [] : [`${lfsconfigOf(store)} > ${work}/.lfsconfig`]),
        ...commit(files, branch),
        `git -C ${work} checkout -q main`,
      ];
    }),
    `git clone -q --bare ${work} ${repo}`,
    `git -C ${repo} update-server-info`,
    ...(opts.objects === undefined
      ? []
      : [
          `for f in ${opts.objects}/*; do o=$(basename "$f"); d=${repo}/lfs/objects/$(echo "$o" | cut -c1-2)/$(echo "$o" | cut -c3-4); ` +
            `mkdir -p "$d" && mv "$f" "$d/$o"; done`,
          `rmdir ${opts.objects}`,
        ]),
    ...(opts.owner === undefined ? [] : [`chown -R ${opts.owner}:${opts.owner} ${repo}`]),
    `rm -rf ${work}`,
  ].join(" && ");
}

/** The uid of the seed's user `git`, whom sshd serves (`SERVE_SSH`). */
const SEED_GIT_UID = 1001;

/**
 * An LFS repository of one scenario, beside `app.git`. Over `http` the cache clones it anonymously,
 * and over `ssh` it is `push.git`'s kind, which the deploy key clones and pushes to. Both name the
 * seed's LFS server in `.lfsconfig`. Over `pure-ssh` it is an ssh repository with no `.lfsconfig`:
 * git-lfs then speaks the pure SSH protocol to the seed's sshd (`ensureLfsTransfer`), and the objects
 * of {@link makeSeedLfsObjects} for `name` are in its own store. Answer its url and the sha of each
 * commit on `main`, oldest first.
 */
export async function lfsSeedRepo(
  name: string,
  spec: LfsRepoSpec,
  over: "http" | "ssh" | "pure-ssh" = "http",
): Promise<{ url: string; main: string[] }> {
  const pure = over === "pure-ssh";
  const script = lfsRepoScript("/srv", `/tmp/lfs-${name}`, name, pure ? { ...spec, lfsconfig: false } : spec, {
    ...(over === "http" ? {} : { owner: SEED_GIT_UID }),
    ...(pure ? { objects: pendingObjects(name) } : {}),
  });
  const out = await inSeed(`${script} && git -c safe.directory='*' -C /srv/${name}.git rev-list --reverse main`);
  const main = out.trim().split("\n");
  assert.equal(main.length, spec.main.length + 1, `the repository has its commits: ${out}`);
  return {
    url: over === "http" ? `http://${PUSH_HOST}/${name}.git` : `ssh://git@${PUSH_HOST}/srv/${name}.git`,
    main,
  };
}

// --- The pure SSH protocol (ADR-0067) -----------------------------------------------------------------
//
// git-lfs 3.x speaks the pure SSH protocol: `ssh <host> git-lfs-transfer <path> <operation>`. The
// seed's ssh seat gets a git-lfs-transfer server at run time: charmbracelet/git-lfs-transfer, the
// server that Gitea and Soft Serve use, built on this host as a static binary and copied into the
// `ssh` container. Thus the seed's manifest does not change, its pod does not roll, and its other
// repositories are as before: each of them names an LFS server in `.lfsconfig`, or stores no file
// with Git LFS. The seat has no git-lfs-authenticate, so a repository with no `.lfsconfig` has an
// LFS server that speaks only the pure SSH protocol. A wrapper logs each session in
// `/tmp/git-lfs-transfer.log` and then runs the server.

/** The pinned server. Its module has one release. */
const LFS_TRANSFER_MODULE = "github.com/charmbracelet/git-lfs-transfer@v0.1.0";
/** Where the ssh seat runs the server from, and the wrapper on sshd's PATH. */
const LFS_TRANSFER_REAL = "/usr/local/libexec/jr2-e2e/git-lfs-transfer";
const LFS_TRANSFER_LOG = "/tmp/git-lfs-transfer.log";
const LFS_TRANSFER_WRAPPER = [
  "#!/bin/sh",
  `echo "$1 $2" >> ${LFS_TRANSFER_LOG}`,
  `exec ${LFS_TRANSFER_REAL} "$@"`,
  "",
].join("\n");

/** Build the server for the kind node's arch, once on this host, into `features/.tmp/bin`. */
async function lfsTransferBinary(): Promise<string> {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const dir = fileURLToPath(new URL("../.tmp/bin/", import.meta.url));
  const bin = join(dir, `git-lfs-transfer-v0.1.0-${arch}`);
  if (existsSync(bin)) return bin;
  // Workers can build at the same time: each builds in its own folder and renames at the end. The
  // folder is inside dir, so the rename stays on one filesystem (a tmpfs /tmp gives EXDEV).
  await mkdir(dir, { recursive: true });
  const own = await mkdtemp(join(dir, ".build-"));
  await exec("go", ["install", "-trimpath", "-ldflags=-s -w", LFS_TRANSFER_MODULE], {
    env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch, GOBIN: own },
    timeout: 600_000,
  }).catch(async (err: unknown) => {
    await rm(own, { recursive: true, force: true });
    throw new Error(`go install ${LFS_TRANSFER_MODULE} failed (the @kind tier needs go): ${String(err)}`);
  });
  // With GOOS and GOARCH not the host's, go install writes to GOBIN/<os>_<arch>.
  const made = [join(own, "git-lfs-transfer"), join(own, `linux_${arch}`, "git-lfs-transfer")].find((f) =>
    existsSync(f),
  );
  if (made) await rename(made, bin);
  await rm(own, { recursive: true, force: true });
  assert.ok(made, `go install wrote no git-lfs-transfer in ${own}`);
  return bin;
}

let lfsTransferServed: Promise<void> | undefined;

/** Make sure that the seed's ssh seat runs a git-lfs-transfer server and no git-lfs-authenticate. */
export function ensureLfsTransfer(): Promise<void> {
  lfsTransferServed ??= (async () => {
    await ensureSeed();
    const bin = await lfsTransferBinary();
    const inSsh = (script: string, stdin?: Buffer) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          "kubectl",
          ["--namespace", NAMESPACE, "exec", "-i", "deployment/seed", "-c", "ssh", "--", "sh", "-ec", script],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve(out) : reject(new Error(`kubectl exec in the seed's ssh seat exited ${code}: ${err}`)),
        );
        child.stdin.end(stdin ?? "");
      });
    // Each step writes a file of its own and renames it, so two workers can install at once.
    await inSsh(
      `mkdir -p ${dirname(LFS_TRANSFER_REAL)} && t=${LFS_TRANSFER_REAL}.$$ && cat > "$t" && chmod 755 "$t" && mv "$t" ${LFS_TRANSFER_REAL}`,
      await readFile(bin),
    );
    await inSsh(
      `t=/usr/bin/.git-lfs-transfer.$$ && cat > "$t" && chmod 755 "$t" && mv "$t" /usr/bin/git-lfs-transfer && ` +
        `touch ${LFS_TRANSFER_LOG} && chmod 666 ${LFS_TRANSFER_LOG}`,
      Buffer.from(LFS_TRANSFER_WRAPPER),
    );
    const found = await inSsh(
      `for d in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do ls "$d" 2>/dev/null || true; done | grep '^git-lfs-' | sort -u`,
    );
    assert.equal(
      found,
      "git-lfs-transfer\n",
      `the ssh seat has git-lfs-transfer and no other git-lfs server: ${found}`,
    );
  })().catch((err: unknown) => {
    lfsTransferServed = undefined;
    throw err;
  });
  return lfsTransferServed;
}

/** The folder in the seed where {@link makeSeedLfsObjects} keeps a repository's objects until it exists. */
const pendingObjects = (name: string) => `/srv/.lfs-${name}`;

/** Make objects of random bytes, one for each size, for the `pure-ssh` repository `name` of {@link lfsSeedRepo}. */
export async function makeSeedLfsObjects(name: string, sizes: readonly number[]): Promise<LfsObject[]> {
  assert.match(name, /^[a-z0-9][a-z0-9-]{0,80}$/, "an LFS repository is a plain lower-case label");
  const dir = pendingObjects(name);
  const out = await inSeed(
    [
      `rm -rf ${dir} && mkdir -p ${dir}`,
      ...sizes.map(
        (n) =>
          `head -c ${n} /dev/urandom > ${dir}/new && o=$(sha256sum ${dir}/new | cut -c1-64) && mv ${dir}/new ${dir}/$o && echo "$o ${n}"`,
      ),
    ].join(" && "),
  );
  const objects = out
    .trim()
    .split("\n")
    .map((line) => {
      const [oid, size] = line.split(" ");
      return { oid: oid ?? "", size: Number(size) };
    });
  assert.equal(objects.length, sizes.length, `the seed made each object: ${out}`);
  for (const o of objects) assert.match(o.oid, /^[0-9a-f]{64}$/);
  return objects;
}

/** Does the store of the seed repository `name` hold this object, with its size? */
export async function seedRepoHoldsLfs(name: string, o: LfsObject): Promise<boolean> {
  assert.match(name, /^[a-z0-9][a-z0-9-]{0,80}$/);
  assert.match(o.oid, /^[0-9a-f]{64}$/);
  const f = `/srv/${name}.git/lfs/objects/${o.oid.slice(0, 2)}/${o.oid.slice(2, 4)}/${o.oid}`;
  const out = await inSeed(`[ "$(stat -c %s ${f} 2>/dev/null)" = "${o.size}" ] && echo held || echo absent`);
  return out.trim() === "held";
}

/** The operations of each git-lfs-transfer session on the seed repository `name`, oldest first. */
export async function lfsTransferSessions(name: string): Promise<string[]> {
  assert.match(name, /^[a-z0-9][a-z0-9-]{0,80}$/);
  const { stdout } = await exec("kubectl", [
    "--namespace",
    NAMESPACE,
    "exec",
    "deployment/seed",
    "-c",
    "ssh",
    "--",
    "sh",
    "-c",
    `grep -F '/srv/${name}.git ' ${LFS_TRANSFER_LOG} || true`,
  ]);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ")[1] ?? "");
}

/** What a seed repository holds on a branch, or "" when it has none. */
export async function seedRepoTip(name: string, branch: string): Promise<string> {
  assert.match(name, /^[a-z0-9][a-z0-9-]{0,80}$/);
  assert.match(branch, /^[a-z0-9][a-z0-9/-]{0,60}$/);
  const out = await inSeed(
    `git -c safe.directory='*' -C /srv/${name}.git rev-parse -q --verify refs/heads/${branch} || true`,
  );
  return out.trim();
}
