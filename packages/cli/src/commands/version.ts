// `jr2 version [--local] [--json]` (ADR-0009 as amended): the report you paste into a bug. What is
// HERE — the copy that runs, the global that handed off (ADR-0056), the Instance's Kit version, the
// Instance and its mode, node — and what is DEPLOYED — the orchestrator the pod says it is, the
// operator, the Kit images pods read — side by side, so the gap between the halves is the answer
// ("you edited the pin and never ran `jr2 up`").
//
// The one Instance verb that reads the Instance without asserting it: a Kit mismatch is a LINE here,
// never the ADR-0056 refusal, because this is the verb you reach for when that refusal fires. Every
// probe is best-effort and every answer is a report — exit 0 whatever it finds. Nothing here
// computes what `jr2 up` computes: no bundle staging, no local content hash.
//
// A REPORT verb, not a result verb: the human table goes to stdout, `--json` swaps in the one object.

import { basename } from "node:path";
import { parseArgs } from "node:util";
import { IMAGES_CONFIGMAP, IMAGES_KEY, INSTANCE_SECRET, loadConfig, type ImageRefs } from "@jr2/orchestrator";
import { detectKitCheckout, KIT_IMAGE_HOME } from "../build.ts";
import type { InstanceIdentity } from "../client.ts";
import { compareVersions, LABEL_HASH, LABEL_VERSION, OPERATOR_DEPLOYMENT, OPERATOR_NAMESPACE } from "../deploy.ts";
import { handedOffFrom } from "../handoff.ts";
import { TARGET_ARGS, targetOptions, type TargetOptions } from "../instance.ts";
import { checkKitVersion, CLI_ROOT, CLI_VERSION } from "../kit-version.ts";
import { kubectlAdmin, kubectlKube, ORCHESTRATOR_PORT, ORCHESTRATOR_SERVICE, type KubeObject } from "../kube.ts";
import { activity, result, type Io } from "../output.ts";
import { findRoot } from "../root.ts";

/** A package as the report names it: the number and the real path, so the path says WHICH copy. */
export type Copy = { version: string; path: string };

/** The image map as `jr2 up` wrote it and pods read it (ADR-0038). */
type Images = Partial<ImageRefs & { operator?: string }>;

/** The comparison between the local kit line and the orchestrator line — the verdict the two
 * halves exist to produce. `unknown` when either side is missing. */
export type Skew = "same" | "behind" | "ahead" | "unknown";

export type VersionReport = {
  /** The copy that runs (after any handoff). */
  cli: Copy;
  /** The copy that handed off, when one did and said so (ADR-0056 as amended). */
  global?: Copy;
  node: string;
  /** Absent outside an Instance; `mode` decides whether deployed Kit tags read as versions
   * (installed) or content hashes (checkout). */
  instance?: {
    name: string;
    root: string;
    mode: "checkout" | "installed";
    kitCheckout?: string;
    /** Where an installed kit pulls its Kit images from: `kitRegistry`, else the canonical home. */
    kitRegistry?: string;
    configError?: string;
  };
  /** The Instance's Kit version — the `@jr2/orchestrator` it resolves — and the ADR-0056 check. */
  kit?: {
    version?: string;
    path?: string;
    /** What the manifest pins, when it disagrees with what resolves (or nothing resolves). */
    pinned?: string;
    check: "ok" | "mismatch" | "unresolved";
    /** This CLI's own peer, named when the check is not `ok`. */
    against?: Copy;
  };
  deployed?: {
    url?: string;
    context?: string;
    namespace?: string;
    orchestrator?: Orchestrator;
    operator?: { version?: string; image?: string };
    images?: Images;
  };
  skew?: Skew;
};

/** What the pod answers on `/healthz`, plus what the Deployment records — two facts, because a
 * rollout that has not landed leaves them disagreeing. Or why neither could be read. */
type Orchestrator = { version?: string; hash?: string; deploymentHash?: string; image?: string } | { error: string };

export async function version(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { ...TARGET_ARGS, local: { type: "boolean" }, json: { type: "boolean" } },
  });
  const opts = targetOptions(values);
  const report = await versionReport(io, opts, { local: values.local === true });
  if (values.json === true) result(io, report);
  else io.stdout(render(report));
  return 0;
}

/** The report as data — the whole verb minus its rendering, so tests read facts and not columns. */
export async function versionReport(io: Io, opts: TargetOptions, flags: { local: boolean }): Promise<VersionReport> {
  const report: VersionReport = {
    cli: { version: CLI_VERSION, path: CLI_ROOT },
    global: handedOffFrom(io.env),
    node: process.version,
  };

  const root = findRoot(io.cwd);
  let namespace: string | undefined;
  if (root) {
    const kit = checkKitVersion(root);
    report.kit = {
      version: kit.instance?.version,
      path: kit.instance?.root,
      // The pin is noise when it agrees with what resolves; it is the diagnosis when it does not.
      pinned: kit.pinned !== undefined && kit.pinned !== kit.instance?.version ? kit.pinned : undefined,
      check: kit.ok ? "ok" : kit.instance ? "mismatch" : "unresolved",
      against: kit.ok || !kit.own ? undefined : { version: kit.own.version, path: kit.own.root },
    };

    // The config names the Instance (its namespace by default) and where an installed kit pulls
    // from. A config that will not load is itself a fact worth a line — never a reason to stop.
    let config: Awaited<ReturnType<typeof loadConfig>>;
    let configError: string | undefined;
    try {
      config = await loadConfig(root);
    } catch (e) {
      configError = e instanceof Error ? e.message : String(e);
    }
    namespace = opts.namespace ?? config?.name ?? basename(root);
    const kitCheckout = await detectKitCheckout(io.kitDir);
    report.instance = {
      name: config?.name ?? basename(root),
      root,
      mode: kitCheckout ? "checkout" : "installed",
      kitCheckout,
      kitRegistry: kitCheckout ? undefined : (config?.kitRegistry ?? KIT_IMAGE_HOME),
      configError,
    };
  }

  if (!flags.local) {
    const url = opts.url ?? io.env.JR2_URL;
    if (url) {
      activity(io, `→ ${url}`);
      report.deployed = { url, orchestrator: await probeHealthz(io, url) };
    } else if (root && namespace) {
      report.deployed = await probeCluster(io, opts, namespace);
    }
    // No Instance and no `--url`: there is nothing to address, and the local half already says so.
  }

  report.skew = skew(report);
  return report;
}

/** `GET /healthz` — unauthenticated, so this needs no Instance token. The reason it could not be
 * read is the answer when it fails, since an unreachable orchestrator is what a user is debugging. */
async function probeHealthz(io: Io, url: string): Promise<Orchestrator> {
  const fetchImpl = io.fetch ?? globalThis.fetch;
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, "")}/healthz`);
    if (!res.ok) return { error: `GET /healthz answered HTTP ${res.status}` };
    const body = (await res.json()) as InstanceIdentity;
    return { version: body.version, hash: body.hash };
  } catch (e) {
    return { error: `unreachable — ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * The kube path, mirroring `resolveTarget`'s two-fault split (ADR-0019) without its refusals: a
 * Secret read that THROWS is a cluster that cannot be reached; an EMPTY answer is an Instance not
 * deployed there. Then the Deployment's records, the pod's own account over a port-forward, the
 * operator's label, and the image map pods actually read — each independently best-effort.
 */
async function probeCluster(io: Io, opts: TargetOptions, namespace: string): Promise<VersionReport["deployed"]> {
  const kube = io.kube ?? kubectlKube;
  const admin = io.kubeAdmin ?? kubectlAdmin;
  const context = opts.context ?? (await kube.currentContext());
  const deployed: VersionReport["deployed"] = { context, namespace };
  if (!context) {
    deployed.orchestrator = { error: "no kube context — nothing to ask" };
    return deployed;
  }
  activity(io, `→ context ${context} / namespace ${namespace}`);
  const ctx = opts.context ? { context: opts.context } : {};

  try {
    const secret = await kube.readSecret({ namespace, name: INSTANCE_SECRET, key: "JR2_INSTANCE_TOKEN", ...ctx });
    if (!secret) {
      deployed.orchestrator = { error: `not deployed in ${namespace} (context ${context}) — \`jr2 up\` deploys` };
      return deployed;
    }
  } catch (e) {
    deployed.orchestrator = { error: `cannot reach the cluster — context ${context}: ${(e as Error).message}` };
    return deployed;
  }

  const orch = await admin.getJson({ kind: "deployment", name: ORCHESTRATOR_SERVICE, namespace, ...ctx });
  const recorded = { deploymentHash: orch?.metadata.labels?.[LABEL_HASH], image: firstImage(orch) };
  let fwd: { url: string; close: () => void } | undefined;
  try {
    fwd = await kube.portForward({ namespace, service: ORCHESTRATOR_SERVICE, port: ORCHESTRATOR_PORT, ...ctx });
    const live = await probeHealthz(io, fwd.url);
    deployed.orchestrator = "error" in live ? live : { ...live, ...recorded };
  } catch (e) {
    deployed.orchestrator = { error: `port-forward failed — ${(e as Error).message}` };
  } finally {
    fwd?.close();
  }

  const operator = await admin.getJson({
    kind: "deployment",
    name: OPERATOR_DEPLOYMENT,
    namespace: OPERATOR_NAMESPACE,
    ...ctx,
  });
  if (operator) {
    deployed.operator = { version: operator.metadata.labels?.[LABEL_VERSION], image: firstImage(operator) };
  }

  const map = await admin.getJson<KubeObject & { data?: Record<string, string> }>({
    kind: "configmap",
    name: IMAGES_CONFIGMAP,
    namespace,
    ...ctx,
  });
  const raw = map?.data?.[IMAGES_KEY];
  if (raw) {
    try {
      deployed.images = JSON.parse(raw) as Images;
    } catch {
      // an unreadable map is reported by its absence; the orchestrator line already carries the hash
    }
  }
  return deployed;
}

/** The first container's image of a Deployment, read loosely — this is a report, not a contract. */
function firstImage(obj?: KubeObject): string | undefined {
  const spec = obj?.spec as { template?: { spec?: { containers?: Array<{ image?: string }> } } } | undefined;
  return spec?.template?.spec?.containers?.[0]?.image;
}

function skew(report: VersionReport): Skew {
  const local = report.kit?.version;
  const remote = report.deployed?.orchestrator;
  if (!local || !remote || "error" in remote || !remote.version) return "unknown";
  const d = compareVersions(remote.version, local);
  return d === 0 ? "same" : d < 0 ? "behind" : "ahead";
}

// --- rendering -----------------------------------------------------------------------------------

/** One row of the table: a label and its value. A blank label is the gap between the halves. */
type Row = [label: string, value: string];

const copy = (c: Copy): string => `${c.version.padEnd(8)} ${c.path}`;

/** The human table. Every row is one fact; the `skew` row is the only sentence. Labels are padded
 * to the longest present, so a `sandbox <key>` row cannot crowd its value. */
export function render(r: VersionReport): string {
  const rows: Row[] = [["cli", copy(r.cli)]];
  if (r.global) rows.push(["global", copy(r.global)]);
  if (r.kit) rows.push(["kit", renderKit(r.kit)]);
  if (r.instance) {
    const i = r.instance;
    const mode = i.mode === "checkout" ? `kit checkout at ${i.kitCheckout}` : `installed kit → ${i.kitRegistry}`;
    rows.push(["instance", `${i.name}  ${i.root}  (${mode})`]);
    if (i.configError) rows.push(["config", `failed to load — ${i.configError}`]);
  } else {
    rows.push(["instance", "none — no jr2.config.ts walking up from cwd"]);
  }
  rows.push(["node", r.node]);
  if (r.deployed) rows.push(["", ""], ...deployedRows(r.deployed, r));
  const width = Math.max(...rows.map(([label]) => label.length)) + 3;
  return rows.map(([label, value]) => (label ? `${`${label}:`.padEnd(width)}${value}` : "")).join("\n") + "\n";
}

function renderKit(k: NonNullable<VersionReport["kit"]>): string {
  const pinned = k.pinned !== undefined ? `; package.json pins ${k.pinned} — reinstall` : "";
  if (k.check === "unresolved") return `not installed${pinned}`;
  const head = copy({ version: k.version!, path: k.path! });
  if (k.check === "ok") return `${head}  ok${pinned}`;
  const against = k.against
    ? `this jr2 runs against ${k.against.version} (${k.against.path})`
    : "this jr2 has no @jr2/orchestrator beside it";
  return `${head}  MISMATCH — ${against}${pinned}`;
}

function deployedRows(d: NonNullable<VersionReport["deployed"]>, r: VersionReport): Row[] {
  const rows: Row[] = [];
  const o = d.orchestrator;
  if (!o) rows.push(["orchestrator", "not probed"]);
  else if ("error" in o) rows.push(["orchestrator", o.error]);
  else {
    const parts = [o.version ?? "(no version reported)"];
    if (o.hash) parts.push(`hash ${o.hash}`);
    if (o.deploymentHash && o.hash && o.deploymentHash !== o.hash) {
      parts.push(`(rollout incomplete: deployment records ${o.deploymentHash})`);
    }
    if (o.image) parts.push(o.image);
    rows.push(["orchestrator", parts.join("  ")]);
  }
  if (d.operator) {
    rows.push(["operator", `${d.operator.version ?? "(unlabeled)"}  ${d.operator.image ?? ""}`.trimEnd()]);
  }
  if (d.images) {
    if (d.images.harness) rows.push(["harness", d.images.harness]);
    if (d.images.adapter) rows.push(["adapter", d.images.adapter]);
    for (const [key, ref] of Object.entries(d.images.sandbox ?? {})) rows.push([`sandbox ${key}`, ref]);
  }
  const verdict = skewSentence(r);
  if (verdict) rows.push(["skew", verdict]);
  return rows;
}

function skewSentence(r: VersionReport): string | undefined {
  const local = r.kit?.version;
  const o = r.deployed?.orchestrator;
  const remote = o && !("error" in o) ? o.version : undefined;
  switch (r.skew) {
    case "behind":
      return `deployed ${remote} predates this kit ${local} — \`jr2 up\` converges it`;
    case "ahead":
      return (
        `deployed ${remote} is newer than this kit ${local} — \`jr2 up\` would roll the orchestrator back; ` +
        "the operator is never downgraded"
      );
    case "same":
      return r.instance?.mode === "checkout"
        ? "same version; checkout builds are content-addressed — compare the hash against `jr2 up`'s line"
        : undefined;
    default:
      return undefined;
  }
}
