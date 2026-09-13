// The seed Repo the @kind tier's workflows bind (ADR-0051): a bare git repository served over
// HTTP from INSIDE the cluster, so the cache agent on every node can clone it the way it clones
// anything — by url, with no file baked into an image and no path pinned to a node. The tier's
// instance names it by that url (`http://seed.j2-e2e-seed.svc/app.git`), which is its identity;
// nothing else about it is configured anywhere.
//
// One namespace, one Deployment, one Service, shared by every scenario and every worker: an init
// container makes the repository (one commit on `main`, `update-server-info` for the dumb HTTP
// protocol) into an emptyDir that nginx then serves. Applying is idempotent, so `--parallel`
// workers racing to seed the same cluster converge on the same objects; the wait is per process.
// The namespace outlives the suite on purpose — it is cluster furniture, not a scenario's state,
// and the next run's apply is a no-op.

import { spawn } from "node:child_process";

/** The seed Repo's url — the identity every kind workflow binds and the fence admits. */
export const SEED_URL = "http://seed.j2-e2e-seed.svc/app.git";

const NAMESPACE = "j2-e2e-seed";

/** Pinned tags, both multi-arch: `docker manifest inspect` resolves each. */
const GIT_IMAGE = "alpine/git:v2.47.2";
const HTTP_IMAGE = "nginx:1.27-alpine";

const MAKE_REPO = [
  "git init -q -b main /tmp/w",
  "echo '# app' > /tmp/w/README.md",
  "git -C /tmp/w add -A",
  "git -C /tmp/w -c user.email=e2e@j2 -c user.name=e2e commit -qm init",
  "git clone -q --bare /tmp/w /srv/app.git",
  "git -C /srv/app.git update-server-info",
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
  await kubectl(["apply", "-f", "-"], MANIFEST);
  await kubectl(["--namespace", NAMESPACE, "rollout", "status", "deployment/seed", "--timeout=300s"]);
}

function kubectl(args: string[], stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("kubectl", args, { stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`kubectl ${args.join(" ")} exited ${code}: ${stderr.trim()} (seeding ${SEED_URL})`)),
    );
    if (stdin !== undefined) child.stdin!.end(stdin);
  });
}
