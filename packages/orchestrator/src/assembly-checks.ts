// The walk's refusals, as a LISTING (ADR-0069). The walk runs twice: `jr2 up` runs it on the host
// before any cluster work, and the door runs it again over the unpacked Assembly before the
// publish lands. Both ends call these functions, so the two walks cannot drift. They return the
// lines and print nothing: `jr2 up` prints them after `refusing: `, and the door returns them in
// its `422` report.

import { isAbsolute, relative, sep } from "node:path";
import type { AnyStateMachine } from "xstate";
import type { JR2Config } from "./config.ts";
import { imageContextDigest, type ImageRefs } from "./images.ts";
import { openPartsText } from "./open-effect.ts";
import { customizeLine, partsOf, placedEffectsOf, workspacePodsOf } from "./parts.ts";
import { refuseEffectSecrets, type PlacementWalk } from "./secret-placement.ts";
import { chartFileRefusals, type ChartFile } from "./charts.ts";

/** One registered Workflow, as `loadWorkflows` gives it. */
export type LoadedWorkflow = { name: string; machine: AnyStateMachine };

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
 * caller's: they throw at import, before this runs. Here: every Open part, a secret the config does
 * not declare (or a literal one too short to scrub), a `file:` image context whose digest the
 * mounted image map does not hold, and a Chart file that does not admit under its wrapper
 * (ADR-0070), each line naming the file. The door runs this after `jr2 up` did its cluster work, so each
 * check is true when the Assembly lands.
 */
export async function assemblyRefusals(input: AssemblyRefusalInput): Promise<string[]> {
  const lines = openPartRefusals(input.workflows);
  // A Chart file is the Instance's own (ADR-0070): one that fails refuses the publish.
  if (input.charts?.length) lines.push(...chartFileRefusals(input.charts, input.workflows));
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
