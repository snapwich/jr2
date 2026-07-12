// The instance bootstrap (ADR-0008/0009): turn an instance folder into a *running* orchestrator.
// This is the core of `j2 dev` and of the deployed app's entrypoint — the seam that assembles the
// slice-1/2/3 pieces into one process:
//
//   1. open the durable snapshot store (sqlite at `<dir>/.j2/state.db` by default — ADR-0009);
//   2. filename-discover `workflows/*.ts` (workflow name = filename, mirroring flue's
//      `agents/<name>.ts`; module contract = all named exports, ADR-0011: `export const machine`
//      + `export const events` — the manifest is a peer of the machine); register on the RunHost;
//   3. `restore()` in-flight runs from the store (reconcile against the live world — ADR-0007);
//   4. serve the hono HTTP surface (`createApp`) so the CLI / humans can push + control + observe.
//
// The one design point worth stating (ADR-0011 static-import doctrine): a workflow module is
// self-contained — it imports `agentRun`/`gate` itself and lists them in its own `setup` actors;
// everything live is constructed per-invocation from serializable input (the flue client from
// `input.endpoint`). The host injects NOTHING into workflow machines; `WorkflowDef.provide`
// remains a seam for tests, not a wiring obligation.

import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { AnyStateMachine } from "xstate";
import type { EventDef } from "@j2/agent-protocol";
import { createApp } from "./http.ts";
import { RunHost } from "./run-host.ts";
import type { RunRecord } from "./run-host.ts";
import { SqliteSnapshotStore } from "./snapshot-store.ts";
import type { SnapshotStore } from "./snapshot-store.ts";

export type InstanceOptions = {
  /** The instance folder (holds `workflows/`, and `.j2/state.db` unless `store` is supplied). */
  dir: string;
  /** Listen port. Default 0 → an ephemeral port (read back from the running instance's `url`). */
  port?: number;
  /** Listen hostname. Default `127.0.0.1`. */
  hostname?: string;
  /** Override the durable store. Default: sqlite at `<dir>/.j2/state.db`. */
  store?: SnapshotStore;
  /** Probe the live world before re-attaching on restore (ADR-0007). Default: always present. */
  reconcile?: (run: RunRecord) => boolean | Promise<boolean>;
};

/** What changed on a `reload()` — the diff against the previously-registered set. */
export type ReloadResult = { added: string[]; updated: string[]; removed: string[]; workflows: string[] };

export type RunningInstance = {
  host: RunHost;
  /** The base URL the HTTP surface is reachable at (with the resolved port). */
  url: string;
  /** Names of the workflows discovered + registered from `<dir>/workflows`. */
  workflows: string[];
  /**
   * Re-discover `<dir>/workflows` and re-register every file, replacing changed definitions and
   * dropping deleted ones. A DEV-ONLY affordance driven by `j2 dev`'s file watcher — a deployed
   * orchestrator ships workflows baked into its image and never reloads. In-flight runs keep the
   * definition they started on; only the next `start` sees new code (ADR-0009).
   */
  reload: () => Promise<ReloadResult>;
  /** Stop the HTTP server and close the store. */
  close: () => Promise<void>;
};

/** Boot an instance folder into a running orchestrator (discover → restore → serve). */
export async function startInstance(opts: InstanceOptions): Promise<RunningInstance> {
  const hostname = opts.hostname ?? "127.0.0.1";

  // 1. Durable store. Default sqlite needs its parent dir to exist before `DatabaseSync` opens it.
  let store = opts.store;
  if (!store) {
    await mkdir(join(opts.dir, ".j2"), { recursive: true });
    store = new SqliteSnapshotStore(join(opts.dir, ".j2", "state.db"));
  }
  await store.init();

  const host = new RunHost({ store, reconcile: opts.reconcile });

  // Bump per reload so `import()` re-reads a changed file rather than serving the ESM module cache.
  let importGen = 0;
  const registerFile = async (name: string, file: string): Promise<void> => {
    const href = pathToFileURL(file).href + (importGen ? `?v=${importGen}` : "");
    const mod: { machine?: unknown; events?: unknown } = await import(href);
    const machine = mod.machine as AnyStateMachine | undefined;
    if (!machine) {
      throw new Error(
        `workflow "${name}" (${file}) has no \`machine\` named export ` +
          `(module contract, ADR-0011: \`export const machine\` + \`export const events\`)`,
      );
    }
    if (mod.events !== undefined && !Array.isArray(mod.events)) {
      throw new Error(`workflow "${name}" (${file}): \`events\` export must be an array of defineEvent() defs`);
    }
    host.register({
      name,
      machine,
      events: mod.events as EventDef[] | undefined,
      // Nothing to inject (ADR-0011): the module imports its own actors; live clients are built
      // per-invocation from input. `provide` stays a test seam on WorkflowDef, unused here.
      provide: () => ({}),
    });
  };

  // 2. Filename discovery: every `workflows/<name>.ts` exports its Machine + event manifest by name.
  for (const { name, file } of await discoverWorkflows(opts.dir)) await registerFile(name, file);

  // 3. Resume in-flight runs persisted by a prior process (ADR-0007).
  await host.restore();

  // 4. Serve. `serve` binds asynchronously; resolve once listening so `url` carries the real port.
  const app = createApp(host);
  const server = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname });
  const port = await new Promise<number>((resolve) => {
    server.once("listening", () => resolve((server.address() as AddressInfo).port));
  });

  return {
    host,
    url: `http://${hostname}:${port}`,
    workflows: host.workflows(),
    reload: async () => {
      importGen++;
      const before = new Set(host.workflows());
      const found = await discoverWorkflows(opts.dir);
      const foundNames = new Set(found.map((f) => f.name));
      for (const { name, file } of found) await registerFile(name, file);
      const removed: string[] = [];
      for (const name of before) if (!foundNames.has(name)) (host.unregister(name), removed.push(name));
      const added = [...foundNames].filter((n) => !before.has(n));
      const updated = [...foundNames].filter((n) => before.has(n));
      return { added, updated, removed, workflows: host.workflows() };
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
  };
}

/** List `<dir>/workflows/*.ts` (ignoring `_`-prefixed helpers + `.d.ts`); name = filename stem. */
async function discoverWorkflows(dir: string): Promise<Array<{ name: string; file: string }>> {
  const wfDir = join(dir, "workflows");
  let entries: string[];
  try {
    entries = await readdir(wfDir);
  } catch {
    return []; // no workflows/ dir → an instance with no workflows yet (still boots + serves)
  }
  return entries
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.startsWith("_"))
    .sort()
    .map((f) => ({ name: f.slice(0, -3), file: join(wfDir, f) }));
}
