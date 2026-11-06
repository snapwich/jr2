// The `jr2 workspace` verbs' cluster side (ADR-0009, ADR-0012, ADR-0021): the instance's Sandbox CRs
// over the kube API, never the Orchestrator, so the verbs work when it is down. Kube RBAC is the
// gate; no Caller scope opens them. `WorkspaceKube` is the seam (tests inject a fake through
// `io.workspaces`), and `kubectlWorkspaces` is the real one, which runs the `kubectl` that a person
// runs.
//
// A Workspace's handle is `<run-prefix>/<workspace path>`: a prefix of its run's id (the label
// `jr2.dev/run`) and its exact path (the annotation `jr2.dev/workspace-path`). A label selector
// matches only a whole value, so the CLI lists the CRs and compares on the client. The CR's name is
// a handle too, and `<name>.jr2` is the CR's name for an ssh `Host *.jr2` (`workspace forward
// --stdio`).
//
// Whether a run holds a Sandbox is the hold mark that the Lease writes on the CR (ADR-0021):
// `held` from its first write, `released` when it stops for the body's final state, a fault, a
// cancel or a parent that leaves the Workspace's state. A park and a process shutdown write nothing, so the CR of a run that an Orchestrator crash
// left stays `held`. A keepalive older than the CR's idle timeout is a Sandbox that no Lease renews
// (the operator reaps it). Its age is read on the API server's clock, never the local one.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  ANNOTATION_HOLD,
  ANNOTATION_KEEPALIVE,
  ANNOTATION_WORKSPACE_PATH,
  HOLD_HELD,
  HOLD_RELEASED,
  LABEL_SANDBOX_RUN,
  LABEL_SANDBOX_WORKFLOW,
} from "@jr2/orchestrator/internal";
import { endsWithProcess, REACH_BUDGET_MS } from "./kube.ts";

const exec = promisify(execFile);

/** The Sandbox CR as these verbs read it. */
export type SandboxCR = {
  metadata: {
    name: string;
    resourceVersion?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: { idleTimeout?: string; sidecars?: { name: string }[] };
  status?: { phase?: string };
};

/** The cluster side of the verbs. Every method takes the deployment's namespace and context. */
export type WorkspaceKube = {
  /** The current kubectl context, or undefined. */
  context(): Promise<string | undefined>;
  /** The instance's Sandbox CRs (those with `jr2.dev/run`), and the API server's clock when it
   * answered (its `Date` header), or undefined when the answer did not say. */
  list(opts: { namespace: string; context?: string }): Promise<{ items: SandboxCR[]; serverNow?: number }>;
  /** Delete one Sandbox CR. Its pod and its token Secret go with it. With `resourceVersion`, the
   * API server deletes it only when the CR is still at that version, else it throws
   * `WorkspaceChangedError`. */
  delete(opts: { namespace: string; name: string; resourceVersion?: string; context?: string }): Promise<void>;
  /** Run `argv` in one container of the pod, with this terminal: `kubectl exec -i [-t]`. Resolves
   * with its exit code. */
  exec(opts: {
    namespace: string;
    pod: string;
    container: string;
    argv: readonly string[];
    tty: boolean;
    context?: string;
  }): Promise<number>;
  /** Forward a local port to `port` in the pod; `local` 0 asks for a free one. */
  forward(opts: {
    namespace: string;
    pod: string;
    port: number;
    local?: number;
    context?: string;
  }): Promise<{ port: number; close: () => void; closed: Promise<number> }>;
};

/** The CR changed after `rm` read it (a run placed it again), so it is not deleted. */
export class WorkspaceChangedError extends Error {
  constructor(name: string) {
    super(`Sandbox ${name} changed after it was read`);
    this.name = "WorkspaceChangedError";
  }
}

/** A Sandbox CR as one Workspace. */
export type WorkspaceRow = {
  /** `<run id's first 8>/<path>` — the handle that `ls` prints. */
  handle: string;
  /** The CR's name: a handle too, and the pod's name. */
  name: string;
  /** The CR's version when it was read: `rm` deletes only that version. */
  resourceVersion?: string;
  runId: string;
  workflow: string;
  /** The Workspace's path in the run's Machine (ADR-0012). Empty for a CR that predates the label. */
  path: string;
  phase: string;
  created?: string;
  /** Whether a run holds it: `held`, `released`, `idle` (no Lease renews it), or `unknown` (no mark). */
  hold: "held" | "released" | "idle" | "unknown";
};

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/** A duration of the CR's idle timeout in milliseconds, or undefined. The value is a Go duration
 * (metav1.Duration): one or more `<number><unit>`, with the units `h`, `m`, `s` and `ms` (`30m`,
 * `1h30m`, `1h0m0s`, `1.5h`). */
export function idleTimeoutMs(text: string | undefined): number | undefined {
  const value = text ?? "30m";
  if (!/^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/.test(value)) return undefined;
  let ms = 0;
  for (const m of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) ms += Number(m[1]) * DURATION_UNITS[m[2]!]!;
  return ms;
}

/** One CR as its row. `serverNow` is the API server's clock; without it no keepalive is read. */
export function rowOf(cr: SandboxCR, serverNow: number | undefined): WorkspaceRow {
  const labels = cr.metadata.labels ?? {};
  const notes = cr.metadata.annotations ?? {};
  const runId = labels[LABEL_SANDBOX_RUN] ?? "";
  const path = notes[ANNOTATION_WORKSPACE_PATH] ?? "";
  const mark = notes[ANNOTATION_HOLD];
  const keepalive = Date.parse(notes[ANNOTATION_KEEPALIVE] ?? "");
  const idle = idleTimeoutMs(cr.spec?.idleTimeout);
  const lapsed =
    serverNow !== undefined && idle !== undefined && Number.isFinite(keepalive) && serverNow - keepalive > idle;
  const hold: WorkspaceRow["hold"] =
    mark === HOLD_RELEASED ? "released" : lapsed ? "idle" : mark === HOLD_HELD ? "held" : "unknown";
  return {
    handle: `${runId.slice(0, 8)}/${path || cr.metadata.name}`,
    name: cr.metadata.name,
    ...(cr.metadata.resourceVersion ? { resourceVersion: cr.metadata.resourceVersion } : {}),
    runId,
    workflow: labels[LABEL_SANDBOX_WORKFLOW] ?? "",
    path,
    phase: cr.status?.phase ?? "Pending",
    ...(cr.metadata.creationTimestamp ? { created: cr.metadata.creationTimestamp } : {}),
    hold,
  };
}

/** The rows a handle names: the CR's name (or `<name>.jr2`), else `<run-prefix>/<path>`. */
export function matchHandle(rows: readonly WorkspaceRow[], handle: string): WorkspaceRow[] {
  const bare = handle.endsWith(".jr2") ? handle.slice(0, -".jr2".length) : handle;
  const byName = rows.filter((r) => r.name === bare);
  if (byName.length) return byName;
  const slash = bare.indexOf("/");
  if (slash <= 0) return [];
  const prefix = bare.slice(0, slash);
  const path = bare.slice(slash + 1);
  // A CR with no path prints `<run-prefix>/<name>` (`rowOf`), so that handle names it too.
  return rows.filter((r) => r.runId.startsWith(prefix) && (r.path ? r.path === path : r.name === path));
}

/** May `rm` remove it? Only a Sandbox that no run holds: `released`, or `idle`. */
export function removable(row: WorkspaceRow): boolean {
  return row.hold === "released" || row.hold === "idle";
}

/** `30s`, `5m`, `3h`, `2d` — an age as `kubectl get` prints one. */
export function age(created: string | undefined, now: number): string {
  const t = Date.parse(created ?? "");
  if (!Number.isFinite(t)) return "-";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.floor(s / 60)}m`;
  if (s < 172_800) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

const ctxArgs = (context?: string): string[] => (context ? ["--context", context] : []);
const SANDBOX_RESOURCE = "sandboxes.core.jr2.dev";
/** The Sandbox CRs' API path, for a delete with a precondition (`kubectl delete --raw`). */
const SANDBOX_API = "/apis/core.jr2.dev/v1alpha1";
/** The `Date` header in kubectl's `-v=8` trace: the API server's clock when it answered. */
const DATE_HEADER = /Date: ([A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT)/;

export const kubectlWorkspaces: WorkspaceKube = {
  async context() {
    try {
      const { stdout } = await exec("kubectl", ["config", "current-context"]);
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },

  async list({ namespace, context }) {
    // `-v=8` traces the answer's headers on stderr: the one place kubectl shows the server's clock.
    const { stdout, stderr } = await exec(
      "kubectl",
      [
        ...ctxArgs(context),
        "--namespace",
        namespace,
        "get",
        SANDBOX_RESOURCE,
        "-l",
        LABEL_SANDBOX_RUN,
        "-o",
        "json",
        "-v=8",
        `--request-timeout=${REACH_BUDGET_MS}ms`,
      ],
      { timeout: REACH_BUDGET_MS, maxBuffer: 64 * 1024 * 1024 },
    );
    const date = DATE_HEADER.exec(stderr)?.[1];
    const serverNow = date ? Date.parse(date) : undefined;
    const items = (JSON.parse(stdout) as { items?: SandboxCR[] }).items ?? [];
    return { items, ...(serverNow !== undefined && Number.isFinite(serverNow) ? { serverNow } : {}) };
  },

  async delete({ namespace, name, resourceVersion, context }) {
    if (resourceVersion === undefined) {
      await exec(
        "kubectl",
        [...ctxArgs(context), "--namespace", namespace, "delete", SANDBOX_RESOURCE, name, "--wait=false"],
        { timeout: REACH_BUDGET_MS },
      );
      return;
    }
    // `kubectl delete` has no precondition flag: the raw DELETE carries DeleteOptions on stdin, and
    // the API server answers 409 Conflict when the CR is no longer at the version that was read.
    const body = JSON.stringify({ kind: "DeleteOptions", apiVersion: "v1", preconditions: { resourceVersion } });
    const uri = `${SANDBOX_API}/namespaces/${encodeURIComponent(namespace)}/sandboxes/${encodeURIComponent(name)}`;
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "kubectl",
        [...ctxArgs(context), "delete", "--raw", uri, "-f", "-"],
        { timeout: REACH_BUDGET_MS },
        (err, _stdout, stderr) => {
          if (!err) return resolve();
          if (/\(Conflict\)|does not match the ResourceVersion/.test(stderr)) reject(new WorkspaceChangedError(name));
          else reject(new Error(`kubectl delete failed: ${stderr.trim() || err.message}`));
        },
      );
      child.stdin?.end(body);
    });
  },

  exec({ namespace, pod, container, argv, tty, context }) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "kubectl",
        [
          ...ctxArgs(context),
          "--namespace",
          namespace,
          "exec",
          tty ? "-it" : "-i",
          "-c",
          container,
          pod,
          "--",
          ...argv,
        ],
        { stdio: "inherit" },
      );
      child.on("error", (e) => reject(new Error(`kubectl exec failed: ${e.message}`)));
      child.on("close", (code) => resolve(code ?? 1));
    });
  },

  forward({ namespace, pod, port, local = 0, context }) {
    return new Promise((resolve, reject) => {
      const child = spawn("kubectl", [
        ...ctxArgs(context),
        "--namespace",
        namespace,
        "port-forward",
        `pod/${pod}`,
        `${local === 0 ? "" : local}:${port}`,
        "--address",
        "127.0.0.1",
      ]);
      const kill = endsWithProcess(child);
      let out = "";
      let err = "";
      let ready = false;
      const closed = new Promise<number>((r) => child.on("close", (code) => r(code ?? 1)));
      const gaveUp = setTimeout(() => {
        kill();
        reject(new Error(`kubectl port-forward: no answer after ${REACH_BUDGET_MS / 1000}s`));
      }, REACH_BUDGET_MS);
      gaveUp.unref?.();
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out);
        if (m && !ready) {
          ready = true;
          clearTimeout(gaveUp);
          resolve({ port: Number(m[1]), close: kill, closed });
        }
      });
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", (e) => {
        clearTimeout(gaveUp);
        reject(new Error(`kubectl port-forward failed: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(gaveUp);
        if (!ready) reject(new Error(`kubectl port-forward exited (${code}): ${err.trim()}`));
      });
    });
  },
};
