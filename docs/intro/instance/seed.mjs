// `npm run seed` — serve the toy repo (`../repo/`) from inside the cluster, so `task` clones with no
// network. The same shape as the @kind tier's seed (features/steps/seed.ts): a bare repository over
// the dumb HTTP protocol, one Deployment and one Service, named by its url and configured nowhere
// else. `workflows/task.ts` binds that url, and the fence in `jr2.config.ts` admits it with no
// credential.
//
// The repo's files ride in a ConfigMap; an init container commits them into an emptyDir that nginx
// serves. Author and dates are fixed, so the commit sha is a function of the files alone: a pod
// restart rebuilds the SAME `main`, and re-running this after an edit to `../repo/` rolls the pod
// (the content hash is on the template) and moves `main` to the new files. The Machine never
// pushes, so nothing is written to the repository after that.
//
// Idempotent — run it as often as you like. Loads its own two images into kind first.

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureImages, kindCluster } from "./preload.mjs";

const exec = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "repo");

const NAMESPACE = "intro-seed";
/** Keep in step with workflows/task.ts `repos.target.url` and the fence in jr2.config.ts. */
const SEED_URL = `http://seed.${NAMESPACE}.svc/greet.git`;
const GIT_IMAGE = "alpine/git:v2.47.2";
const HTTP_IMAGE = "nginx:1.27-alpine";

async function files(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found.sort();
}

// ConfigMap keys are flat, so each file is `f<n>` and the init script puts it back at its path.
const repo = await Promise.all(
  (await files(REPO)).map(async (path, i) => ({
    key: `f${i}`,
    path: relative(REPO, path),
    data: await readFile(path, "utf8"),
    executable: ((await stat(path)).mode & 0o111) !== 0,
  })),
);
const hash = createHash("sha256")
  .update(JSON.stringify(repo.map(({ path, data, executable }) => [path, data, executable])))
  .digest("hex")
  .slice(0, 12);

const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const MAKE_REPO = [
  "git init -q -b main /tmp/w",
  ...repo.flatMap(({ key, path, executable }) => [
    `mkdir -p ${q(dirname(join("/tmp/w", path)))}`,
    `cp /src/${key} ${q(join("/tmp/w", path))}`,
    ...(executable ? [`chmod +x ${q(join("/tmp/w", path))}`] : []),
  ]),
  "git -C /tmp/w add -A",
  "GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z " +
    "git -C /tmp/w -c user.email=greet@example.com -c user.name=greet commit -qm 'greet: say hello'",
  "git clone -q --bare /tmp/w /srv/greet.git",
  "git -C /srv/greet.git update-server-info",
].join(" && ");

const manifest = [
  { apiVersion: "v1", kind: "Namespace", metadata: { name: NAMESPACE } },
  {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "seed-repo", namespace: NAMESPACE },
    data: Object.fromEntries(repo.map(({ key, data }) => [key, data])),
  },
  {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "seed", namespace: NAMESPACE },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: "seed" } },
      template: {
        metadata: { labels: { app: "seed" }, annotations: { "intro.jr2.dev/repo-hash": hash } },
        spec: {
          initContainers: [
            {
              name: "make-repo",
              image: GIT_IMAGE,
              command: ["sh", "-ec", MAKE_REPO],
              volumeMounts: [
                { name: "src", mountPath: "/src", readOnly: true },
                { name: "srv", mountPath: "/srv" },
              ],
            },
          ],
          containers: [
            {
              name: "http",
              image: HTTP_IMAGE,
              ports: [{ containerPort: 80 }],
              volumeMounts: [{ name: "srv", mountPath: "/usr/share/nginx/html", readOnly: true }],
            },
          ],
          volumes: [
            { name: "src", configMap: { name: "seed-repo" } },
            { name: "srv", emptyDir: {} },
          ],
        },
      },
    },
  },
  {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "seed", namespace: NAMESPACE },
    spec: { selector: { app: "seed" }, ports: [{ port: 80, targetPort: 80 }] },
  },
];

function kubectl(args, stdin) {
  return new Promise((ok, fail) => {
    const child = spawn("kubectl", args, { stdio: [stdin === undefined ? "ignore" : "pipe", "inherit", "inherit"] });
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? ok() : fail(new Error(`kubectl ${args.join(" ")} exited ${code}`))));
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

const cluster = await kindCluster();
console.log(`seed → kind cluster "${cluster}", ${repo.length} files from ${relative(process.cwd(), REPO)}`);
await ensureImages(cluster, [GIT_IMAGE, HTTP_IMAGE]);
await kubectl(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items: manifest }));
await kubectl(["-n", NAMESPACE, "rollout", "status", "deployment/seed", "--timeout=120s"]);

// Read `main` back over HTTP, the way a clone will — from inside the pod, so this needs no forward.
const { stdout } = await exec("kubectl", [
  "-n",
  NAMESPACE,
  "exec",
  "deployment/seed",
  "-c",
  "http",
  "--",
  "wget",
  "-qO-",
  "http://127.0.0.1/greet.git/info/refs",
]);
const main = /^([0-9a-f]{40})\trefs\/heads\/main$/m.exec(stdout)?.[1];
if (!main) throw new Error(`the seed serves no main: ${JSON.stringify(stdout)}`);
console.log(`served   ${SEED_URL}  main ${main.slice(0, 12)}`);
