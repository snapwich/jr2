// The Instance check (ADR-0050): the typecheck and the Machine walk, which `jr2 up` and `jr2 check`
// both run through this one function, so the two commands cannot give different answers. It reads
// the Instance folder alone: no kube context, no cluster, no docker, no install. Each refusal is an
// `activity` line that starts with `refusing:`, and the function then returns `undefined`. A module
// that throws when it loads (a refusal of `createMachine`, `defineEvent` or `workspace()`) throws
// out of `loadWorkflows`, and the CLI's dispatch prints it as one `error:` line, for each command.
//
// The order is the order of `jr2 up`: the compiler first, because a wrong name is a type error since
// ADR-0049; then the walk, which holds the refusals that the compiler cannot make (an Open part, a
// Chart file, a dispatch, an Effect secret, a Size). The Assembly is not staged here: staging installs
// the Instance's production dependencies from its lockfile, and its refusals are about that install,
// so they stay with `jr2 up`.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  chartFileRefusals,
  CUSTOM_PROVIDER_APIS,
  dispatchRefusals,
  doorRefusals,
  loadCharts,
  loadWorkflows,
  machineBodies,
  openPartRefusals,
  partsOf,
  placementWalkOf,
  refuseEffectSecrets,
  resolveSize,
  seatLine,
  serializeMachine,
  splitSize,
  targetText,
  type JR2Config,
  type PlacementWalk,
  type ResolvedSize,
} from "@jr2/orchestrator/internal";
import { activity, type Io } from "./output.ts";
import { tscTypecheck } from "./typecheck.ts";

/** What the walk found, for the layers of `jr2 up` that come after it. */
export type CheckedInstance = {
  /** The registered Workflows, loaded as the Orchestrator loads them. */
  workflows: Awaited<ReturnType<typeof loadWorkflows>>;
  /** The parts that the registered Machines carry. */
  carried: ReturnType<typeof partsOf>;
  /** The placement walk: what names each secret, and where each Harness pod goes. */
  placementWalk: PlacementWalk;
  /** The Size of each `workspace()`, resolved and split as the provision does it. */
  sizes: Array<{ workflow: string; size: ResolvedSize }>;
  /** The Chart files under `workflows/`, as `<wrapper>/<name>`. */
  chartFiles: string[];
};

/**
 * Run the typecheck and the Machine walk of the Instance at `root`. Returns what the walk found, or
 * `undefined` after a `refusing:` line. A module that fails to load throws.
 */
export async function checkInstance(io: Io, root: string, config: JR2Config): Promise<CheckedInstance | undefined> {
  // --- typecheck (ADR-0050): the compiler agrees the folder is coherent, before anything is spent -
  // A REFUSAL, not a warning. `jr2 up` runs it before the namespace apply and before the builds:
  // the names a Machine carries (an Agent slot, a composed Machine, a Repo Slot, a `customize()` of
  // any of them) are typed since ADR-0049/0051, so the answer here is the same answer the author's
  // editor gives — and a converge that shipped a Machine the compiler rejects would surface it as
  // an invoke-time failure mid-run, minutes and three image builds later.
  activity(io, "typecheck: tsc --noEmit (the instance's own compiler)");
  const checked = await (io.typecheck ?? tscTypecheck)(root);
  if (!checked.ok) {
    activity(io, "refusing: this instance does not typecheck — nothing was built and nothing was applied");
    for (const line of checked.output.split("\n")) activity(io, `  ${line}`);
    return undefined;
  }
  // A custom provider's wire protocol, from the Harness's own list (`CUSTOM_PROVIDER_APIS`): the
  // Harness refuses any other at boot, and a check pod would only crash on it (ADR-0018).
  const api = config.harness?.provider?.api;
  if (api !== undefined && !CUSTOM_PROVIDER_APIS.includes(api)) {
    activity(
      io,
      `refusing: harness.provider.api is "${api}" — the Harness speaks: ${CUSTOM_PROVIDER_APIS.join(", ")} (ADR-0018)`,
    );
    return undefined;
  }

  // --- the Machine walk (ADR-0049, ADR-0051) -----------------------------------------------------
  // A Machine carries its parts, so the check LOADS the instance's registered Workflows — the
  // same discovery and module contract the Orchestrator boots with — and walks them. The walk
  // returns what `jr2 up` uses after the check: the Agent definitions whose models are preflighted
  // (ADR-0018), any `workspace: "none"`, for which `jr2 up` converges the Instance Harness
  // (ADR-0031), every `file:` docker context a `workspace()` names, which `jr2 up` builds
  // (ADR-0037), every bound Repo, whose ssh key `jr2 up` asks for and whose resource the
  // Orchestrator creates at boot (ADR-0051), and whether any Machine composes a Sandbox at all —
  // the data-plane switch. The walk comes right after the gate, and `jr2 up` runs the check before
  // ownership, because the walk holds REFUSALS the compiler cannot make: a part left Open on a
  // registered Machine — a Repo Slot with no url, an Agent with no model (ADR-0054) — and a zod
  // `input` on a Machine that `jr2Setup` did not make, which no door reads (ADR-0033). Nothing
  // about Agents is published, because the definition rides each Turn.
  const workflows = await loadWorkflows(root);
  const carried = partsOf(workflows.map((w) => w.machine));
  const { agents } = carried;
  // The Machine is named by where it sits under the registered root — the slot chain a
  // `customize()` walks — and the fix line nests the same way, so it pastes into
  // `workflows/<name>.ts` with the imported Machine and the url filled in.
  // Every Open part is refused in ONE listing, in walk order within each kind: a composer fixing a
  // packaged Machine fixes all of them in the same edit, and a converge that refused the Repo Slot,
  // then the Agent one run later, would cost them two rounds to learn one thing. The listing is the
  // door's own (ADR-0069): the Orchestrator refuses a publish with the same lines, so the host walk
  // and the door's walk cannot drift.
  // A zod `input` that no door reads (ADR-0033) is in the same listing, first: the door refuses it
  // with the same line.
  const open = [...doorRefusals(workflows), ...openPartRefusals(workflows)];
  if (open.length) {
    for (const line of open) activity(io, `refusing: ${line}`);
    return undefined;
  }
  // Each Chart file is admitted HERE by the door's own check (ADR-0070), so a Chart file the
  // Orchestrator would refuse is refused at the same command as `tsc`'s errors, before any
  // cluster work, with the lines the publish would answer.
  const charts = await loadCharts(root, workflows, (line) => activity(io, `warning: ${line}`));
  const chartRefusals = chartFileRefusals(charts, workflows);
  if (chartRefusals.length) {
    for (const line of chartRefusals) activity(io, `refusing: ${line}`);
    return undefined;
  }
  // What each same-Instance dispatch names resolves in this Assembly, and its slot schema matches
  // the callee's door (ADR-0071): the door's own check, so the publish would refuse the same lines.
  // The host cannot see the Orchestrator's volume, so a named Chart that is no Chart file here is a
  // warning, which the door decides.
  const dispatched = dispatchRefusals(workflows, charts);
  for (const line of dispatched.warnings) activity(io, `warning: ${line}`);
  if (dispatched.errors.length) {
    for (const line of dispatched.errors) activity(io, `refusing: ${line}`);
    return undefined;
  }
  // What each registered Machine runs outside itself (ADR-0067, ADR-0068): every Effect slot, with
  // the plain data it carries — a command's argv, its timeout, the Repo Slot it runs in; an http
  // Effect's method, its fixed target and the secrets it names — read, never run.
  for (const w of workflows) {
    const effects = partsOf([w.machine]).effects;
    if (!effects.length) continue;
    activity(io, `effects: workflow "${w.name}" — what it runs outside itself (ADR-0067)`);
    for (const e of effects) {
      const where = e.path?.length ? ` (on ${e.path.map((k) => `"${k}"`).join(" → ")})` : "";
      const slot = "slot" in e && e.slot !== undefined ? `, in Repo Slot "${e.slot}"` : "";
      if (e.kind === "http") {
        const names = e.secrets.length ? `, secrets ${e.secrets.map((n) => `"${n}"`).join(", ")}` : "";
        // Its body decides where it runs (ADR-0067): a Worktree file needs its Workspace's Sandbox Effector.
        const where2 = e.file
          ? `in the Sandbox Effector, a Worktree file as its body${slot}`
          : "in the Instance Effector";
        activity(
          io,
          `  ${e.name}${where}: http ${e.method} ${e.target ? targetText({ target: e.target }) : "<open>"} — ${e.timeoutMs / 1000}s, ` +
            `${where2}${names}${e.idempotent ? ", idempotent" : ""}`,
        );
        continue;
      }
      if (e.kind === "dispatch") {
        // Where it runs is read from the target (ADR-0071): none is this Orchestrator, in-process.
        const to = e.target ? targetText({ target: e.target }) : e.open ? "<open>" : "this Orchestrator";
        const names = e.secrets.length ? `, token ${e.secrets.map((n) => `"${n}"`).join(", ")}` : "";
        const where2 = e.placement === "instance" ? "in the Instance Effector" : "in the Orchestrator's own process";
        activity(
          io,
          `  ${e.name}${where}: dispatch ${e.workflow}${e.wait ? " wait" : ""} → ${to} — ${e.timeoutMs / 1000}s, ` +
            `${where2}${names}`,
        );
        continue;
      }
      if (e.kind === "push") {
        const opts = (["pin", "sign", "squash", "force"] as const).filter((k) => e[k]);
        activity(
          io,
          `  ${e.name}${where}: push${opts.length ? ` (${opts.join(", ")})` : ""} — ${e.timeoutMs / 1000}s, ` +
            `in the Sandbox Effector${slot}`,
        );
        continue;
      }
      if (!("argv" in e)) continue;
      const names = e.secrets?.length ? `, secrets ${e.secrets.map((n) => `"${n}"`).join(", ")}` : "";
      const seat = e.secrets?.length ? `the Sandbox Effector${e.pin ? ", pinned" : ""}` : "the Harness";
      activity(
        io,
        `  ${e.name}${where}: ${e.kind} ${JSON.stringify(e.argv)} — ${e.timeoutMs / 1000}s, in ${seat}${slot}${names}`,
      );
    }
  }
  // An Effect that names a secret the `secrets` list does not hold, and a literal Effect secret too
  // short to scrub (ADR-0068), are refused HERE, off the walk and the config alone — before anything is
  // built or applied (ADR-0050, ADR-0068). `jr2 up` places a secret read from the user's Secret
  // after the check, once it reaches the cluster.
  // What names each secret, read off the walk (ADR-0059, ADR-0068): every Effect, every Workspace's
  // pod — its `workspace()`'s `secrets` and the models of the Agents whose Turns run there — and the
  // models of the `"none"` Agents the Instance Harness hosts.
  // An Open body that allows "none" needs the Instance Harness, holding a key for each model it
  // allows (ADR-0070), as a "none" Agent does. The door's walk says both, so `jr2 up` and the
  // publish door place the same set.
  const placementWalk = placementWalkOf(workflows);
  refuseEffectSecrets(config, placementWalk);
  // Who may send what, per state (ADR-0015): the audience rule's answer for each registered
  // Machine and every Machine it composes, as its doc carries it — so an author reads who holds a
  // pick before a run finds out. Then what the build found legal and suspect: a warning, never a
  // refusal (the refusals threw when the Machine loaded).
  for (const w of workflows) {
    const bodies = machineBodies(serializeMachine(w.name, w.machine));
    const seats = bodies.flatMap((body) => body.seats.map(seatLine));
    if (seats.length) {
      activity(io, `seats: workflow "${w.name}" — who may send what, per state (ADR-0015)`);
      for (const line of seats) activity(io, `  ${line}`);
    }
    for (const body of bodies) {
      for (const warning of body.warnings) activity(io, `warning: workflow "${w.name}": ${warning}  (ADR-0015)`);
    }
  }
  // The Size (ADR-0060): every `workspace()` a registered Machine composes, resolved down its chain
  // (the Machine's, then `sandbox.resources`, then the kit's) and split inside the pod, exactly as
  // the provision will. A split that leaves the Harness below its floor is refused HERE, naming the
  // Machine and the number to change, rather than at the first provision of a run. The check
  // returns the resolved Sizes, and `jr2 up` uses them for its Sandbox-node warning.
  const sizes: Array<{ workflow: string; size: ResolvedSize }> = [];
  for (const w of workflows) {
    for (const { path, resources, user } of partsOf([w.machine]).sizes) {
      try {
        const size = resolveSize(resources, config.sandbox?.resources);
        splitSize(size, user);
        sizes.push({ workflow: w.name, size });
      } catch (e) {
        const where =
          path !== undefined && path.length
            ? ` (on the Machine composed as ${path.map((k) => `"${k}"`).join(" → ")})`
            : "";
        const fix =
          path === undefined
            ? ""
            : `; a composer retunes it where the Machine is registered: export const machine = ${sizeLine(path)}`;
        activity(io, `refusing: workflow "${w.name}"${where}: ${(e as Error).message}${fix}`);
        return undefined;
      }
    }
  }
  const agentNames = [...new Set(agents.map((a) => a.name))].join(", ") || "(none)";
  activity(io, `agents: ${agentNames} (carried by ${workflows.length} workflow machine(s))`);
  // Each Chart wrapper (ADR-0070): what its Open body lends a Chart, how many models a Chart's own
  // Agents may name (`jr2 up` places a key for each), and the Chart files the Assembly carries for
  // it. The walk reads the Open body's declaration, so the keys and the Instance Harness a Chart
  // could need are placed before any run.
  const chartFiles = await chartFilesIn(root);
  for (const w of workflows) {
    const bodies = partsOf([w.machine]).openBodies.filter((b) => b.path !== undefined && b.path.length === 0);
    if (!bodies.length) continue;
    const lends = [
      ...new Set(
        bodies.flatMap(({ declaration: { lends } }) => [
          ...(lends.agents ?? []),
          ...(lends.effects ?? []),
          ...(lends.machines ?? []),
          ...(lends.guards ?? []),
          ...(lends.actions ?? []),
          ...(lends.delays ?? []),
        ]),
      ),
    ];
    const models = new Set(bodies.flatMap((b) => b.declaration.allows.models));
    const files = chartFiles.filter((n) => n.startsWith(`${w.name}/`)).length;
    activity(
      io,
      `chart wrapper "${w.name}": lends ${lends.join(", ") || "nothing"}; allows ${models.size} model(s); ${files} Chart file(s)`,
    );
  }
  return { workflows, carried, placementWalk, sizes, chartFiles };
}

/**
 * The `customize` line that retunes a composed Machine's Size (ADR-0060), nested through `actors`
 * the way `customize()` accepts — the Size twin of `customizeLine`, so the refusal pastes.
 */
function sizeLine(path: readonly string[]): string {
  const binds = '{ resources: { limits: { memory: "<memory>" } } }';
  return `customize(<import>, ${path.reduceRight((parts, key) => `{ actors: { ${key}: ${parts} } }`, binds)})`;
}

/**
 * The Chart files under an Assembly root (ADR-0070), as Workflow names `<wrapper>/<name>`: each
 * `workflows/<wrapper>/<name>.chart.json`, one level below the flat `workflows/*.ts`, in a directory
 * named after its wrapper. The layout the Orchestrator's discovery reads (charts.ts); a directory
 * whose name starts with `_` or `.` is not a wrapper's.
 */
export async function chartFilesIn(root: string): Promise<string[]> {
  const out: string[] = [];
  const dir = join(root, "workflows");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const files = await readdir(join(dir, entry.name)).catch(() => [] as string[]);
    for (const f of files)
      if (f.endsWith(".chart.json")) out.push(`${entry.name}/${f.slice(0, -".chart.json".length)}`);
  }
  return out.sort();
}
