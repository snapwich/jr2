// `j2 down [--all] [-n <ns>] [--context <ctx>]` (ADR-0019): remove the instance from the cluster —
// its namespace and everything `j2 up` converged into it. ALWAYS confirms (deleting a namespace
// takes the runs, the store PVC, and every live Sandbox with it). `--all` also uninstalls the
// per-cluster operator — only sane when this was the cluster's last instance, which is the
// caller's judgment, not derivable here.

import { basename } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "@j2/orchestrator";
import { KIT_VERSION, LABEL_INSTANCE, operatorManifest } from "../deploy.ts";
import { resolveRoot } from "../instance.ts";
import { kubectlAdmin } from "../kube.ts";
import { activity, confirmOrBail, type Io } from "../output.ts";

export async function down(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      all: { type: "boolean" },
      namespace: { type: "string", short: "n" },
      context: { type: "string" },
    },
  });

  const root = resolveRoot(io.cwd);
  const config = (await loadConfig(root)) ?? {};
  const name = config.name ?? basename(root);
  const namespace = (values.namespace as string | undefined) ?? name;
  const kube = io.kubeAdmin ?? kubectlAdmin;
  const context = (values.context as string | undefined) ?? (await kube.context());
  if (!context) throw new Error("no kube context — nothing to remove from");
  const ctx = values.context ? { context: values.context as string } : {};

  const ns = await kube.getJson({ kind: "namespace", name: namespace, ...ctx });
  const owner = ns?.metadata.labels?.[LABEL_INSTANCE];
  if (!ns || !owner) {
    activity(io, `not deployed here — namespace "${namespace}" on ${context} holds no j2 instance`);
    return 1;
  }
  if (owner !== name) {
    activity(io, `refusing: namespace "${namespace}" on ${context} belongs to another instance ("${owner}")`);
    return 1;
  }

  const scope = values.all ? " AND the per-cluster operator" : "";
  const ok = await confirmOrBail(
    io,
    `remove instance "${name}" from context ${context} (delete namespace "${namespace}"${scope})?`,
  );
  if (!ok) {
    activity(io, "aborted — nothing was changed");
    return 1;
  }

  activity(io, `deleting namespace "${namespace}" (runs, store, and Sandboxes go with it)`);
  await kube.deleteObject({ kind: "Namespace", name: namespace, ...ctx });

  if (values.all) {
    activity(io, "uninstalling the operator (j2-system)");
    // The image ref doesn't matter for a delete-by-manifest; the object names do.
    await kube.deleteManifest({ manifest: await operatorManifest(`j2-operator:${KIT_VERSION}`), ...ctx });
  }

  activity(io, "removed");
  return 0;
}
