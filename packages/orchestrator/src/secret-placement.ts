// Where each secret of the `secrets` list goes (ADR-0068, ADR-0059): placement is READ, never
// declared, and naming is placement on both sides. A pod gets the secrets something in it names:
//
//   - a Workspace's pod: the Held secrets its `workspace()` lists under `secrets: [...]`, and the
//     model keys of the Agents whose Turns run there — a model key is claimed by the PROVIDER;
//   - the Instance Harness: the model keys of the `"none"` Agents it hosts, and nothing else (they
//     cannot execute code, ADR-0031, so nothing else is theirs to use);
//   - an Effector: what its Effects name with `secret("name")` — the Instance Effector what its
//     `http` Effects name; a Workspace's Sandbox Effector what its file-body `http`s and
//     credentialed `command`s name. The push credential its `push`es spend is not placed here: the provision
//     names the entry the slot's url matches on the Sandbox, by reference (git-push.ts, B10).
//
// `hosts`, `headers` and `paths` are an entry's BINDING — where a Custodian may put the value — and
// never its placement. Both is both, and `jr2 up` reports it per pod; an entry nothing names goes
// nowhere, and `jr2 up` warns.
//
// Pure and host-side, like `heldSecretsOf`: only `jr2 up` has the `.env` values. It refuses a name
// the list does not hold, and an Effect secret shorter than 8 characters (ADR-0068): the Effector
// replaces every match of a secret in what it returns, and a short one would match ordinary text.

import {
  providerClaims,
  sourceOf,
  workspaceHeldPod,
  PROVIDER_KEY_NAME,
  type HeldBinding,
  type HeldLookups,
} from "./held-secrets.ts";
import type { JR2Config } from "./config.ts";
import { declaredPushKinds, pushRefusal } from "./git-push.ts";
import { INSTANCE_HARNESS_HELD_POD } from "./names.ts";
import type { CarriedEffect, WorkspacePod } from "./parts.ts";

/** The shortest Effect secret jr2 accepts (ADR-0068) — the Effector refuses a shorter file at start. */
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

/** One registered Machine's Workspace, as `jr2 up` walked it. */
export type PlacedWorkspace = { workflow: string; pod: WorkspacePod };

/** What the registered Machines name, as the walk read it. */
export type PlacementWalk = {
  effects: readonly PlacedEffect[];
  workspaces: readonly PlacedWorkspace[];
  /** The models of the `"none"` Agents — present when the Instance Harness is converged. */
  instanceHarness?: { models: readonly string[] };
};

/** One Harness pod's Held secrets: what its Custodian holds. */
export type HeldPodPlan = {
  /** The pod key its held objects are keyed by (`INSTANCE_HARNESS_HELD_POD`, `workspaceHeldPod`). */
  pod: string;
  /** For a human: `the Instance Harness`, `Workspace of workflow "task" → "review"`. */
  label: string;
  /** The names it holds, in list order; the custom provider's key last. */
  names: string[];
  /** Of `names`, those a provider claims (the rest the `workspace()` lists). */
  byProvider: string[];
};

/** One push of a Workspace (ADR-0067, B10): its Repo Slot, whether it signs, and — for a slot the
 * Machine binds to a url — that url and the `git.credentials` entry it matches. A slot the run or a
 * `customize()` binds has no url here: the provision matches it. */
export type SandboxPush = { slot: string; sign: boolean; squash?: true; url?: string; match?: string };

/** A Workspace's Sandbox Effector (ADR-0068, B5.1): what `jr2 up` writes for it. */
export type SandboxEffectorPlan = {
  placement: "sandbox";
  /** The pod key its objects are keyed by (`workspaceHeldPod`). */
  pod: string;
  label: string;
  /** The `workspace()`'s `effector: { image }`, as written; absent → the Sandbox Image. */
  image?: string;
  /** The `workspace()`'s Sandbox Image, as written; absent → `images/default`, then the stock
   * Harness. What the Effector runs in when it names no image of its own. */
  sandboxImage?: string;
  /** Every Effect secret its Effects name, in list order. */
  secrets: EffectSecret[];
  /** The literal values, by name — host-side only. */
  values: Record<string, string>;
  /** The targets its file-body `http`s name, with their secrets. */
  targets: EffectorTargetConfig[];
  /** Its pushes, by Repo Slot: what the provision resolves to an entry's push Secret. */
  pushes: SandboxPush[];
  /** Whether it holds a credentialed `command`: a node whose kernel cannot confine the child
   * (Landlock) stops the Effector's start, and the provision fails (ADR-0068, B9). */
  commands: boolean;
  /** Its Effects, as `<workflow>/<slot>`. */
  effects: string[];
};

export type SecretPlacements = {
  /** Every Harness pod the walk found — each Workspace, then the Instance Harness — with what its
   * Custodian holds. A pod that holds nothing is here too: its Custodian still runs. */
  held: HeldPodPlan[];
  /** Every name some pod holds — what `heldSecretsOf` normalizes. */
  claimed: Set<string>;
  /** The Instance Effector, when an Effect is placed there; absent otherwise. */
  instance?: EffectorPlan;
  /** Each Workspace whose body places an Effect in its Sandbox Effector. */
  sandbox: SandboxEffectorPlan[];
  /** One line per secret, then one per pod: where each goes, what each holds. */
  report: string[];
  warnings: string[];
};

/**
 * The refusals that need only the config and the walk, never the cluster: a name listed twice, a
 * name an Effect or a `workspace()` names that the list does not hold, a literal Effect secret
 * shorter than 8 characters. `jr2 up` runs it right after the walk, before anything is built or
 * applied.
 */
export function refuseEffectSecrets(config: JR2Config, walk: PlacementWalk): void {
  const { entries, namedBy } = namesOf(config, walk);
  heldPodsOf(config, walk, new Set(entries.map((e) => e.name)));
  for (const e of entries) {
    // An empty value is refused later with the list's own rule (`sourceOf`): it is an unset variable.
    if (namedBy.has(e.name) && e.value) shortRefusal(e, e.value.length);
  }
  for (const ws of walk.workspaces) pushesOf(config, ws);
}

/**
 * Read where each secret goes, or throw the first refusal. `walk` is what the registered Machines
 * name; `lookups.secretKeys` is R10's read of the user's Secrets, and `lookups.valueLength` the
 * length of a `valueFrom` Effect secret's value there, which is refused when short as a literal is.
 */
export function secretPlacementsOf(
  config: JR2Config,
  walk: PlacementWalk,
  lookups: Pick<HeldLookups, "secretKeys" | "valueLength"> = {},
): SecretPlacements {
  const { entries, namedBy, http } = namesOf(config, walk);
  const { pods, redundant } = heldPodsOf(config, walk, new Set(entries.map((e) => e.name)));
  const claimed = new Set(pods.flatMap((p) => p.names));

  const report: string[] = [];
  const warnings: string[] = [];
  const secrets: EffectSecret[] = [];
  const values: Record<string, string> = {};
  for (const e of entries) {
    const named = namedBy.get(e.name) ?? [];
    if (named.length > 0) {
      const source = sourceOf(e, lookups);
      if (source.kind === "literal") {
        const value = e.value as string;
        shortRefusal(e, value.length);
        values[e.name] = value;
      } else {
        // The user's Secret holds the value; `jr2 up` measures it there, and this check reads its length.
        const length = lookups.valueLength?.(source.secret, source.key);
        if (length !== undefined) shortRefusal(e, length);
      }
      secrets.push({ name: e.name, source });
    }
    const heldIn = pods.filter((p) => p.names.includes(e.name)).map((p) => p.label);
    const effectIn = [...new Set(named.map((n) => n.where))].map(
      (where) =>
        `an Effect secret in ${where} (${[...new Set(named.filter((n) => n.where === where).map((n) => n.label))].join(
          ", ",
        )})`,
    );
    const where = [...(heldIn.length ? [`Held in ${heldIn.join(", ")}`] : []), ...effectIn];
    if (where.length === 0) {
      warnings.push(
        `${e.at} (${e.name}) is named by nothing; goes nowhere — no workspace() lists it, no Agent's provider ` +
          "reads it, and no Effect names it (ADR-0059, ADR-0068)",
      );
      continue;
    }
    report.push(`secret ${e.name}: ${where.join(" and ")}`);
  }
  const custom = config.harness?.provider;
  if (custom?.apiKey && !claimed.has(PROVIDER_KEY_NAME)) {
    warnings.push(
      `harness.provider.apiKey is named by nothing; goes nowhere — no Agent names a "${custom.id}/…" model (ADR-0059)`,
    );
  }
  for (const p of pods) {
    const holds = p.names.map((n) => (p.byProvider.includes(n) ? `${n} (provider)` : n));
    report.push(`${p.label}: Custodian holds ${holds.length ? holds.join(", ") : "nothing"}`);
  }
  for (const { label, name } of redundant) {
    report.push(`${label}: secrets lists ${name}, which its Agents' provider claims already — redundant`);
  }

  const instanceSecrets = new Set(http.flatMap((p) => p.effect.secrets));
  const instance =
    http.length === 0
      ? undefined
      : effectorPlan(
          http,
          secrets.filter((s) => instanceSecrets.has(s.name)),
          values,
        );
  if (instance) {
    report.push(
      `the Instance Effector: holds ${instance.secrets.length ? instance.secrets.map((s) => s.name).join(", ") : "nothing"}`,
    );
  }
  const sandbox: SandboxEffectorPlan[] = [];
  for (const ws of walk.workspaces) {
    if (ws.pod.effects.length === 0) continue;
    const plan = sandboxPlanOf(config, ws, secrets, values);
    if (sandbox.some((p) => p.pod === plan.pod)) continue;
    sandbox.push(plan);
    const holds = plan.secrets.map((s) => s.name);
    // Exact for a slot the Machine binds; for one the run or a customize() binds, the entry is
    // the one its url matches at provision (B10).
    const pushes = plan.pushes.map(
      (p) =>
        `Repo Slot "${p.slot}" with ` +
        (p.match !== undefined
          ? `git.credentials "${p.match}"`
          : "the git.credentials entry its url matches at provision"),
    );
    report.push(
      `${plan.label}: Sandbox Effector (image ${plan.image ?? "the Sandbox Image"}) holds ` +
        `${holds.length ? holds.join(", ") : "no Effect secret"}` +
        `${pushes.length ? `; pushes ${pushes.join(", ")}` : ""}`,
    );
  }
  return { held: pods, claimed, ...(instance ? { instance } : {}), sandbox, report, warnings };
}

/** A Workspace's Sandbox Effector: the secrets its Effects name, the targets its file-body https call, its
 * pushes by Repo Slot, and whether it holds a credentialed command. */
function sandboxPlanOf(
  config: JR2Config,
  ws: PlacedWorkspace,
  secrets: EffectSecret[],
  values: Record<string, string>,
): SandboxEffectorPlan {
  const named = new Set(ws.pod.effects.flatMap((e) => e.secrets ?? []));
  const own = secrets.filter((s) => named.has(s.name));
  const targets: EffectorTargetConfig[] = [];
  for (const effect of ws.pod.effects) {
    if (effect.kind !== "http") continue;
    const t = { ...effect.target, secrets: [...effect.secrets].sort() };
    const same = (x: EffectorTargetConfig) =>
      x.scheme === t.scheme && x.host === t.host && x.port === t.port && x.secrets.join() === t.secrets.join();
    if (!targets.some(same)) targets.push(t);
  }
  const pushes = pushesOf(config, ws);
  const commands = ws.pod.effects.some((e) => e.kind === "command" && (e.secrets?.length ?? 0) > 0);
  return {
    placement: "sandbox",
    pod: workspaceHeldPod({ workflow: ws.workflow, path: ws.pod.path }),
    label: workspaceLabel(ws),
    ...(ws.pod.effector ? { image: ws.pod.effector.image } : {}),
    ...(ws.pod.image !== undefined ? { sandboxImage: ws.pod.image } : {}),
    secrets: own,
    values: Object.fromEntries(Object.entries(values).filter(([name]) => named.has(name))),
    targets,
    pushes,
    commands,
    effects: ws.pod.effects.map((e) => `${ws.workflow}/${e.name}`),
  };
}

/**
 * Each push of a Workspace, by Repo Slot (ADR-0051, B6.2, B10), or the refusal with the fix — for a
 * slot the Machine binds to a url, whose entry `jr2 up` can see: a url no entry matches, a local
 * path or `git://`, an `http://` url (a push credential goes over https or ssh only), an entry that
 * holds no credential the url's scheme can spend (anonymous admits a clone, never a push), and
 * `sign: true` on an entry with no `sign` field. A slot the run or a `customize()` binds is checked
 * the same way at provision, against the url it then has.
 */
function pushesOf(config: JR2Config, ws: PlacedWorkspace): SandboxPush[] {
  const out: SandboxPush[] = [];
  const slots = Object.keys(ws.pod.bindings);
  const list = config.git?.credentials ?? [];
  for (const effect of ws.pod.effects) {
    if (effect.kind !== "push") continue;
    const slot = effect.slot ?? (slots.length === 1 ? slots[0] : undefined);
    if (slot === undefined) continue;
    const sign = effect.sign === true;
    // An unsigned squash needs the entry's committer (B15); a signed one has the signer's.
    const squash = effect.squash === true && !sign ? ({ squash: true } as const) : {};
    const same = (p: SandboxPush) => p.slot === slot && p.sign === sign && (p.squash === true) === "squash" in squash;
    const url = ws.pod.bindings[slot];
    if (url === undefined) {
      if (!out.some(same)) out.push({ slot, sign, ...squash });
      continue;
    }
    const at = `workflow "${ws.workflow}": push "${effect.name}" pushes Repo Slot "${slot}" (${url})`;
    const checked = pushRefusal(
      { at, url, sign, squash: "squash" in squash },
      list,
      declaredPushKinds,
      (entry) => entry.sign !== undefined,
    );
    if ("refusal" in checked) throw new Error(checked.refusal);
    if (!out.some(same)) out.push({ slot, sign, ...squash, url, match: checked.entry.match });
  }
  return out;
}

function effectorPlan(http: HttpPlaced[], secrets: EffectSecret[], values: Record<string, string>): EffectorPlan {
  const targets: EffectorTargetConfig[] = [];
  for (const { effect } of http) {
    const t = { ...effect.target, secrets: [...effect.secrets].sort() };
    const same = (x: EffectorTargetConfig) =>
      x.scheme === t.scheme && x.host === t.host && x.port === t.port && x.secrets.join() === t.secrets.join();
    if (!targets.some(same)) targets.push(t);
  }
  return {
    placement: "instance",
    secrets,
    values,
    targets,
    longestTimeoutMs: Math.max(...http.map((p) => p.effect.timeoutMs)),
    effects: http.map((p) => `${p.workflow}/${p.effect.name}`),
  };
}

type HttpPlaced = { workflow: string; effect: Extract<CarriedEffect, { method: string }> };

/** A Workspace as a human reads it: its workflow and the `customize()` route to it. */
function workspaceLabel({ workflow, pod }: PlacedWorkspace): string {
  if (pod.path === undefined) return `Workspace of workflow "${workflow}" (invoked inline)`;
  const route = pod.path.map((k) => ` → "${k}"`).join("");
  return `Workspace of workflow "${workflow}"${route}`;
}

/**
 * Each Harness pod and the Held secrets it gets: a Workspace's `secrets` plus its Agents' providers'
 * claims, the Instance Harness's `"none"` Agents' claims. A `workspace()` that lists a name the list
 * does not hold is refused with the line to add. Two Workspaces of one workflow that the walk cannot
 * tell apart (each invoked inline, so neither has a route) are one pod key, and are refused when
 * they would hold different names — the provision could not tell which one it places.
 */
function heldPodsOf(
  config: JR2Config,
  walk: PlacementWalk,
  listed: ReadonlySet<string>,
): { pods: HeldPodPlan[]; redundant: Array<{ label: string; name: string }> } {
  const order = (config.secrets ?? []).map((s) => s.name);
  const ordered = (names: Iterable<string>): string[] => {
    const set = new Set(names);
    return [...order.filter((n) => set.has(n)), ...(set.has(PROVIDER_KEY_NAME) ? [PROVIDER_KEY_NAME] : [])];
  };
  const pods: HeldPodPlan[] = [];
  const redundant: Array<{ label: string; name: string }> = [];
  for (const ws of walk.workspaces) {
    const label = workspaceLabel(ws);
    for (const name of ws.pod.secrets) {
      if (listed.has(name)) continue;
      throw new Error(
        `workflow "${ws.workflow}": a workspace() lists secrets: ["${name}"], which the \`secrets\` list does not ` +
          `hold — add it: secrets: [{ name: "${name}", value: process.env.${envish(name)}, hosts: ["<host>"] }] (ADR-0059)`,
      );
    }
    const byProvider = providerClaims(config, ws.pod.models);
    for (const name of ws.pod.secrets) if (byProvider.includes(name)) redundant.push({ label, name });
    const plan: HeldPodPlan = {
      pod: workspaceHeldPod({ workflow: ws.workflow, path: ws.pod.path }),
      label,
      names: ordered([...ws.pod.secrets, ...byProvider]),
      byProvider: ordered(byProvider),
    };
    const same = pods.find((p) => p.pod === plan.pod);
    if (same === undefined) pods.push(plan);
    else if (same.names.join() !== plan.names.join()) {
      throw new Error(
        `workflow "${ws.workflow}" invokes two workspace()s inline whose pods would hold different Held secrets ` +
          `(${same.names.join(", ") || "none"} and ${plan.names.join(", ") || "none"}) — a Workspace with no ` +
          "customize() route cannot be told from another at provision. Declare each under setup({ actors }) (ADR-0059)",
      );
    }
  }
  if (walk.instanceHarness) {
    const byProvider = ordered(providerClaims(config, walk.instanceHarness.models));
    pods.push({ pod: INSTANCE_HARNESS_HELD_POD, label: "the Instance Harness", names: byProvider, byProvider });
  }
  return { pods, redundant };
}

/** The list by name, refused when a name is listed twice; which Effects name which secret, refused
 * when an Effect names one the list does not hold. */
function namesOf(config: JR2Config, walk: PlacementWalk) {
  const entries = (config.secrets ?? []).map((entry, i) => ({ at: `secrets[${i}]`, ...entry }));
  const byName = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    if (byName.has(e.name)) {
      throw new Error(`${e.at}.name ${e.name} is listed twice — one name, one secret (ADR-0068)`);
    }
    byName.set(e.name, e);
  }
  // Every Effect that names a secret names it, whatever its kind: an `http` one in the Instance
  // Effector, a file-body `http` and a credentialed `command` in their Workspace's Sandbox Effector.
  const namedBy = new Map<string, Array<{ label: string; where: string }>>();
  const http = walk.effects.filter(
    (p): p is HttpPlaced => p.effect.kind === "http" && p.effect.placement === "instance",
  );
  // Keyed by the Effect's route and slot name, as workspacePodsOf keys a pod's Effects: two slots of
  // one name in one workflow — one in a workspace(), one outside it — are two Effects.
  const keyOf = (workflow: string, effect: CarriedEffect) =>
    JSON.stringify([workflow, effect.path ?? null, effect.name]);
  const sandboxOf = new Map<string, string>();
  for (const ws of walk.workspaces) {
    for (const e of ws.pod.effects)
      sandboxOf.set(keyOf(ws.workflow, e), `the Sandbox Effector of ${workspaceLabel(ws)}`);
  }
  // A Worktree file body needs a Worktree (ADR-0068): one no workspace() invokes has none to read.
  for (const { workflow, effect } of walk.effects) {
    if (effect.kind !== "http" || !effect.file || sandboxOf.has(keyOf(workflow, effect))) continue;
    throw new Error(
      `workflow "${workflow}": the http Effect "${effect.name}" sends a Worktree file as its body, and no ` +
        "workspace() invokes it — outside a Workspace there is no Worktree to read; invoke it from a " +
        "workspace()'s body, or send a json or text body (ADR-0068)",
    );
  }
  for (const { workflow, effect } of walk.effects) {
    const label = `${workflow}/${effect.name}`;
    const where =
      effect.placement === "instance"
        ? "the Instance Effector"
        : (sandboxOf.get(keyOf(workflow, effect)) ?? "the Sandbox Effector of the Workspace that invokes it");
    for (const name of effect.secrets ?? []) {
      if (!byName.has(name)) {
        throw new Error(
          `workflow "${workflow}": the ${effect.kind} Effect "${effect.name}" names secret("${name}"), which the ` +
            `\`secrets\` list does not hold — add it: secrets: [{ name: "${name}", value: process.env.${envish(name)} }] (ADR-0068)`,
        );
      }
      namedBy.set(name, [...(namedBy.get(name) ?? []), { label, where }]);
    }
  }
  return { entries, namedBy, http };
}

/** An Effect secret shorter than 8 characters is refused, and the refusal says why. */
/**
 * The length of a value a Kubernetes Secret holds (its `data`, base64), measured as the Effector
 * measures the file it mounts: in bytes, with one trailing "\n" and then one "\r" taken off. Only the
 * length leaves; `jr2 up` keeps no value of the user's Secret (ADR-0068).
 */
export function storedValueLength(base64: string): number {
  let bytes = Buffer.from(base64, "base64");
  if (bytes.at(-1) === 0x0a) bytes = bytes.subarray(0, -1);
  if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
  return bytes.length;
}

function shortRefusal(e: { at: string; name: string }, length: number): void {
  if (length >= EFFECT_SECRET_MIN_LENGTH) return;
  throw new Error(
    `${e.at} (${e.name}) is an Effect secret shorter than ${EFFECT_SECRET_MIN_LENGTH} characters — the ` +
      "Effector replaces every match of a secret in what it returns, and a value this short would match " +
      "ordinary text. Use the whole credential; the value itself is not shown (ADR-0068)",
  );
}

/** A name as the env var a `.env` line would most likely hold it under — for the fix line only. */
function envish(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}
