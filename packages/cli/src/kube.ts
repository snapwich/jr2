// The CLI's kube transport (ADR-0019): run-verbs reach a deployed orchestrator by port-forwarding
// its Service via the kube API for the duration of the command, authenticating with the Instance
// token read from its in-cluster Secret — kube RBAC is the real gate. This module is the seam:
// `KubePort` is what target resolution consumes (tests inject a fake), `kubectlKube` is the real
// one, shelling out to the same `kubectl` a human debugging the cluster would use.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// The fixed in-namespace object names live with the orchestrator (its entrypoint consumes them
// too); re-exported here for the CLI's own modules.
export { INSTANCE_SECRET, ORCHESTRATOR_PORT, ORCHESTRATOR_SERVICE } from "@j2/orchestrator";

export type KubePort = {
  /** The current kubectl context, or undefined when there is none configured. */
  currentContext(): Promise<string | undefined>;
  /** One decoded key of a Secret; undefined when the Secret (or key) is absent. */
  readSecret(opts: { namespace: string; name: string; key: string; context?: string }): Promise<string | undefined>;
  /** Forward a Service port to an ephemeral local port for the life of the command. */
  portForward(opts: {
    namespace: string;
    service: string;
    port: number;
    context?: string;
  }): Promise<{ url: string; close: () => void }>;
};

const ctxArgs = (context?: string): string[] => (context ? ["--context", context] : []);

/** The loosely-typed kube object shape the converge logic inspects: labels carry the instance's
 * identity and the instance image's content hash; annotations carry the converged image map, which
 * is too long for a label value (ADR-0038). */
export type KubeObject = {
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
} & Record<string, unknown>;

/** What `j2 up`/`j2 down` converge through — admin-shaped, next to the transport-shaped KubePort.
 * Injected via `io.kubeAdmin` in tests; `kubectlAdmin` is the real one. */
export type KubeAdmin = {
  /** The current kubectl context, or undefined when there is none configured. */
  context(): Promise<string | undefined>;
  /** One object as JSON; undefined when absent. Cluster-scoped kinds pass no namespace. */
  getJson<T = KubeObject>(opts: {
    kind: string;
    name: string;
    namespace?: string;
    context?: string;
  }): Promise<T | undefined>;
  /** Objects matching a label selector. Unlike `getJson`, a failed query THROWS rather than
   * reading as "absent" — this is what converge claims are checked against, and a check that
   * silently passes when it could not look is the defect it exists to catch. */
  listJson<T = KubeObject>(opts: {
    kind: string;
    selector?: string;
    namespace?: string;
    context?: string;
  }): Promise<T[]>;
  /** `kubectl apply -f -` of a multi-doc YAML or JSON manifest string. */
  apply(opts: { manifest: string; context?: string }): Promise<void>;
  /** `kubectl label --overwrite`. */
  label(opts: {
    kind: string;
    name: string;
    namespace?: string;
    labels: Record<string, string>;
    context?: string;
  }): Promise<void>;
  /** `kubectl delete --ignore-not-found` of one object. */
  deleteObject(opts: {
    kind: string;
    name: string;
    namespace?: string;
    context?: string;
    wait?: boolean;
  }): Promise<void>;
  /** `kubectl delete --ignore-not-found -f -` of a manifest string (the operator uninstall). */
  deleteManifest(opts: { manifest: string; context?: string }): Promise<void>;
  /** `kubectl rollout status deployment/<d>` — converge isn't done until the pod is. */
  waitRollout(opts: {
    deployment: string;
    namespace: string;
    context?: string;
    timeoutSeconds?: number;
  }): Promise<void>;
  /** Run a one-shot node script IN the cluster (`kubectl run --rm`) and return its output — the
   * provider-preflight seam (ADR-0019: reachability must be probed from where pods live).
   * `caPem` makes the probe trust a private CA the same way the Harness does (ADR-0020):
   * `NODE_EXTRA_CA_CERTS`, which must be process env at node start — it cannot be set from
   * inside the script. */
  runOneShot(opts: {
    namespace: string;
    name: string;
    script: string;
    caPem?: string;
    context?: string;
  }): Promise<string>;
};

const nsArgs = (namespace?: string): string[] => (namespace ? ["--namespace", namespace] : []);

/** The real admin port, over `kubectl` subprocesses. */
export const kubectlAdmin: KubeAdmin = {
  context: () => kubectlKube.currentContext(),

  async getJson({ kind, name, namespace, context }) {
    try {
      const { stdout } = await exec("kubectl", [
        ...ctxArgs(context),
        ...nsArgs(namespace),
        "get",
        kind,
        name,
        "-o",
        "json",
      ]);
      return JSON.parse(stdout);
    } catch {
      return undefined;
    }
  },

  async listJson({ kind, selector, namespace, context }) {
    const { stdout } = await exec("kubectl", [
      ...ctxArgs(context),
      ...nsArgs(namespace),
      "get",
      kind,
      ...(selector ? ["-l", selector] : []),
      "-o",
      "json",
    ]);
    return (JSON.parse(stdout) as { items?: never[] }).items ?? [];
  },

  async apply({ manifest, context }) {
    await execStdin(["kubectl", ...ctxArgs(context), "apply", "-f", "-"], manifest);
  },

  async label({ kind, name, namespace, labels, context }) {
    const pairs = Object.entries(labels).map(([k, v]) => `${k}=${v}`);
    await exec("kubectl", [...ctxArgs(context), ...nsArgs(namespace), "label", "--overwrite", kind, name, ...pairs]);
  },

  async deleteObject({ kind, name, namespace, context, wait }) {
    await exec("kubectl", [
      ...ctxArgs(context),
      ...nsArgs(namespace),
      "delete",
      kind,
      name,
      "--ignore-not-found",
      `--wait=${wait !== false}`,
    ]);
  },

  async deleteManifest({ manifest, context }) {
    await execStdin(["kubectl", ...ctxArgs(context), "delete", "--ignore-not-found", "-f", "-"], manifest);
  },

  async waitRollout({ deployment, namespace, context, timeoutSeconds = 180 }) {
    await exec("kubectl", [
      ...ctxArgs(context),
      ...nsArgs(namespace),
      "rollout",
      "status",
      `deployment/${deployment}`,
      `--timeout=${timeoutSeconds}s`,
    ]);
  },

  async runOneShot({ namespace, name, script, caPem, context }) {
    // With a CA bundle: write the PEM to a file BEFORE node starts, because NODE_EXTRA_CA_CERTS
    // is only honored as process-start env. The PEM rides an env var base64'd (multiline values
    // and `--env` don't mix); `"$1"` keeps the script out of shell parsing entirely (execFile
    // passes argv verbatim, no host shell either).
    const command = caPem
      ? ["sh", "-ec", 'echo "$J2_CA_B64" | base64 -d > /tmp/j2-ca.crt && exec node -e "$1"', "sh", script]
      : ["node", "-e", script];
    const { stdout } = await exec(
      "kubectl",
      [
        ...ctxArgs(context),
        ...nsArgs(namespace),
        "run",
        name,
        "--rm",
        "--attach",
        "--restart=Never",
        "--quiet",
        "--image=node:24-slim",
        ...(caPem
          ? [`--env=J2_CA_B64=${Buffer.from(caPem).toString("base64")}`, "--env=NODE_EXTRA_CA_CERTS=/tmp/j2-ca.crt"]
          : []),
        "--command",
        "--",
        ...command,
      ],
      { timeout: 180_000 },
    );
    return stdout;
  },
};

/** Run a command feeding `stdin`, surfacing stderr in the thrown error (kubectl's messages are the
 * useful part of an apply failure). */
function execStdin(cmd: string[], stdin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1));
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd.join(" ")} exited (${code}): ${err.trim()}`)),
    );
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** The real kube port, over `kubectl` subprocesses. */
export const kubectlKube: KubePort = {
  async currentContext() {
    try {
      const { stdout } = await exec("kubectl", ["config", "current-context"]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },

  async readSecret({ namespace, name, key, context }) {
    try {
      const { stdout } = await exec("kubectl", [
        ...ctxArgs(context),
        "--namespace",
        namespace,
        "get",
        "secret",
        name,
        "-o",
        `jsonpath={.data.${key}}`,
      ]);
      return stdout ? Buffer.from(stdout, "base64").toString("utf8") : undefined;
    } catch {
      return undefined; // absent Secret and unreachable cluster look the same to a verb: not deployed here
    }
  },

  // `:port` asks kubectl for an ephemeral local port, announced on its stdout as
  // "Forwarding from 127.0.0.1:<local> -> <remote>" — parsed rather than raced.
  portForward({ namespace, service, port, context }) {
    return new Promise((resolve, reject) => {
      const child = spawn("kubectl", [
        ...ctxArgs(context),
        "--namespace",
        namespace,
        "port-forward",
        `service/${service}`,
        `:${port}`,
      ]);
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out);
        if (m) resolve({ url: `http://127.0.0.1:${m[1]}`, close: () => child.kill() });
      });
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", (e) => reject(new Error(`kubectl port-forward failed: ${e.message}`)));
      child.on("close", (code) => reject(new Error(`kubectl port-forward exited (${code}): ${err.trim()}`)));
    });
  },
};
