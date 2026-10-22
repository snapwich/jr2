// The picks the kind tier's scripted model makes are picks the engine will run. pi validates every
// tool call against the Menu's JSON Schema before it runs it, and a pick whose input is
// `z.object({})` is `additionalProperties: false`: a call that carries `summary` is refused in the
// pod, the Machine never moves, and the scenario waits for something that never comes. The kind
// tier is opt-in, so this checks each scripted pick of `kind.feature` against the workflow it
// starts, in the default gate.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { vocabularyOf } from "@jr2/orchestrator/internal";
import type { AnyStateMachine } from "xstate";
import { z } from "zod";

const features = fileURLToPath(new URL("..", import.meta.url));

/** Every pick a Machine and the Machines it composes register, by name. */
function picksOf(machine: AnyStateMachine, seen = new Set<AnyStateMachine>()): Map<string, { input: z.ZodType }> {
  const picks = new Map<string, { input: z.ZodType }>();
  if (seen.has(machine)) return picks;
  seen.add(machine);
  for (const [name, def] of vocabularyOf(machine) ?? []) picks.set(name, def as { input: z.ZodType });
  for (const logic of Object.values(machine.implementations.actors as Record<string, unknown>)) {
    const child = (logic as AnyStateMachine | undefined)?.root ? (logic as AnyStateMachine) : undefined;
    if (child) for (const [name, def] of picksOf(child, seen)) picks.set(name, def);
  }
  return picks;
}

/** The JSON Schema rule pi applies: no property the schema does not list when it allows none other,
 * and every required one present. */
function refusal(schema: Record<string, unknown>, args: Record<string, unknown>): string | undefined {
  const properties = Object.keys((schema.properties as Record<string, unknown> | undefined) ?? {});
  if (schema.additionalProperties === false) {
    const extra = Object.keys(args).filter((k) => !properties.includes(k));
    if (extra.length) return `must not have additional properties (${extra.join(", ")})`;
  }
  const missing = ((schema.required as string[] | undefined) ?? []).filter((k) => !(k in args));
  if (missing.length) return `must have required properties (${missing.join(", ")})`;
  return undefined;
}

test("each pick the kind tier's scripted model makes is one its workflow's Menu accepts", async () => {
  const text = await readFile(join(features, "kind.feature"), "utf8");
  const scenarios = text.split(/^\s*Scenario:/m).slice(1);
  let checked = 0;
  for (const scenario of scenarios) {
    const title = scenario.split("\n")[0]!.trim();
    const workflows = [...scenario.matchAll(/start the "([^"]+)" workflow/g)].map((m) => m[1]!);
    const calls = [
      ...[...scenario.matchAll(/(?:model answers|calls) "([^"]+)" with summary "([^"]*)"/g)].map((m) => ({
        tool: m[1]!,
        args: { summary: m[2]! } as Record<string, unknown>,
      })),
      ...[...scenario.matchAll(/model answers "([^"]+)" with no arguments/g)].map((m) => ({
        tool: m[1]!,
        args: {} as Record<string, unknown>,
      })),
    ];
    if (calls.length === 0) continue;
    assert.ok(workflows.length > 0, `scenario "${title}" makes a pick and starts no workflow`);
    const picks = new Map<string, { input: z.ZodType }>();
    for (const name of workflows) {
      const mod = (await import(join(features, "kind-instance", "workflows", `${name}.ts`))) as {
        machine: AnyStateMachine;
      };
      for (const [pick, def] of picksOf(mod.machine)) picks.set(pick, def);
    }
    for (const { tool, args } of calls) {
      const def = picks.get(tool);
      assert.ok(def, `scenario "${title}": "${tool}" is no pick of ${workflows.join(", ")}`);
      const why = refusal(z.toJSONSchema(def.input) as Record<string, unknown>, args);
      assert.equal(why, undefined, `scenario "${title}": "${tool}" ${JSON.stringify(args)} ${why}`);
      checked++;
    }
  }
  assert.ok(checked > 0, "the feature makes scripted picks");
});
