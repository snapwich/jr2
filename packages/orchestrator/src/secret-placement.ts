// Where each secret of the `secrets` list goes (ADR-0068): placement is READ, never declared.
//
//   - an entry with `hosts` — or a known model key, whose hosts default — is a Held secret: every
//     Custodian holds it (ADR-0059; `heldSecretsOf` owns its rules);
//   - an entry an Effect names with `secret("name")` is an Effect secret, a file in that Effect's
//     Effector — today the Instance Effector, the one placement built;
//   - both is both, and `jr2 up` says so; neither goes nowhere, and `jr2 up` warns.
//
// Pure and host-side, like `heldSecretsOf`: only `jr2 up` has the `.env` values. It refuses an
// Effect that names a secret the list does not hold, and an Effect secret shorter than 8 characters
// (B3.5): the Effector replaces every match of a secret in what it returns, and a short one would
// match ordinary text.

import { isHeld, sourceOf, type HeldBinding, type HeldLookups } from "./held-secrets.ts";
import type { JR2Config } from "./config.ts";
import type { CarriedEffect } from "./parts.ts";

/** The shortest Effect secret jr2 accepts (B3.5) — the Effector refuses a shorter file at start. */
export const EFFECT_SECRET_MIN_LENGTH = 8;

/** One Effect secret in one placement: a literal `jr2 up` writes, or a key of the user's Secret. */
export type EffectSecret = { name: string; source: HeldBinding["source"] };

/** One target an Effect placed in an Effector may call, with the secrets it names there. */
export type EffectorTargetConfig = { scheme: "http" | "https"; host: string; port: number; secrets: string[] };

/** What one Effector placement holds and allows — what `jr2 up` converges from. */
export type EffectorPlan = {
  placement: "instance";
  /** Every Effect secret placed there, in list order. */
  secrets: EffectSecret[];
  /** The literal values, by name — host-side only, for the placement's Secret. */
  values: Record<string, string>;
  /** `effector.json`'s targets: one per distinct (target, secrets) an Effect placed there names. */
  targets: EffectorTargetConfig[];
  /** The longest timeout among the Effects placed there, in milliseconds. */
  longestTimeoutMs: number;
  /** The Effects placed there, as `<workflow>/<slot>`. */
  effects: string[];
};

/** One registered Machine's Effect, as `jr2 up` walked it. */
export type PlacedEffect = { workflow: string; effect: CarriedEffect };

export type SecretPlacements = {
  /** The Instance Effector, when an Effect is placed there; absent otherwise. */
  instance?: EffectorPlan;
  /** One line per secret: where it goes. */
  report: string[];
  warnings: string[];
};

/**
 * Read where each secret goes, or throw the first refusal. `effects` is every Effect the registered
 * Machines carry; `lookups.secretKeys` is R10's read of the user's Secrets.
 */
export function secretPlacementsOf(
  config: JR2Config,
  effects: readonly PlacedEffect[],
  lookups: Pick<HeldLookups, "secretKeys"> = {},
): SecretPlacements {
  const entries = (config.secrets ?? []).map((entry, i) => ({ at: `secrets[${i}]`, ...entry }));
  const byName = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    if (byName.has(e.name)) {
      throw new Error(`${e.at}.name ${e.name} is listed twice — one name, one secret (ADR-0068)`);
    }
    byName.set(e.name, e);
  }

  // Which Effects name which secret, and where each Effect is placed.
  const namedBy = new Map<string, Array<{ effect: string; placement: "instance" }>>();
  const http = effects.filter(
    (p): p is { workflow: string; effect: Extract<CarriedEffect, { kind: "http" }> } => p.effect.kind === "http",
  );
  for (const { workflow, effect } of http) {
    const label = `${workflow}/${effect.name}`;
    for (const name of effect.secrets) {
      if (!byName.has(name)) {
        throw new Error(
          `workflow "${workflow}": the http Effect "${effect.name}" names secret("${name}"), which the \`secrets\` ` +
            `list does not hold — add it: secrets: [{ name: "${name}", value: process.env.${envish(name)} }] (ADR-0068)`,
        );
      }
      namedBy.set(name, [...(namedBy.get(name) ?? []), { effect: label, placement: "instance" }]);
    }
  }

  const report: string[] = [];
  const warnings: string[] = [];
  const secrets: EffectSecret[] = [];
  const values: Record<string, string> = {};
  for (const e of entries) {
    const held = isHeld(e);
    const named = namedBy.get(e.name) ?? [];
    if (named.length > 0) {
      const source = sourceOf(e, lookups);
      if (source.kind === "literal") {
        const value = e.value as string;
        if (value.length < EFFECT_SECRET_MIN_LENGTH) {
          throw new Error(
            `${e.at} (${e.name}) is an Effect secret shorter than ${EFFECT_SECRET_MIN_LENGTH} characters — the ` +
              "Effector replaces every match of a secret in what it returns, and a value this short would match " +
              "ordinary text. Use the whole credential; the value itself is not shown (ADR-0068)",
          );
        }
        values[e.name] = value;
      }
      secrets.push({ name: e.name, source });
    }
    const where = [
      ...(held ? ["Held (every Custodian)"] : []),
      ...(named.length
        ? [`an Effect secret in the Instance Effector (${[...new Set(named.map((n) => n.effect))].join(", ")})`]
        : []),
    ];
    if (where.length === 0) {
      warnings.push(
        `${e.at} (${e.name}) is named by nothing; goes nowhere — no hosts, and no Effect names it (ADR-0068)`,
      );
      continue;
    }
    report.push(`secret ${e.name}: ${where.join(" and ")}`);
  }

  if (http.length === 0) return { report, warnings };
  const targets: EffectorTargetConfig[] = [];
  for (const { effect } of http) {
    const t = { ...effect.target, secrets: [...effect.secrets].sort() };
    const same = (x: EffectorTargetConfig) =>
      x.scheme === t.scheme && x.host === t.host && x.port === t.port && x.secrets.join() === t.secrets.join();
    if (!targets.some(same)) targets.push(t);
  }
  return {
    instance: {
      placement: "instance",
      secrets,
      values,
      targets,
      longestTimeoutMs: Math.max(...http.map((p) => p.effect.timeoutMs)),
      effects: http.map((p) => `${p.workflow}/${p.effect.name}`),
    },
    report,
    warnings,
  };
}

/** A name as the env var a `.env` line would most likely hold it under — for the fix line only. */
function envish(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}
