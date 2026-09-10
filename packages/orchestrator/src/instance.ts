// The instance bootstrap (ADR-0008/0009): turn an instance folder into a *running* orchestrator.
// This is the core of the deployed app's entrypoint (`serverMain`) — the seam that assembles the
// slice-1/2/3 pieces into one process:
//
//   1. open the durable snapshot store (sqlite at `<dir>/.j2/state.db` by default — ADR-0009);
//   2. filename-discover `workflows/*.ts` (workflow name = filename, mirroring flue's
//      `agents/<name>.ts`; module contract, ADR-0011 revised by ADR-0015: `export const machine`
//      — the vocabulary rides the machine object via j2Setup); register on the RunHost;
//   3. `restore()` in-flight runs from the store (reconcile against the live world — ADR-0007);
//   4. serve the hono HTTP surface (`createApp`) so the CLI / humans can push + control + observe.
//
// The one design point worth stating (ADR-0011 static-import doctrine): a workflow module is
// self-contained — it declares its Agents and imports `gate` itself, in its own `setup` actors;
// everything live is constructed per-invocation from serializable input (the flue client from
// `input.endpoint`). The host injects NOTHING into workflow machines; `WorkflowDef.provide`
// remains a seam for tests, not a wiring obligation.

import { mkdir, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { AnyStateMachine } from "xstate";
import { createEchoPush } from "./harness-client.ts";
import { createApp } from "./http.ts";
import type { RepoReconcile } from "./repos.ts";
import { RunHost } from "./run-host.ts";
import type { RunRecord } from "./run-host.ts";
import { SqliteSnapshotStore } from "./snapshot-store.ts";
import type { SnapshotStore } from "./snapshot-store.ts";
import { createAuthenticator, loadSigningKey, mintInstanceToken } from "./tokens.ts";
import type { SandboxPort } from "./workspace.ts";

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
  /** The Sandbox backend for `workspace()` workflows (ADR-0012). Composed by the caller
   * (wired when `config.repos` is non-empty); absent = a workspace-less instance. */
  sandbox?: SandboxPort;
  /** The supervised source-volume reconcile (ADR-0048), started by the caller and never awaited:
   * its per-repo state is what `GET /repos` serves, and `close()` stops its retry loop. Absent =
   * a workspace-less instance, which reconciles nothing and reports no repos. */
  repos?: RepoReconcile;
  /** The Instance Harness base URL (ADR-0031) — where a `workspace: "none"` Turn is admitted.
   * The entrypoint derives it from the pod's namespace (deterministic Service DNS); absent,
   * such a Turn without an explicit `endpoint` faults pointedly. */
  instanceHarness?: string;
  /** The key Sandbox tokens are signed with (ADR-0013). Default: `<dir>/.j2/secret`, minted on
   * first boot. Supply it when the instance folder must stay untouched (tests), or when the same
   * key must reach a `kubectlSandbox` built before this call (it mints the tokens). */
  signingKey?: Buffer;
  /** The Instance token to authenticate with (ADR-0013/0019). Deployed, `j2 up` materializes it in
   * the instance's Secret and the entrypoint passes it here, so a pod restart keeps the credential
   * the CLI reads from that Secret. Default: minted per boot. */
  instanceToken?: string;
};

/** What changed on a `reload()` — the diff against the previously-registered set. */
export type ReloadResult = { added: string[]; updated: string[]; removed: string[]; workflows: string[] };

export type RunningInstance = {
  host: RunHost;
  /** The base URL the HTTP surface is reachable at (with the resolved port). */
  url: string;
  /**
   * The Instance token this boot serves under (ADR-0013): the credential for gates and run
   * control. Deployed it is supplied from the instance's Secret (ADR-0019) so it survives pod
   * restarts; when minted per boot instead, only this handle knows it. The SIGNING KEY behind the
   * Sandbox tokens must never rotate per boot either way (see `loadSigningKey`).
   */
  instanceToken: string;
  /** Names of the workflows discovered + registered from `<dir>/workflows`. */
  workflows: string[];
  /** The supervised source-volume reconcile this instance serves (ADR-0048), when it has one —
   * handed back so a caller can read its state or await its first pass without a second handle. */
  repos?: RepoReconcile;
  /** What this boot did with the runs it found persisted (ADR-0007, ADR-0030) — resumed, given up
   * on, refused because their Machine changed shape, or errored (left for the next boot to retry).
   * The entrypoint announces everything but the resumed ones. */
  restored: { reattached: string[]; lost: string[]; drifted: string[]; failed: string[] };
  /**
   * Re-discover `<dir>/workflows` and re-register every file, replacing changed definitions and
   * dropping deleted ones. A dev/test-only affordance — the deployed entrypoint ships workflows
   * baked into its image and never reloads. In-flight runs keep the
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

  // Resolved BEFORE the host: the Instance token is also the echo bearer (ADR-0023), so the
  // host's echo pusher closes over it. Served under in step 4 below, unchanged.
  const instanceToken = opts.instanceToken ?? mintInstanceToken();

  const host = new RunHost({
    store,
    reconcile: opts.reconcile,
    sandbox: opts.sandbox,
    instanceHarness: opts.instanceHarness,
    // The run-narrative echo (ADR-0023): tee a run's feed to its enclosing Workspace's Harness,
    // authenticated as the instance. The wire push is here and the fire-and-forget is the
    // host's, so a Harness that refuses (or is gone) costs a log line at most.
    echo: (endpoint) => createEchoPush({ baseUrl: endpoint, token: instanceToken }),
    // A run left `live` to be retried is otherwise unexplained — the announce line names it, this
    // says why (ADR-0030). stderr, because it is a fault, not the boot's structured result.
    onRestoreError: (runId, err) =>
      console.error(`restore failed for run ${runId}: ${err instanceof Error ? err.message : err}`),
  });

  // Bump per reload so `import()` re-reads a changed file rather than serving the ESM module cache.
  let importGen = 0;
  const registerFile = async (name: string, file: string): Promise<void> => {
    const machine = await importMachine(name, file, importGen);
    host.register({
      name,
      machine,
      // Nothing to inject (ADR-0011): the module imports its own actors; live clients are built
      // per-invocation from input. `provide` stays a test seam on WorkflowDef, unused here.
      provide: () => ({}),
    });
  };

  // 2. Filename discovery: every `workflows/<name>.ts` exports its Machine + event manifest by name.
  for (const { name, file } of await discoverWorkflows(opts.dir)) await registerFile(name, file);

  // 3. Resume in-flight runs persisted by a prior process (ADR-0007). The outcome is reported, not
  // swallowed (ADR-0030): a boot that declined to resume runs must say so, or "drifted" is only
  // discoverable by asking after a specific run id nobody knows to ask about.
  const restored = await host.restore();

  // 4. Serve, authenticated (ADR-0013). The signing key is loaded from (or minted into) the
  // instance folder, NOT generated per process: live Sandboxes outlive a restart, and their
  // Adapters still bear tokens this key signed. The Instance token is per-boot; the key is not.
  const signingKey = opts.signingKey ?? (await loadSigningKey(opts.dir));
  const auth = createAuthenticator({ instanceToken, signingKey });
  // The reconcile's state is read PER REQUEST, never snapshotted here: a repo synced by a retry
  // minutes after boot must show as synced the next time anyone asks (ADR-0048).
  const app = createApp(host, auth, { repos: opts.repos ? () => opts.repos!.state() : undefined });
  const server = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname });
  const port = await new Promise<number>((resolve) => {
    server.once("listening", () => resolve((server.address() as AddressInfo).port));
  });

  return {
    host,
    url: `http://${hostname}:${port}`,
    instanceToken,
    workflows: host.workflows(),
    repos: opts.repos,
    restored,
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
      // The retry loop first (ADR-0048): it outlives every request, so nothing else stops it —
      // and a fixture that closed its instance must not have git running behind it.
      opts.repos?.stop();
      // Before `server.close()`, not after: it waits for in-flight requests, and an observation
      // feed is in-flight until its watcher goes away. `host.close()` is what makes them go away.
      await host.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
  };
}

/** List `<dir>/workflows/*.ts` (ignoring `_`-prefixed helpers + `.d.ts`); name = filename stem. */
async function discoverWorkflows(dir: string): Promise<Array<{ name: string; file: string }>> {
  // An absent workflows/ dir → an instance with no workflows yet (still boots + serves).
  return discoverModules(join(dir, "workflows"));
}

/** Import one workflow module and take its Machine — the module contract (ADR-0011/0015):
 * `export const machine`. `gen` cache-busts a reload; 0 imports the module URL untouched. */
async function importMachine(name: string, file: string, gen = 0): Promise<AnyStateMachine> {
  const href = pathToFileURL(file).href + (gen ? `?v=${gen}` : "");
  const mod: { machine?: unknown } = await import(href);
  const machine = mod.machine as AnyStateMachine | undefined;
  if (!machine) {
    throw new Error(
      `workflow "${name}" (${file}) has no \`machine\` named export ` +
        `(module contract, ADR-0011/0015: \`export const machine\`)`,
    );
  }
  return machine;
}

/**
 * Discover + load every Workflow an instance folder registers — the same discovery and the same
 * module contract `startInstance` boots with, without booting.
 *
 * `j2 up` is the caller (ADR-0049/0050): a Machine carries its Agents and its Sandbox Image, so
 * the only way to know what a deployment must preflight and converge is to load the Machines and
 * WALK them (`agentsOf`, parts.ts). It lives here, beside the discovery it shares, so the
 * convention has one implementation rather than a second copy in the CLI that can drift.
 */
export async function loadWorkflows(dir: string): Promise<Array<{ name: string; machine: AnyStateMachine }>> {
  const loaded: Array<{ name: string; machine: AnyStateMachine }> = [];
  for (const { name, file } of await discoverWorkflows(dir)) {
    loaded.push({ name, machine: await importMachine(name, file) });
  }
  return loaded;
}

/**
 * The instance module-discovery convention: every `<moduleDir>/<name>.ts` except `_`-prefixed
 * helpers and `.d.ts`, sorted, name = filename stem. `workflows/` is the one directory that uses
 * it — the `agents/` folder it was also written for retired with ADR-0049 (an Agent is a part of a
 * Machine, not a file the instance discovers), and {@link discoverImages} mirrors it for
 * directories. An ABSENT dir is empty; any other readdir failure (EACCES, ENOTDIR, …) throws — a
 * directory that exists but cannot be read must be loud, never "no modules".
 */
export async function discoverModules(moduleDir: string): Promise<Array<{ name: string; file: string }>> {
  let entries: string[];
  try {
    entries = await readdir(moduleDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.startsWith("_"))
    .sort()
    .map((f) => ({ name: f.slice(0, -3), file: join(moduleDir, f) }));
}

/**
 * The Sandbox Images an instance authored (ADR-0037): every `<dir>/images/<name>/Dockerfile`, name
 * = the DIRNAME (the build context is that directory, so the image's content hash covers exactly
 * what its build can see). Same doctrine as {@link discoverModules} — filename discovery is the one
 * registration mechanism, an ABSENT dir is empty, `_`-prefixed entries are helpers, sorted — with
 * one difference: a subdirectory holding no `Dockerfile` THROWS, naming the missing path. Unlike a
 * stray `README.md`, a subdirectory of `images/` has no other reason to exist, so silence there
 * would be a Sandbox Image the author believes in and no converge ever builds.
 *
 * The Orchestrator process never calls this — refs reach it resolved, through the `j2-images`
 * ConfigMap (images.ts). It lives here so the convention has ONE implementation, beside the two it
 * mirrors, rather than a second copy in the CLI that can drift.
 */
export async function discoverImages(dir: string): Promise<Array<{ name: string; dir: string; dockerfile: string }>> {
  const imagesDir = join(dir, "images");
  let entries: Dirent[];
  try {
    entries = await readdir(imagesDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const names = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort();
  const found: Array<{ name: string; dir: string; dockerfile: string }> = [];
  for (const name of names) {
    const imageDir = join(imagesDir, name);
    const dockerfile = join(imageDir, "Dockerfile");
    try {
      await stat(dockerfile);
    } catch {
      throw new Error(
        `Sandbox Image "${name}" has no Dockerfile (${dockerfile}) — a directory under \`images/\` IS an ` +
          "image (ADR-0037: dirname = name, that directory = the build context).",
      );
    }
    found.push({ name, dir: imageDir, dockerfile });
  }
  return found;
}
