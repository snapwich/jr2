// The instance bootstrap (ADR-0008/0009): turn an instance folder into a *running* orchestrator.
// This is the core of the deployed app's entrypoint (`serverMain`) — the seam that assembles the
// slice-1/2/3 pieces into one process:
//
//   1. open the durable snapshot store (sqlite at `<dir>/.jr2/state.db` by default — ADR-0009);
//   2. filename-discover `workflows/*.ts` in the CURRENT ASSEMBLY's root (ADR-0069: the published
//      tree under `<dir>/.jr2/assemblies/<hash>`; none before the first publish), each def stamped
//      with that Assembly's hash (workflow name = filename, mirroring flue's
//      `agents/<name>.ts`; module contract, ADR-0011 revised by ADR-0015: `export const machine`
//      — the vocabulary rides the machine object via jr2Setup); register on the RunHost. Then the
//      named Charts (ADR-0070): the Assembly's Chart files `workflows/<wrapper>/<name>.chart.json`
//      and the runtime Charts on the volume (`<dir>/.jr2/charts`), each admitted against its
//      wrapper and registered as the Workflow `<wrapper>/<name>`, or kept unrunnable with why;
//   3. `restore()` in-flight runs from the store (reconcile against the live world — ADR-0007),
//      each inside the Assembly its snapshot names (ADR-0069). With no current Assembly the live
//      rows wait, untouched, and the first publish restores them. Then sweep finished runs older
//      than a week and collect every Assembly no live row holds, and again every hour (ADR-0065,
//      ADR-0069);
//   4. serve the hono HTTP surface (`createApp`) so the CLI / humans can push + control + observe.
//
// The one design point worth stating (ADR-0011 static-import doctrine): a workflow module is
// self-contained — it declares its Agents and imports `gate` itself, in its own `setup` actors;
// everything live is constructed per-invocation from serializable input (the flue client from
// `input.endpoint`). The host injects NOTHING into workflow machines; `WorkflowDef.provide`
// remains a seam for tests, not a wiring obligation.

import { mkdir, readdir, stat } from "node:fs/promises";
import type { JR2Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import {
  assemblyDoor,
  heldAssemblies,
  heldAssembly,
  removeStaging,
  resolveAssembly,
  type AssemblyDoor,
  type CurrentAssembly,
  type ResolvedAssembly,
} from "./assembly.ts";
import { assemblyRefusals, type LoadedWorkflow } from "./assembly-checks.ts";
import {
  chartName,
  NamedCharts,
  readChartFiles,
  readRuntimeCharts,
  splitChartName,
  type ChartCounts,
  type ChartFile,
} from "./charts.ts";
import type { ImageRefs } from "./images.ts";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { AnyStateMachine } from "xstate";
import { createEchoPush, createLiveSetPush } from "./harness-client.ts";
import { createApp } from "./http.ts";
import type { FetchAnswer } from "./repo-fetch.ts";
import type { RepoStatus } from "./repos.ts";
import { RunHost } from "./run-host.ts";
import type { RunRecord, WorkflowDef } from "./run-host.ts";
import { SqliteSnapshotStore } from "./snapshot-store.ts";
import type { SnapshotStore } from "./snapshot-store.ts";
import { createAuthenticator, effectorKey, harnessToken, loadSigningKey, mintInstanceToken } from "./tokens.ts";
import type { SandboxPort } from "./workspace.ts";
import type { EffectorPlacement, EffectorTarget } from "./http-effect.ts";
import { WORKFLOW_NAME } from "./effector-wire.ts";

export type InstanceOptions = {
  /** The instance folder: the state volume `.jr2/` (its `state.db` unless `store` is supplied, and
   * its published Assemblies). Nothing else in it is read: the Workflows are the current
   * Assembly's (ADR-0069). */
  dir: string;
  /** Which Assembly to load (ADR-0069). Default: `resolveAssembly(dir)`. The entrypoint resolves
   * it first, because it reads the config from the same root before it builds the ports. */
  assembly?: ResolvedAssembly;
  /** The publish token (ADR-0069): the one credential `PUT /assembly` accepts. Deployed, from the
   * instance Secret (`JR2_PUBLISH_TOKEN`). Default: minted per boot. */
  publishToken?: string;
  /** The image map, read when the door checks a publish (ADR-0069). Present only when deployed;
   * absent, the door does not check `file:` image contexts. */
  imageMap?: () => Promise<ImageRefs>;
  /** The digests of the mounted ConfigMaps, which `GET /assembly` reports (ADR-0069). Present only
   * when deployed. */
  mounts?: () => Promise<Record<string, string>>;
  /** Called after a publish has landed and the Workflows swapped: the new current Assembly, its
   * config and its Machines, which the entrypoint swaps into the ports (ADR-0069). Synchronous, so
   * the swap cannot half-apply. */
  onPublish?: (published: {
    current: CurrentAssembly;
    config: JR2Config | undefined;
    workflows: LoadedWorkflow[];
  }) => void;
  /** Called after the restore a boot with no current Assembly deferred, which the first publish
   * that lands runs (ADR-0069): the hash it landed, and what the restore did. The entrypoint
   * announces the runs it did not resume. A boot with a current Assembly never calls it: its
   * outcome is `RunningInstance.restored`. */
  onRestore?: (outcome: { assembly: string } & RestoreOutcome) => void;
  /** Called with the hashes the hourly sweep collected, when it collected any (ADR-0069): the
   * entrypoint announces them as one line. The boot's collection is `RunningInstance.collected`;
   * a publish's rides its answer. Default: one log line. */
  onCollect?: (collected: string[]) => void;
  /** How one Assembly's Workflows are imported from its root. Default: `loadWorkflows`. A test
   * seam, so a test can count the imports per Assembly that the ESM cache would hide. */
  importWorkflows?: (root: string) => Promise<LoadedWorkflow[]>;
  /** Listen port. Default 0 → an ephemeral port (read back from the running instance's `url`). */
  port?: number;
  /** Listen hostname. Default `127.0.0.1`. */
  hostname?: string;
  /** Override the durable store. Default: sqlite at `<dir>/.jr2/state.db`. */
  store?: SnapshotStore;
  /** Probe the live world before re-attaching on restore (ADR-0007). Default: always present. */
  reconcile?: (run: RunRecord) => boolean | Promise<boolean>;
  /** The Sandbox backend for `workspace()` workflows (ADR-0012). Composed by the caller — wired
   * whenever the process is deployed (ADR-0069); absent = an instance without a data plane, whose
   * `workspace()` runs fault pointedly. */
  sandbox?: SandboxPort;
  /** Whether the instance has a data plane (ADR-0051) — what `GET /repos` reports beside the
   * Repos, so `jr2 status` can say "no Workspace runs here" instead of listing nothing. */
  dataPlane?: boolean;
  /** The Repo resources as the cluster reports them (ADR-0051), read per request off the port the
   * caller built. Absent = no data plane, which reports no Repos. */
  repos?: () => Promise<RepoStatus[]>;
  /** The ask a pod makes when something inside it fetches (ADR-0053), off the port the caller
   * built. Absent = no data plane, so no Sandbox to ask for. */
  fetchRepo?: (sandbox: string, identity: string) => Promise<FetchAnswer>;
  /** The Instance Harness base URL (ADR-0031) — where a `workspace: "none"` Turn is admitted.
   * The entrypoint derives it from the pod's namespace (deterministic Service DNS); absent,
   * such a Turn without an explicit `endpoint` faults pointedly. */
  instanceHarness?: string;
  /** The name this Orchestrator gives itself at another Orchestrator's door (ADR-0071): a foreign
   * dispatch's `dispatchedBy.instance`. The entrypoint passes the pod's namespace; absent, a foreign
   * dispatch names an unnamed caller. */
  orchestratorName?: string;
  /** The Instance Effector's headless Service, `host:port` (ADR-0068) — where an http Effect is sent.
   * The entrypoint derives it from the pod's namespace; absent, an http Effect faults pointedly. */
  instanceEffector?: string;
  /** A Sandbox Effector's address, `host:port`, by its Sandbox's name (ADR-0068) — where a push, an
   * file-body http or a credentialed command is sent. The entrypoint derives it from the pod's namespace and
   * the Service the provision writes; absent, those Effects fault pointedly. */
  sandboxEffector?: (sandbox: string) => string;
  /** The key Sandbox tokens are signed with (ADR-0013). Default: `<dir>/.jr2/secret`, minted on
   * first boot. Supply it when the instance folder must stay untouched (tests), or when the same
   * key must reach a `kubeSandbox` built before this call (it mints the tokens). */
  signingKey?: Buffer;
  /** The Instance token to authenticate with (ADR-0013/0019). Deployed, `jr2 up` materializes it in
   * the instance's Secret and the entrypoint passes it here, so a pod restart keeps the credential
   * the CLI reads from that Secret. Default: minted per boot. */
  instanceToken?: string;
};

/** What one restore did with the runs it found persisted (ADR-0007, ADR-0030). */
export type RestoreOutcome = { reattached: string[]; lost: string[]; drifted: string[]; failed: string[] };

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
  /** The publish token this boot accepts on `PUT /assembly` (ADR-0069). Fixtures read it here. */
  publishToken: string;
  /** The Assembly this process serves now (ADR-0069); `null` while it holds none. A publish
   * replaces it. */
  readonly assembly: CurrentAssembly | null;
  /** Why the boot found no current Assembly where the volume named one. */
  assemblyError?: string;
  /** Names of the workflows discovered + registered from the Assembly's `workflows/` at boot,
   * the runnable named Charts (`<wrapper>/<name>`, ADR-0070) among them. */
  workflows: string[];
  /** The named Charts (ADR-0070): the Assembly's Chart files and the runtime Charts on the volume,
   * and the ones that cannot run now, with why. Read when asked: a `PUT` or a publish changes it. */
  readonly charts: ChartCounts;
  /** The Machines of every Assembly held now (ADR-0069): the current one's, then those of each
   * Assembly a live run holds that this process can import. What the Repo pass binds: a held run's
   * Workspace mounts the Repos its own Machine binds, whatever the current Assembly binds. An
   * Assembly that cannot be imported lends nothing: its runs are drifted or failed. */
  heldMachines: () => Promise<AnyStateMachine[]>;
  /** What this boot did with the runs it found persisted (ADR-0007, ADR-0030, ADR-0069) — resumed
   * inside the Assembly each names, given up on, refused because their Assembly or their Machine
   * can no longer be read, or errored (left for the next boot to retry). The entrypoint announces
   * everything but the resumed ones. Empty when the boot had no current Assembly: those runs are
   * `waiting`. */
  restored: RestoreOutcome;
  /**
   * The live runs a boot with no current Assembly left untouched (ADR-0069). No config is bound
   * in that window, and at a Kit bump every held Assembly is still at the old Kit version, so a
   * restore now would drift runs that an image rollback could resume. The first publish that lands
   * restores them, under the config it binds (`onRestore`). Empty when the boot had a current
   * Assembly.
   */
  waiting: string[];
  /** The Assemblies this boot collected after its restore (ADR-0069): on the volume, not current,
   * and held by no live run. Sorted. */
  collected: string[];
  /**
   * The door's checks 4 to 6 over a staging directory that holds an unpacked `tree/` (ADR-0069):
   * the hash, the import and the walk, the landing, the swap. What a publish calls after the
   * unpack; a test calls it on a copied tree. In-flight runs keep the definition they started on;
   * only the next `start` sees the new code (ADR-0009).
   */
  admit: AssemblyDoor["admit"];
  /** Stop the HTTP server and close the store. */
  close: () => Promise<void>;
};

/**
 * How long a finished run's row lives, and how often the sweep looks (ADR-0065). Fixed, not config,
 * like the Sandbox idle timeout: jr2 is not the record of a run's results, and `jr2 status` on an
 * old run is a debugging act. A week is the time a human has to read it.
 */
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

/** Boot an instance folder into a running orchestrator (discover → restore → serve). */
export async function startInstance(opts: InstanceOptions): Promise<RunningInstance> {
  const hostname = opts.hostname ?? "127.0.0.1";

  // 1. Durable store. Default sqlite needs its parent dir to exist before `DatabaseSync` opens it.
  let store = opts.store;
  if (!store) {
    await mkdir(join(opts.dir, ".jr2"), { recursive: true });
    store = new SqliteSnapshotStore(join(opts.dir, ".jr2", "state.db"));
  }
  await store.init();

  // Resolved BEFORE the host, and the signing key with it: the host derives every Harness bearer
  // from the key (ADR-0058) — admission, stream, abort, echo. The key is loaded from (or minted
  // into) the instance folder, NOT generated per process: live Sandboxes outlive a restart, their
  // Custodians still hold tokens this key signed, and their Harnesses still check bearers it derived.
  // The Instance token is per-boot; the key is not. Both are served under in step 4 below.
  const instanceToken = opts.instanceToken ?? mintInstanceToken();
  const publishToken = opts.publishToken ?? mintInstanceToken();
  const signingKey = opts.signingKey ?? (await loadSigningKey(opts.dir));

  // Which Assembly this boot serves (ADR-0069). A publish that crashed before its pointer flip
  // left a `.staging-*`: it is not an Assembly, so it is removed and never read.
  await removeStaging(opts.dir);
  const resolved = opts.assembly ?? (await resolveAssembly(opts.dir));
  let current = resolved.current;

  // The Machines of each Assembly this process has imported, by hash (ADR-0069): a held Assembly
  // is imported once, whether one run holds it or fifty, and the current one shares the entry. A
  // load that fails is not kept, so a fault on the volume is tried again by the next restore. An
  // Assembly the collection removes leaves the map; Node's module cache keeps its modules, which no
  // run reaches any more.
  const imported = new Map<string, Promise<LoadedWorkflow[]>>();
  const importWorkflows = opts.importWorkflows ?? loadWorkflows;
  const importAssembly = (hash: string, root: string): Promise<LoadedWorkflow[]> => {
    let loading = imported.get(hash);
    if (!loading) {
      loading = importWorkflows(root);
      imported.set(hash, loading);
      loading.catch(() => imported.delete(hash));
    }
    return loading;
  };

  /**
   * A run's Workflow inside the Assembly its snapshot names (ADR-0069): the tree and the record on
   * the volume, at this Orchestrator's Kit version, and its `workflows/<name>.ts` imported. Every
   * other answer is drift naming the hash: the snapshot is intact, and this process can no longer
   * read it. The def is not registered: the registry is the current Assembly's alone.
   */
  const resolveDef = async (blob: {
    workflow: string;
    assembly: string;
  }): Promise<WorkflowDef | { drifted: string }> => {
    const held = await heldAssembly(opts.dir, blob.assembly);
    if ("error" in held) return { drifted: `workflow "${blob.workflow}": ${held.error}` };
    let loaded: LoadedWorkflow[];
    try {
      loaded = await importAssembly(blob.assembly, held.root);
    } catch (err) {
      return {
        drifted: `workflow "${blob.workflow}": the Assembly ${blob.assembly} does not load: ${err instanceof Error ? err.message : err}`,
      };
    }
    // A named Chart's run (ADR-0070, D-B) is read by its wrapper's Machine: the Chart text it ran
    // is in the body's own snapshot, so the run holds it even when the name is gone.
    const machineName = splitChartName(blob.workflow)?.wrapper ?? blob.workflow;
    const found = loaded.find((w) => w.name === machineName);
    if (!found) {
      return {
        drifted: `workflow "${blob.workflow}": the Assembly ${blob.assembly} does not load: it holds no workflows/${machineName}.ts`,
      };
    }
    // `provide` injects nothing, as at register (ADR-0011).
    return { name: blob.workflow, machine: found.machine, provide: () => ({}), assembly: blob.assembly };
  };

  const host = new RunHost({
    store,
    reconcile: opts.reconcile,
    resolveDef,
    sandbox: opts.sandbox,
    instanceHarness: opts.instanceHarness,
    ...(opts.orchestratorName !== undefined ? { orchestratorName: opts.orchestratorName } : {}),
    harnessBearer: (placement) => harnessToken(signingKey, placement),
    // The Effectors (ADR-0068): each placement's Service, and the key its wire is signed with —
    // derived from the signing key as the Harness bearer is, so nothing is stored. The Instance
    // Effector's key is `effectorKey(signingKey, "instance")`; a Sandbox Effector's is its Sandbox's
    // name's, as the provision wrote it, and its Service is the one the provision wrote beside it.
    ...(opts.instanceEffector || opts.sandboxEffector
      ? { effector: (placement: EffectorPlacement) => effectorTarget(placement, opts, signingKey) }
      : {}),
    // The run-narrative echo (ADR-0023): tee a run's feed to its enclosing Workspace's Harness,
    // bearing that Workspace's Harness bearer (ADR-0058) — never the Instance token, which would
    // otherwise pass through a process the Agent executes code beside. The wire push is here and
    // the fire-and-forget is the host's, so a Harness that refuses (or is gone) costs a log line.
    echo: (endpoint, bearer) => createEchoPush({ baseUrl: endpoint, ...(bearer ? { token: bearer } : {}) }),
    // The live-set statement (ADR-0031): the host tells the Instance Harness which conversations
    // its live runs hold, and the Harness frees the rest. Stated only when the host knows one.
    liveSet: (endpoint, bearer) => createLiveSetPush({ baseUrl: endpoint, ...(bearer ? { token: bearer } : {}) }),
    // A run left `live` to be retried is otherwise unexplained — the announce line names it, this
    // says why (ADR-0030). stderr, because it is a fault, not the boot's structured result.
    onRestoreError: (runId, err) =>
      console.error(`restore failed for run ${runId}: ${err instanceof Error ? err.message : err}`),
    // An in-process dispatch of a named Chart the current Assembly left unrunnable answers 409, as
    // the HTTP door does (ADR-0071). The registry is built after the host; this runs only at a start.
    unrunnableChart: (name): string | undefined => charts.get(name)?.unrunnable,
  });

  // The named Charts (ADR-0070). The runtime ones are read from the volume now, and admitted when
  // the first Assembly binds; with none current, every one waits unrunnable ("not in the current
  // Assembly") and is never deleted.
  const charts: NamedCharts = new NamedCharts({ dir: opts.dir, host });
  await charts.load();
  // The current Assembly's own Workflow names (ADR-0069, ADR-0070): its Machines and its Chart
  // files, as its record lists them. `GET /assembly` answers these; the runtime Charts the host
  // also registers are not part of an Assembly.
  let currentWorkflows: string[] = [];

  /** Swap the registry to `loaded` and make `next` current, in one synchronous step: nothing in it
   * awaits, so no request sees half of one Assembly and half of another (ADR-0069). The named
   * Charts are re-admitted against the new Machines in the same step (ADR-0070), so a Chart never
   * starts under a wrapper it was not admitted against. Answers the named Charts that cannot run. */
  const swap = (
    loaded: LoadedWorkflow[],
    files: readonly ChartFile[],
    next: CurrentAssembly,
  ): ChartCounts["unrunnable"] => {
    const names = new Set(loaded.map((w) => w.name));
    for (const { name, machine } of loaded) {
      host.register({
        name,
        machine,
        // Nothing to inject (ADR-0011): the module imports its own actors; live clients are built
        // per-invocation from input. `provide` stays a test seam on WorkflowDef, unused here.
        provide: () => ({}),
        // The Assembly the file came from (ADR-0069): every save of a run started from it names it.
        assembly: next.hash,
      });
    }
    // A Machine's name holds no slash (ADR-0070): the named Charts are the registry's to drop.
    for (const name of host.workflows()) if (!splitChartName(name) && !names.has(name)) host.unregister(name);
    const unrunnable = charts.bind({ workflows: loaded, files, assembly: next.hash });
    current = next;
    currentWorkflows = [...loaded.map((w) => w.name), ...files.map((f) => chartName(f.wrapper, f.name))];
    return unrunnable;
  };

  // 2. Filename discovery: every `workflows/<name>.ts` of the current Assembly exports its Machine
  // by name. No current Assembly → no Workflows, and the process still serves (ADR-0048).
  if (current) {
    const booted = current;
    swap(await importAssembly(booted.hash, booted.root), await readChartFiles(booted.root), booted);
  } else {
    charts.bind({ workflows: [], files: [] });
  }

  // What holds an Assembly (ADR-0069): the live ROWS, not this process's runs, so a run this boot
  // failed to restore still holds its own; and the runs this process hosts, for a run started a
  // moment ago that has no row yet. A terminal row holds nothing.
  const holdsByHash = async (): Promise<Map<string, string[]>> => {
    const holds = await store.liveAssemblies();
    for (const [hash, runs] of host.assemblyHolds()) {
      const known = holds.get(hash) ?? [];
      holds.set(hash, [...known, ...runs.filter((r) => !known.includes(r))]);
    }
    return holds;
  };

  // Whether the boot deferred its restore to the first publish (step 3 below says why). The host
  // keeps the flag, so `/agents/*` answers 503 for a waiting run, not 404 (ADR-0026).
  if (current === null) host.deferRestore();

  // The publish door (ADR-0069). Its walk imports the tree at `assemblies/<hash>`, where it stays:
  // the config, every Workflow, then the refusals this process can see. The swap reuses what the
  // walk imported, so nothing is imported after the pointer flips.
  const assemblies = assemblyDoor({
    dir: opts.dir,
    current: () => current,
    workflows: () => currentWorkflows,
    holds: async () => heldAssemblies(opts.dir, current, await holdsByHash()),
    roots: async () => new Set((await holdsByHash()).keys()),
    onCollect: (collected) => {
      for (const hash of collected) imported.delete(hash);
    },
    load: async (root) => {
      const config = await loadConfig(root);
      const workflows = await importWorkflows(root);
      // The Assembly's Chart files (ADR-0070): the door admits each against its wrapper, and one
      // that fails refuses the publish naming the file.
      const files = await readChartFiles(root);
      // The runtime Charts on the volume: a dispatch of a named Chart may resolve to one (ADR-0071).
      const runtimeCharts = (await readRuntimeCharts(opts.dir)).map((c) => ({ name: chartName(c.wrapper, c.name) }));
      const refusals = await assemblyRefusals({
        config,
        workflows,
        charts: files,
        runtimeCharts,
        ...(opts.imageMap ? { images: opts.imageMap } : {}),
        root,
      });
      // What THIS publish left unrunnable, for its own answer: a slot per `load`, so no other
      // publish can change it (ADR-0070).
      let unrunnable: ChartCounts["unrunnable"] = [];
      return {
        refusals,
        workflows: [...workflows.map((w) => w.name), ...files.map((f) => chartName(f.wrapper, f.name))],
        answer: () => (unrunnable.length ? { charts: { unrunnable } } : {}),
        activate: async (next) => {
          // Every named Chart is re-admitted against the new Assembly (ADR-0070): a runtime Chart
          // that fails is marked unrunnable, kept on the volume, and named in the publish's answer.
          unrunnable = swap(workflows, files, next);
          // The Machines the walk imported are this hash's, so a run restored inside it later
          // (the next boot is a new process; this is for the same one) needs no second import.
          imported.set(next.hash, Promise.resolve(workflows));
          opts.onPublish?.({ current: next, config, workflows });
          // The restore a boot with no current Assembly deferred (ADR-0069). After the swap and
          // `onPublish`, so the config that applies is bound: a re-attached run provisions under
          // it. Each run restores inside the Assembly its blob names, as at boot; one whose
          // Assembly was published for the old Kit version drifts now, and that is final. The
          // door's collection follows in the same publish, so it removes the Assemblies only those
          // drifted rows named.
          if (!host.restorePending) return;
          try {
            const outcome = await host.restore();
            opts.onRestore?.({ assembly: next.hash, ...outcome });
          } catch (err) {
            // Left pending: the next publish, or the next boot, tries again. The publish itself
            // landed, so it is not refused for this.
            console.error(`restore after publish failed: ${err instanceof Error ? err.message : err}`);
          }
        },
      };
    },
  });

  // The publish's answer names the named Charts the new Assembly left unrunnable (ADR-0070): each
  // `load` above adds them to its own answer, under the door's lock.
  const door: AssemblyDoor = assemblies;

  // 3. Resume in-flight runs persisted by a prior process (ADR-0007), each inside the Assembly its
  // snapshot names (ADR-0069). A run whose Assembly this Orchestrator cannot load (a volume that
  // lost it, another Kit version) is `drifted` with its hash named, and its snapshot is kept. The
  // outcome is reported, not swallowed (ADR-0030): a boot that declined to resume runs must say
  // so, or "drifted" is only discoverable by asking after a specific run id nobody knows to ask
  // about.
  //
  // Only when there is a current Assembly. With none (no pointer, a pointer this process cannot
  // load, a pointer at another Kit version), no config is bound, so a re-attached run that reaches
  // a provision would fault, which is terminal. And in the Kit bump window ("rolls the image first,
  // publishes second") every held Assembly is at the old Kit version: a restore now would drift
  // every live run before the publish, and an image rollback could not resume them. So the rows
  // wait, untouched, and the first publish restores them (`activate` above).
  const restored: RestoreOutcome = current
    ? await host.restore()
    : { reattached: [], lost: [], drifted: [], failed: [] };
  const waiting = current ? [] : (await store.live()).map((row) => row.runId);

  // Right after restore, not before: restore reads live rows only, and a row it marks `lost` or
  // `drifted` here is written now, so its week starts now (ADR-0065). After the rows, the
  // Assemblies: restore decided which rows stay live, and so which Assemblies stay held (ADR-0069).
  // A sweep deletes finished rows only, so it never takes a waiting run; and with the restore
  // deferred, every live row is a root, and so is the pointer's target, so the boot collection
  // removes only the Assemblies nothing names.
  // A sweep is housekeeping, never a reason to stay up — nor to fail a boot that has already
  // resumed runs: a failed sweep or collection, at boot or on the hour, is logged, and the next
  // hour tries again. The timer holds no process alive.
  const sweep = async (): Promise<string[]> => {
    await store
      .sweep(new Date(Date.now() - RETAIN_MS))
      .catch((err) => console.error(`sweep failed: ${err instanceof Error ? err.message : err}`));
    return door.collect();
  };
  const collected = await sweep();
  const onCollect =
    opts.onCollect ??
    ((hashes: string[]) => console.log(`collected Assemblies no live run holds: ${hashes.join(", ")}`));
  const sweeper = setInterval(() => {
    // `onCollect` is a callback the caller injects (the server's announce): a throw from it is
    // logged, never an unhandled rejection that ends the process.
    void sweep()
      .then((hashes) => {
        if (hashes.length) onCollect(hashes);
      })
      .catch((err) => console.error(`collection announce failed: ${err instanceof Error ? err.message : err}`));
  }, SWEEP_EVERY_MS);
  sweeper.unref();

  // 4. Serve, authenticated (ADR-0013) — the tokens and key resolved above.
  const auth = createAuthenticator({ instanceToken, signingKey, publishToken });
  // The Repos are read PER REQUEST, never snapshotted here: a cache the agent cloned minutes
  // after boot must show as present the next time anyone asks (ADR-0048/0051).
  const app = createApp(host, auth, {
    charts,
    dataPlane: opts.dataPlane,
    repos: opts.repos,
    fetchRepo: opts.fetchRepo,
    assembly: door,
    ...(opts.mounts ? { mounts: opts.mounts } : {}),
  });
  const server = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname });
  const port = await new Promise<number>((resolve) => {
    server.once("listening", () => resolve((server.address() as AddressInfo).port));
  });

  return {
    host,
    url: `http://${hostname}:${port}`,
    instanceToken,
    publishToken,
    get assembly() {
      return current;
    },
    ...(resolved.error !== undefined ? { assemblyError: resolved.error } : {}),
    workflows: host.workflows(),
    get charts() {
      return charts.counts();
    },
    heldMachines: async () => {
      const machines: AnyStateMachine[] = [];
      const now = current;
      const hashes = [...(now ? [now.hash] : []), ...(await holdsByHash()).keys()];
      for (const hash of new Set(hashes)) {
        try {
          const held = now && hash === now.hash ? { root: now.root } : await heldAssembly(opts.dir, hash);
          if ("error" in held) continue;
          machines.push(...(await importAssembly(hash, held.root)).map((w) => w.machine));
        } catch {
          // A fault on the volume or in the import: the restore reported it for the run.
        }
      }
      return machines;
    },
    restored,
    waiting,
    collected,
    admit: door.admit,
    close: async () => {
      // Before `server.close()`, not after: it waits for in-flight requests, and an observation
      // feed is in-flight until its watcher goes away. `host.close()` is what makes them go away.
      // From that call on, `/agents/*` answers 503 until the listener closes: the Turns are parked
      // for the next boot's restore, not over, so no Harness may read a 404 here (ADR-0026).
      clearInterval(sweeper);
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
 * `export const machine`. A published Assembly is a new directory, so its files are new URLs:
 * the ESM module cache never serves an older Assembly's module, and needs no bust (ADR-0069). */
async function importMachine(name: string, file: string): Promise<AnyStateMachine> {
  const mod: { machine?: unknown } = await import(pathToFileURL(file).href);
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
 * Where an Effector placement is, and its key (ADR-0068): the Instance Effector's Service and
 * `effectorKey(signingKey, "instance")`; a Sandbox Effector's Service by its Sandbox's name and
 * `effectorKey(signingKey, <name>)`, the key the provision wrote into its pod. Undefined where the
 * entrypoint named no address for that placement.
 */
export function effectorTarget(
  placement: EffectorPlacement,
  opts: Pick<InstanceOptions, "instanceEffector" | "sandboxEffector">,
  signingKey: Buffer,
): EffectorTarget | undefined {
  if (placement === "instance") {
    return opts.instanceEffector
      ? { placement, service: opts.instanceEffector, key: effectorKey(signingKey, placement) }
      : undefined;
  }
  return opts.sandboxEffector
    ? {
        placement: "sandbox",
        service: opts.sandboxEffector(placement.sandbox),
        key: effectorKey(signingKey, placement.sandbox),
      }
    : undefined;
}

/**
 * Discover + load every Workflow an instance folder registers — the same discovery and the same
 * module contract `startInstance` boots with, without booting.
 *
 * `jr2 up` is the caller (ADR-0049/0050): a Machine carries its Agents and its Sandbox Image, so
 * the only way to know what a deployment must preflight and converge is to load the Machines and
 * WALK them (`partsOf`, parts.ts). It lives here, beside the discovery it shares, so the
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
 * Discover + read every Chart file an Assembly root holds (ADR-0070):
 * `workflows/<wrapper>/<name>.chart.json`, one level below the flat `workflows/*.ts`. The sibling
 * of {@link loadWorkflows}, for `jr2 up`'s host-side walk, which admits each file against its
 * wrapper with `chartFileRefusals`, the check the door's `assemblyRefusals({ charts })` runs. Any other file in a
 * wrapper's directory is ignored and named to `warn`.
 */
export function loadCharts(root: string, warn?: (line: string) => void): Promise<ChartFile[]> {
  return readChartFiles(root, warn);
}

/**
 * The instance module-discovery convention: every `<moduleDir>/<name>.ts` except `_`-prefixed
 * helpers and `.d.ts`, sorted, name = filename stem. `workflows/` is the one directory that uses
 * it, and the ONLY thing an Instance still discovers by filename (ADR-0050: what only the CLI and
 * the HTTP API name is discovered; everything code names rides the Machine). The `agents/` folder
 * and the `images/<name>` dirname scan it was also written for both retired with ADR-0049. An
 * ABSENT dir is empty; any other readdir failure (EACCES, ENOTDIR, …) throws — a directory that
 * exists but cannot be read must be loud, never "no modules".
 *
 * A stem is a Workflow name, and a Workflow name has one rule wherever it is written: lowercase
 * letters, digits and "-", the rule a Chart name keeps too (`WORKFLOW_NAME`). So `jr2 run`, the
 * door's path and a `dispatch` slot name the same set of Workflows (ADR-0071), and a stem outside
 * the rule throws here, naming the rename, before anything registers it.
 */
export async function discoverModules(moduleDir: string): Promise<Array<{ name: string; file: string }>> {
  let entries: string[];
  try {
    entries = await readdir(moduleDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const modules = entries
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.startsWith("_"))
    .sort()
    .map((f) => ({ name: f.slice(0, -3), file: join(moduleDir, f) }));
  for (const { name } of modules) {
    if (!WORKFLOW_NAME.test(name)) {
      throw new Error(
        `${join(moduleDir, `${name}.ts`)}: a Workflow is named by its filename stem, in lowercase letters, digits ` +
          `and "-", so that \`jr2 run\` and a \`dispatch\` slot name it the same way — rename it to ` +
          `${kebabOf(name)}.ts (ADR-0071)`,
      );
    }
  }
  return modules;
}

/** A stem outside the rule, as the rule would spell it: `reviewLoop` and `review_loop` are
 * `review-loop`. */
function kebabOf(stem: string): string {
  const out = stem
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out === "" ? "workflow" : out;
}

/**
 * The Instance's `images/default` build context, or undefined when it scaffolded none — ADR-0037's
 * middle resolution leg, so that a local Machine never has to spell
 * `import.meta.resolve("../images/default")` for the toolchain its own instance ships.
 *
 * A PATH CONVENTION, not discovery (ADR-0049/0050). There is exactly one path, it is checked, and
 * nothing is enumerated: `images/<name>` dirnames stopped being names the moment a Machine started
 * carrying its own image, and a folder scan would re-introduce the very thing that made a packaged
 * Machine depend on someone else's directory layout. A second image is a `file:` context beside the
 * Machine that names it.
 *
 * A folder with no `Dockerfile` THROWS, naming the missing path: unlike a stray `README.md`,
 * `images/default/` has no other reason to exist, so silence there would be a Sandbox Image the
 * author believes in and no converge ever builds.
 *
 * The Orchestrator process never calls this — refs reach it resolved, through the `jr2-images`
 * ConfigMap (images.ts). It lives here because it is an Instance-layout fact, beside the one
 * discovery convention that survives.
 */
export async function defaultImageContext(dir: string): Promise<string | undefined> {
  const imageDir = join(dir, "images", "default");
  try {
    await stat(join(imageDir, "Dockerfile"));
    return imageDir;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    await stat(imageDir);
  } catch {
    return undefined;
  }
  throw new Error(
    `the Instance's \`images/default\` has no Dockerfile (${join(imageDir, "Dockerfile")}) — that directory IS ` +
      "a build context (ADR-0037), and it is the Sandbox Image every `workspace()` that names none falls back to.",
  );
}
