// `j2 dev [--port <p>] [--hostname <h>]` (ADR-0009): boot THIS instance's orchestrator in-process and
// serve it until Ctrl-C. "Local control plane, real data plane" — `startInstance` discovers
// `workflows/`, restores in-flight runs, and serves the hono surface; the data plane (real Sandboxes)
// is the orchestrator's concern, stubbed until that slice lands.
//
// Two CLI-specific jobs on top of `startInstance`:
//   1. advertise the live address by writing `.j2/dev.json` = { url, token, pid } so the run-control
//      verbs can attach AND authenticate (ADR-0013), and remove it on a clean exit. 0600: that token
//      opens every gate on every run, so it is a credential, not an address;
//   2. hot-reload: watch `<root>/workflows` and re-register on change. This lives HERE, not in the
//      engine — a deployed orchestrator ships workflows baked into its image and has no source tree
//      to watch, so file-watching is a dev-only affordance (see `RunningInstance.reload`).
//
// This command is intentionally not part of the testable `Io` surface for its lifecycle bits: it owns
// process signals and blocks forever, so it is exercised end-to-end rather than in unit tests.

import { watch } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  ensureRepos,
  kubectlSandbox,
  loadConfig,
  loadSigningKey,
  startInstance,
  startStubHarness,
} from "@j2/orchestrator";
import type { SandboxPort } from "@j2/orchestrator";
import { readClusterJson } from "./cluster.ts";
import { resolveRoot } from "../instance.ts";
import { activity, type Io } from "../output.ts";

/**
 * The port a SANDBOXED instance's `j2 dev` binds by default — derived from the instance path, so it
 * is the same on every boot (ADR-0013).
 *
 * It has to be. A live Sandbox outlives the orchestrator process (ADR-0012: restore re-attaches to
 * it), but its Adapter's `J2_ORCHESTRATOR_URL` is baked into the pod at provision and pods are
 * immutable — so an ephemeral port would leave every already-running Adapter dialing a dead socket
 * the moment `j2 dev` restarted. Deployed, this address is Service DNS and stable by nature; in dev
 * we make it stable by construction. (The same argument, and the same trick, as `forwardPort`.)
 */
export function stableDevPort(root: string): number {
  let h = 0;
  for (const ch of root) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return 7000 + ((h >>> 0) % 1000);
}

export async function dev(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { port: { type: "string" }, hostname: { type: "string" } },
  });

  const root = resolveRoot(io.cwd);

  // The Sandbox backend (ADR-0012): `config.sandbox` present = this instance has a cluster —
  // reconcile the source volume (`repos/<name>/default`, ADR-0009 boot reconcile) BEFORE any
  // restore can re-attach a Workspace, then wire the kubectl port. Absent = workspace-less
  // instance; workspace() invocations fault pointedly, everything else runs as before.
  const config = await loadConfig(root);
  let sandbox: SandboxPort | undefined;
  let signingKey: Buffer | undefined;
  // Resolved after the server binds (a `--port 0` instance does not know its own address yet), and
  // read only at provision time — which is why `orchestratorUrl` below is a thunk.
  let orchestratorUrl: string | undefined;

  if (config?.sandbox) {
    for (const repo of await ensureRepos(config, join(root, "repos"))) {
      activity(io, `  repos/${repo.name}: ${repo.action}`);
    }
    // The key that signs this instance's Sandbox tokens (ADR-0013). It persists across restarts, so
    // a Sandbox provisioned by a previous `j2 dev` still bears a token this one accepts — which is
    // what ADR-0012's re-attach promises the Adapter that has been running all along.
    signingKey = await loadSigningKey(root);
    sandbox = kubectlSandbox({
      image: config.sandbox.image,
      adapterImage: config.sandbox.adapterImage,
      orchestratorUrl: () => orchestratorUrl,
      signingKey,
      namespace: config.sandbox.namespace,
      context: config.sandbox.context,
      idleTimeout: config.sandbox.idleTimeout,
    });
  }

  // Reachability (ADR-0013): a Sandbox's Adapter dials the orchestrator from INSIDE the cluster, so
  // on a sandboxed instance `j2 dev` must be reachable from off-host — loopback is not. That is the
  // same flag: `config.sandbox` present == "this instance has a cluster". Workspace-less instances
  // keep binding loopback, and stay unreachable from anywhere but this machine.
  const inst = await startInstance({
    dir: root,
    // An explicit --port always wins. Otherwise: a stable port when this instance has Sandboxes
    // (their Adapters hold this address across restarts — see `stableDevPort`), ephemeral when it
    // does not (nothing outside the process remembers it).
    port: values.port !== undefined ? Number(values.port) : config?.sandbox ? stableDevPort(root) : undefined,
    hostname: (values.hostname as string | undefined) ?? (config?.sandbox ? "0.0.0.0" : undefined),
    sandbox,
    signingKey,
  });

  // Now that the port is known, complete the Adapter's route home: the pod→host address `j2 cluster
  // up` recorded, plus this process's port. Every Sandbox provisioned from here carries it as env.
  const cluster = config?.sandbox ? readClusterJson(root) : undefined;
  const port = new URL(inst.url).port;
  if (cluster?.podToHost) orchestratorUrl = `http://${cluster.podToHost}:${port}`;

  // The wire-compatible stub Harness (ADR-0011): workspace-less test workflows pass its URL as
  // their run-input `endpoint` — agentRun admits against it and parks; e2e/humans then drive the
  // Machine by playing the ADAPTER against `<url>/agents/<iid>/*`. Workflows that provision
  // Workspaces never use this: their Sandboxes are always real, and their Agents drive themselves
  // through a real Adapter (kind — ADR-0009/0013).
  const stub = await startStubHarness();

  // What a CLIENT dials. Binding 0.0.0.0 is a listen address, not an address anything connects to,
  // so advertise loopback: the CLI and the e2e suite are on this host. (The POD's route to the
  // orchestrator is a different string entirely — see `orchestratorUrl` above.)
  const url = inst.url.replace("://0.0.0.0:", "://127.0.0.1:");
  const devPath = join(root, ".j2", "dev.json");
  await mkdir(join(root, ".j2"), { recursive: true });
  await writeFile(
    devPath,
    `${JSON.stringify({ url, token: inst.instanceToken, stubHarness: stub.url, pid: process.pid }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(devPath, 0o600); // an existing file keeps its old mode through writeFile

  activity(io, `j2 dev — serving ${root}`);
  activity(io, `  url:          ${url}`);
  activity(io, `  stub harness: ${stub.url}`);
  activity(
    io,
    `  sandboxes:    ${config?.sandbox ? `kubectl (${config.sandbox.image})` : "(none — workspace() workflows will fault)"}`,
  );
  if (config?.sandbox) {
    // The Agent's whole route home, in one line — and the loudest possible failure when it is
    // missing, because a Sandbox without it produces an Agent that simply cannot act (ADR-0013).
    activity(
      io,
      `  adapter:      ${
        config.sandbox.adapterImage
          ? `${config.sandbox.adapterImage} → ${orchestratorUrl ?? "NO ROUTE (run `j2 cluster up`)"}`
          : "(none — Agents in a Sandbox will have no route to their Machine)"
      }`,
    );
  }
  activity(io, `  workflows:    ${inst.workflows.join(", ") || "(none)"}`);
  activity(io, "  press Ctrl-C to stop");

  // Hot-reload: debounce a burst of fs events (an editor save fires several) into one `reload()`.
  const wfDir = join(root, "workflows");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = async (): Promise<void> => {
    try {
      const { added, removed, updated, workflows } = await inst.reload();
      const delta = [...added.map((n) => `+${n}`), ...removed.map((n) => `-${n}`), ...updated.map((n) => `~${n}`)];
      activity(io, `reloaded ${delta.join(" ") || "(no change)"} — workflows: ${workflows.join(", ") || "(none)"}`);
    } catch (err) {
      activity(io, `reload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  try {
    watch(wfDir, (_event, filename) => {
      if (filename && (!filename.endsWith(".ts") || filename.startsWith("_"))) return;
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 80);
    });
  } catch {
    // no `workflows/` dir yet → nothing to watch; the instance still serves.
  }

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    activity(io, "stopping…");
    await inst.close();
    await stub.close();
    await rm(devPath, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise<void>(() => {}); // serve until a signal triggers shutdown
  return 0; // unreachable
}
