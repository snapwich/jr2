// The walk's refusals, as a LISTING (ADR-0069). The walk runs twice: `jr2 up` runs it on the host
// before any cluster work, and the door runs it again over the unpacked Assembly before the
// publish lands. Both ends call these functions, so the two walks cannot drift. They return the
// lines and print nothing: `jr2 up` prints them after `refusing: `, and the door returns them in
// its `422` report.

import { isAbsolute, relative, sep } from "node:path";
import type { AnyStateMachine } from "xstate";
import { z } from "zod";
import type { JR2Config } from "./config.ts";
import { imageContextDigest, type ImageRefs } from "./images.ts";
import { openPartsText } from "./open-effect.ts";
import { customizeLine, partsOf, placedEffectsOf, workspacePodsOf } from "./parts.ts";
import { refuseEffectSecrets, type PlacementWalk } from "./secret-placement.ts";
import {
  chartFileRefusals,
  chartName,
  chartWrapperOf,
  splitChartName,
  wrapperFault,
  type ChartFile,
} from "./charts.ts";
import { doorCompat } from "./door-compat.ts";

// The comparison is the same one `jr2 up`'s foreign preflight makes, so it is exported beside the
// walk the CLI already imports (ADR-0071).
export { doorCompat, type DoorCompat } from "./door-compat.ts";
import { inputSchemaOf, isZodSchema } from "./vocabulary.ts";

/** One registered Workflow, as `loadWorkflows` gives it. */
export type LoadedWorkflow = { name: string; machine: AnyStateMachine };

/**
 * Every registered Machine that has a zod `input` on its `createMachine` config and that `jr2Setup`
 * did not make (ADR-0033). The `setup()` of xstate keeps that `input` in the config but does not read it,
 * so the Machine has no door: a start with any input passes, and the Console start form is only a
 * field for JSON. TypeScript accepts the config, so only this walk finds it. One line per Workflow,
 * naming the fix.
 * A Machine with no `input`, or with an `input` that is not zod, can still use `setup()`.
 *
 * The line text follows `refusing: ` in `jr2 up`'s output; the prefix is the caller's.
 */
export function doorRefusals(workflows: readonly LoadedWorkflow[]): string[] {
  const lines: string[] = [];
  for (const w of workflows) {
    const declared = (w.machine.config as { input?: unknown }).input;
    if (!isZodSchema(declared) || inputSchemaOf(w.machine)) continue;
    lines.push(
      `workflow "${w.name}": machine "${w.machine.id}" has a zod \`input\` on createMachine, but jr2Setup did not ` +
        "make this Machine, so no door reads that input: a run starts with any input, and the Console start form " +
        "is only a field for JSON — make the Machine with jr2Setup in place of setup() or createMachine() (leave " +
        "out `events` if it takes no workflow event) (ADR-0033)",
    );
  }
  return lines;
}

/**
 * Every part a registered Machine leaves Open (ADR-0051, ADR-0054): a Repo Slot with no url, an
 * Agent with no model, an Effect's url, argv or secret. One line per part, in walk order within
 * each kind, so a composer fixes all of them in one edit. Each line names the Workflow and the
 * `customize()` line that binds the part. A part on a Machine invoked inline has no fix line,
 * because no `customize()` reaches an actor without a slot key.
 *
 * The line text follows `refusing: ` in `jr2 up`'s output; the prefix is the caller's.
 */
export function openPartRefusals(workflows: readonly LoadedWorkflow[]): string[] {
  const lines: string[] = [];
  for (const w of workflows) {
    const walked = partsOf([w.machine]);
    const opened: Array<{
      slot: string | undefined;
      path: readonly string[] | undefined;
      part: Parameters<typeof customizeLine>[3];
      what: string;
      adr: string;
    }> = [
      ...walked.openSlots.map((o) => ({
        ...o,
        part: "repo" as const,
        // An Open MAP names no slot (the composer does), so it is refused as "the Repo Slots".
        what: o.slot === undefined ? "its Repo Slots" : `Repo Slot "${o.slot}"`,
        adr: "ADR-0051",
      })),
      ...walked.openAgents.map((o) => ({ ...o, part: "agent" as const, what: `Agent "${o.slot}"`, adr: "ADR-0054" })),
      // An Effect's Open url, argv or secret (ADR-0054): one binding object for an Effect with two.
      ...walked.openEffects.map(({ parts, ...o }) => ({
        ...o,
        part: parts,
        what: `the ${openPartsText(parts)} of Effect "${o.slot}"`,
        adr: "ADR-0054",
      })),
    ];
    for (const { slot, path, part, what, adr } of opened) {
      if (path === undefined) {
        lines.push(
          `workflow "${w.name}" leaves ${what} open on a Machine invoked inline — no ` +
            "customize() reaches an actor without a slot key; declare that Machine under setup({ actors }) and " +
            `bind it there  (ADR-0049, ${adr})`,
        );
        continue;
      }
      const where = path.length ? ` (on the Machine composed as ${path.map((k) => `"${k}"`).join(" → ")})` : "";
      lines.push(
        `workflow "${w.name}" leaves ${what} open${where} — bind it where the Machine is ` +
          `registered: export const machine = ${customizeLine("<import>", path, slot, part)}  (${adr})`,
      );
    }
  }
  return lines;
}

/**
 * What the registered Machines name for secret placement (ADR-0059, ADR-0068): every Effect and
 * every Workspace's pod, per route, and the models the Instance Harness hosts: those of the `"none"`
 * Agents and of every Open body that allows `"none"` (ADR-0070). `jr2 up` and the door build the same walk from the same Workflows.
 */
export function placementWalkOf(workflows: readonly LoadedWorkflow[]): PlacementWalk {
  // The walk's own `instanceHarness` (ADR-0068, ADR-0070): the models of the "none" Agents and of
  // every Open body that allows "none", so a Chart's minted "none" Agent has its key placed, or the
  // publish is refused, never a 401 mid-run.
  const { instanceHarness } = partsOf(workflows.map((w) => w.machine));
  return {
    // Per route, not per Machine object: a Machine placed twice is checked where each copy runs.
    effects: workflows.flatMap((w) => placedEffectsOf(w.machine).map((effect) => ({ workflow: w.name, effect }))),
    workspaces: workflows.flatMap((w) => workspacePodsOf(w.machine).map((pod) => ({ workflow: w.name, pod }))),
    ...(instanceHarness ? { instanceHarness: { models: [...instanceHarness.models] } } : {}),
  };
}

/**
 * What a `dispatch` names, checked against what the walk can see (ADR-0071). Each dispatch with no
 * target — a same-Instance one; a foreign target is `jr2 up`'s preflight, a warning — must name a
 * Workflow the Assembly has: a Machine (`workflows/<name>.ts`), or `<wrapper>/<name>`, a named Chart
 * under a Chart wrapper the Assembly registers, from a Chart file or (when `runtime` is given) a
 * runtime Chart. A miss is an error. Without `runtime` — on the host, which cannot see the
 * Orchestrator's volume — a slashed name under a known wrapper with no Chart file is a warning.
 * Then the slot's input schema, when it has one, is compared with the callee's door
 * (`doorCompat`): a fault is an error, naming the field; a schema outside the compared subset is a
 * warning, "not compared".
 *
 * A dispatch resolves at RUN time against the current Assembly (ADR-0069); this check is of the
 * Assembly being published, so a later publish that drops the callee answers `refused` with the
 * door's 404 then, and is not refused for it here.
 */
export function dispatchRefusals(
  workflows: readonly LoadedWorkflow[],
  charts: readonly ChartFile[],
  runtime?: readonly { name: string }[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const w of workflows) {
    for (const effect of partsOf([w.machine]).effects) {
      // A target, bound or Open, is another Orchestrator's: its door is not in this Assembly.
      if (effect.kind !== "dispatch" || effect.target !== undefined || effect.open !== undefined) continue;
      const name = effect.workflow;
      const at = `workflow "${w.name}" dispatches "${name}"`;
      const once = JSON.stringify([w.name, effect.name, name]);
      if (seen.has(once)) continue;
      seen.add(once);
      const callee = calleeOf(workflows, charts, runtime, name);
      if ("error" in callee) {
        errors.push(`${at} ${callee.error} (ADR-0071)`);
        continue;
      }
      // A slashed name with no Chart the host can see still has a known door: the wrapper's minus
      // its Chart fields, the same for every Chart under it. So it is warned AND compared.
      if (callee.warning) warnings.push(`${at}: ${callee.warning} (ADR-0071)`);
      if (effect.input === undefined) continue;
      if ("notDrawn" in callee.door) {
        warnings.push(`${at}: its input schema and the door are not compared — ${callee.door.notDrawn} (ADR-0071)`);
        continue;
      }
      const compared = doorCompat(effect.input, callee.door.schema);
      if (compared.ok === "not-compared") {
        warnings.push(`${at}: its input schema and the door are not compared — ${compared.why} (ADR-0071)`);
      } else if (compared.ok === false) {
        for (const fault of compared.faults) {
          errors.push(
            `${at} with input its door does not take: ${fault} — align the slot's \`input\` with the door ` +
              "(derive it from the door's schema, `door.pick({ ... })`) (ADR-0071)",
          );
        }
      }
    }
  }
  return { errors, warnings };
}

/** The door a dispatch's name resolves to in these Workflows, or why it does not. */
function calleeOf(
  workflows: readonly LoadedWorkflow[],
  charts: readonly ChartFile[],
  runtime: readonly { name: string }[] | undefined,
  name: string,
): { door: Door; warning?: string } | { error: string } {
  const split = splitChartName(name);
  if (!split) {
    const found = workflows.find((w) => w.name === name);
    if (!found) {
      return {
        error:
          `which no Workflow in the Assembly has — add workflows/${name}.ts, or name one it registers` +
          (workflows.length ? `: ${workflows.map((w) => `"${w.name}"`).join(", ")}` : ""),
      };
    }
    return { door: doorOf(found.machine, []) };
  }
  const { wrapper, name: short } = split;
  const fault = wrapperFault(workflows, wrapper);
  if (fault) {
    return {
      error:
        fault.status === 404
          ? `which no Workflow in the Assembly has — no workflows/${wrapper}.ts registers the Chart wrapper "${wrapper}"`
          : `which no Workflow in the Assembly can be: ${fault.error}`,
    };
  }
  const machine = workflows.find((w) => w.name === wrapper)!.machine;
  const door = doorOf(machine, chartWrapperOf(machine)?.chartFields ?? []);
  const file = `workflows/${wrapper}/${short}.chart.json`;
  if (charts.some((c) => chartName(c.wrapper, c.name) === name)) return { door };
  if (runtime === undefined) {
    return {
      door,
      warning:
        `the Assembly has no Chart file ${file}, and a runtime Chart lives on the Orchestrator's volume alone, ` +
        "which jr2 up cannot see — the publish door checks it, and a run of the dispatch is refused with the door's " +
        "404 if it is not there",
    };
  }
  if (runtime.some((c) => c.name === name)) return { door };
  return {
    error:
      `which no Workflow in the Assembly has — add the Chart file ${file}; or, for a runtime Chart, PUT ` +
      `/workflows/${wrapper}/charts/${short} before this publish (a PUT needs "${wrapper}" in the current ` +
      `Assembly: when this publish adds it, publish "${wrapper}" first, then PUT the Chart, then publish the dispatch)`,
  };
}

/** A door as the comparison reads it: its JSON Schema (null: it declares no input), or why zod
 * could not draw one. */
type Door = { schema: Record<string, unknown> | null } | { notDrawn: string };

/** A Workflow's door as JSON Schema, exactly as `GET /workflows/<name>` serves it (run-host.ts
 * `inputSchema`): null for a Machine that declares none; for a named Chart the wrapper's minus its
 * Chart fields, which the Chart supplies (ADR-0070). A door zod cannot draw (`z.date()`,
 * `z.custom()`) is not drawn as "any", which would guess "compatible": it is not compared. */
function doorOf(machine: AnyStateMachine, chartFields: readonly string[]): Door {
  let schema = inputSchemaOf(machine);
  if (!schema) return { schema: null };
  if (chartFields.length) schema = schema.omit(Object.fromEntries(chartFields.map((f) => [f, true])) as never);
  try {
    return { schema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown> };
  } catch (err) {
    return {
      notDrawn: `the door has a part JSON Schema cannot state (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

export type AssemblyRefusalInput = {
  /** The Assembly's `jr2.config.ts`, loaded; `undefined` when it ships none. */
  config: JR2Config | undefined;
  /** Every Workflow the Assembly registers, loaded. */
  workflows: readonly LoadedWorkflow[];
  /**
   * The Assembly's Chart files (ADR-0070), read: `workflows/<wrapper>/<name>.chart.json`. Each is
   * admitted against its wrapper's Open body by the same door a run's Chart passes. Absent, none.
   */
  charts?: readonly ChartFile[];
  /**
   * The runtime Charts on the Orchestrator's volume (ADR-0070), by Workflow name
   * (`<wrapper>/<name>`): what a dispatch of a named Chart may resolve to beside the Chart files
   * (ADR-0071). The door can see them; absent, none.
   */
  runtimeCharts?: readonly { name: string }[];
  /**
   * The image map the Orchestrator reads per provision (ADR-0038), or a reader of it. Present
   * only when deployed: a host-booted process has no map, and no Sandbox to provision. When
   * present, every `file:` context a Machine names must have its digest in the map.
   */
  images?: () => Promise<ImageRefs>;
  /**
   * The directory the Assembly was imported from. A refusal names a `file:` context relative to
   * it (`images/box`), as the composer's own folder holds it: at the door that directory is a
   * staging path, which is gone when the refusal arrives.
   */
  root?: string;
};

/**
 * The door's walk (ADR-0069): the refusals the Orchestrator can see in an Assembly it has already
 * imported. An import error, a missing `export const machine` and a Vocabulary error are the
 * caller's: they throw at import, before this runs. Here: a zod `input` that no door reads, every Open part, a secret the config does
 * not declare (or a literal one too short to scrub), a `file:` image context whose digest the
 * mounted image map does not hold, and a Chart file that does not admit under its wrapper
 * (ADR-0070), each line naming the file. The door runs this after `jr2 up` did its cluster work, so each
 * check is true when the Assembly lands.
 */
export async function assemblyRefusals(input: AssemblyRefusalInput): Promise<string[]> {
  const lines = [...doorRefusals(input.workflows), ...openPartRefusals(input.workflows)];
  // A Chart file is the Instance's own (ADR-0070): one that fails refuses the publish.
  if (input.charts?.length) lines.push(...chartFileRefusals(input.charts, input.workflows));
  // A same-Instance dispatch names a Workflow this Assembly has (ADR-0071). The door sees the
  // runtime Charts, so a miss is an error here. Its warnings (a schema "not compared") have no
  // channel in the publish's answer, and are dropped: `jr2 up` printed them before the publish.
  lines.push(...dispatchRefusals(input.workflows, input.charts ?? [], input.runtimeCharts ?? []).errors);
  try {
    refuseEffectSecrets(input.config ?? {}, placementWalkOf(input.workflows));
  } catch (err) {
    lines.push(err instanceof Error ? err.message : String(err));
  }
  const images = partsOf(input.workflows.map((w) => w.machine)).images;
  const where = (dir: string): string => {
    const rel = input.root === undefined ? undefined : relative(input.root, dir);
    return rel !== undefined && rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
      ? rel.split(sep).join("/")
      : dir;
  };
  if (input.images && images.length) {
    let refs: ImageRefs | undefined;
    try {
      refs = await input.images();
    } catch (err) {
      lines.push(err instanceof Error ? err.message : String(err));
    }
    if (refs) {
      for (const image of images) {
        const digest = await imageContextDigest(image.dir);
        if (refs.sandbox[digest] === undefined) {
          const named = input.workflows
            .filter((w) => partsOf([w.machine]).images.some((i) => i.dir === image.dir))
            .map((w) => `"${w.name}"`);
          const by = named.length ? ` that workflow ${named.join(", ")} names` : "";
          lines.push(
            `the Sandbox Image context ${where(image.dir)}${by} (digest ${digest}) is not in the image map — ` +
              "`jr2 up` builds every `file:` context and writes the map before it publishes (ADR-0038, ADR-0069)",
          );
        }
      }
    }
  }
  return lines;
}
