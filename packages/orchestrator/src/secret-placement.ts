// Where each secret of the `secrets` list goes (ADR-0068, ADR-0059): placement is READ, never
// declared, and naming is placement on both sides. A pod gets the secrets something in it names:
//
//   - a Workspace's pod: the Held secrets its `workspace()` lists under `secrets: [...]`, and the
//     model keys of the Agents whose Turns run there — a model key is claimed by the PROVIDER;
//   - the Instance Harness: the model keys of the `"none"` Agents it hosts, and nothing else (they
//     cannot execute code, ADR-0031, so nothing else is theirs to use);
//   - an Effector: what its Effects name with `secret("name")` — the Instance Effector what its
//     `http` Effects name; a Workspace's Sandbox Effector what its `upload`s and credentialed
//     `command`s name, and the `git.credentials` entries its `push`es spend (ADR-0067).
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
import { matchCredential, type GitCredential, type JR2Config } from "./config.ts";
import { INSTANCE_HARNESS_HELD_POD } from "./names.ts";
import type { CarriedEffect, WorkspacePod } from "./parts.ts";
import { repoIdentity } from "./repo-identity.ts";

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

/** One `git.credentials` entry a Sandbox Effector's pushes spend, as its `effector.json` names it:
 * each credential a directory under the git mount (ADR-0068). */
export type SandboxGitEntry = {
  match: string;
  push: { sshKey: string } | { token: string };
  sign?: { sshKey: string; name: string; email: string } | { gpgKey: string; name: string; email: string };
};

/** One file of a git directory: a key of the user's Secret, by reference, or a token's value. */
export type SandboxGitFile =
  | { dir: string; file: string; source: { kind: "secret"; secret: string; key: string } }
  | { dir: string; file: string; source: { kind: "literal"; value: string } };

/** A Workspace's Sandbox Effector (ADR-0068, B5.1): what `jr2 up` writes for it. */
export type SandboxEffectorPlan = {
  placement: "sandbox";
  /** The pod key its objects are keyed by (`workspaceHeldPod`). */
  pod: string;
  label: string;
  /** The `workspace()`'s `effector: { image }`, as written; absent → the Sandbox Image. */
  image?: string;
  /** Every Effect secret its Effects name, in list order. */
  secrets: EffectSecret[];
  /** The literal values, by name — host-side only. */
  values: Record<string, string>;
  /** The targets its `upload`s name, with their secrets. */
  targets: EffectorTargetConfig[];
  /** The entries its pushes spend, and the files of their directories. */
  git: SandboxGitEntry[];
  gitFiles: SandboxGitFile[];
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
  for (const ws of walk.workspaces) pushEntriesOf(config, ws);
}

/**
 * Read where each secret goes, or throw the first refusal. `walk` is what the registered Machines
 * name; `lookups.secretKeys` is R10's read of the user's Secrets, and `lookups.valueLength` the
 * length of a `valueFrom` Effect secret's value there, which is refused when short as a literal is.
 */
export function secretPlacementsOf(
  config: JR2Config,
  walk: PlacementWalk,
  lookups: Pick<HeldLookups, "secretKeys" | "valueLength"> & {
    /** A token's value, by its env var (`.env`): a push token is written into its Effector's Secret. */
    env?: (name: string) => string | undefined;
  } = {},
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
    const plan = sandboxPlanOf(config, ws, secrets, values, lookups.env ?? (() => undefined));
    if (sandbox.some((p) => p.pod === plan.pod)) continue;
    sandbox.push(plan);
    const holds = plan.secrets.map((s) => s.name);
    const pushes = plan.git.map((g) => g.match);
    report.push(
      `${plan.label}: Sandbox Effector (image ${plan.image ?? "the Sandbox Image"}) holds ` +
        `${holds.length ? holds.join(", ") : "no Effect secret"}` +
        `${pushes.length ? `; pushes with git.credentials ${pushes.map((m) => `"${m}"`).join(", ")}` : ""}`,
    );
  }
  for (const w of perRunPushes(walk)) warnings.push(w);
  return { held: pods, claimed, ...(instance ? { instance } : {}), sandbox, report, warnings };
}

/** A Workspace's Sandbox Effector: the secrets its Effects name, the targets its uploads call, and
 * the `git.credentials` entries its pushes spend. */
function sandboxPlanOf(
  config: JR2Config,
  ws: PlacedWorkspace,
  secrets: EffectSecret[],
  values: Record<string, string>,
  env: (name: string) => string | undefined,
): SandboxEffectorPlan {
  const named = new Set(ws.pod.effects.flatMap((e) => e.secrets ?? []));
  const own = secrets.filter((s) => named.has(s.name));
  const targets: EffectorTargetConfig[] = [];
  for (const effect of ws.pod.effects) {
    if (effect.kind !== "upload" && effect.kind !== "http") continue;
    const t = { ...effect.target, secrets: [...effect.secrets].sort() };
    const same = (x: EffectorTargetConfig) =>
      x.scheme === t.scheme && x.host === t.host && x.port === t.port && x.secrets.join() === t.secrets.join();
    if (!targets.some(same)) targets.push(t);
  }
  const git: SandboxGitEntry[] = [];
  const gitFiles: SandboxGitFile[] = [];
  const list = config.git?.credentials ?? [];
  for (const { entry, url } of pushEntriesOf(config, ws)) {
    const i = list.indexOf(entry);
    if (git.some((g) => g.match === entry.match)) continue;
    const scheme = repoIdentity(url).scheme;
    const pushDir = `push-${i}`;
    const spend = entry.push ?? (scheme === "ssh" ? { sshKey: entry.sshKey! } : { token: entry.token! });
    if ("sshKey" in spend) {
      for (const file of ["identity", "known_hosts"]) {
        gitFiles.push({ dir: pushDir, file, source: { kind: "secret", secret: spend.sshKey, key: file } });
      }
    } else {
      const value = env(spend.token);
      if (!value) {
        throw new Error(
          `${ws.workflow}: the push credential of git.credentials entry "${entry.match}" is the token in ` +
            `${spend.token}, which is not set — set it in .env, as the clone's token is (ADR-0051)`,
        );
      }
      gitFiles.push({ dir: pushDir, file: "token", source: { kind: "literal", value } });
    }
    const out: SandboxGitEntry = {
      match: entry.match,
      push: "sshKey" in spend ? { sshKey: pushDir } : { token: pushDir },
    };
    if (entry.sign) {
      const signDir = `sign-${i}`;
      const { name, email } = entry.sign;
      if ("gpgKey" in entry.sign) {
        gitFiles.push({
          dir: signDir,
          file: "private.asc",
          source: { kind: "secret", secret: entry.sign.gpgKey, key: "private.asc" },
        });
        out.sign = { gpgKey: signDir, name, email };
      } else {
        gitFiles.push({
          dir: signDir,
          file: "identity",
          source: { kind: "secret", secret: entry.sign.sshKey, key: "identity" },
        });
        out.sign = { sshKey: signDir, name, email };
      }
    }
    git.push(out);
  }
  return {
    placement: "sandbox",
    pod: workspaceHeldPod({ workflow: ws.workflow, path: ws.pod.path }),
    label: workspaceLabel(ws),
    ...(ws.pod.effector ? { image: ws.pod.effector.image } : {}),
    secrets: own,
    values: Object.fromEntries(Object.entries(values).filter(([name]) => named.has(name))),
    targets,
    git,
    gitFiles,
    effects: ws.pod.effects.map((e) => `${ws.workflow}/${e.name}`),
  };
}

/**
 * The `git.credentials` entry each push of a Workspace spends (ADR-0051, B6.2), or the refusal
 * with the line to add: a push whose Binding no entry matches, an entry that holds no credential
 * the url's scheme can spend (anonymous admits a clone, never a push), and `sign: true` on an
 * entry with no `sign` field. A local path is never pushed to. A slot whose url the run chooses
 * (per-run, open) is not read here: its push is checked by the Effector when it runs.
 */
function pushEntriesOf(config: JR2Config, ws: PlacedWorkspace): Array<{ entry: GitCredential; url: string }> {
  const out: Array<{ entry: GitCredential; url: string }> = [];
  const slots = Object.keys(ws.pod.bindings);
  for (const effect of ws.pod.effects) {
    if (effect.kind !== "push") continue;
    const slot = effect.slot ?? (slots.length === 1 ? slots[0] : undefined);
    const url = slot === undefined ? undefined : ws.pod.bindings[slot];
    if (url === undefined) continue;
    const at = `workflow "${ws.workflow}": push "${effect.name}" pushes Repo Slot "${slot}" (${url})`;
    const { scheme, identity } = repoIdentity(url);
    if (scheme === "local") {
      throw new Error(
        `${at}, a local path — jr2 never pushes to one: git's local transport runs that repository's config and hooks (ADR-0067)`,
      );
    }
    if (scheme === "git") {
      throw new Error(`${at} over git://, which carries no credential — bind the slot over https or ssh (ADR-0051)`);
    }
    const entry = matchCredential(identity, config.git?.credentials ?? []);
    if (entry === undefined) {
      const fix =
        scheme === "ssh"
          ? `{ match: "${identity.split("/").slice(0, 2).join("/")}/", sshKey: "<a Secret with identity and known_hosts>" }`
          : `{ match: "${identity.split("/").slice(0, 2).join("/")}/", token: "<the env var that holds the token>" }`;
      throw new Error(
        `${at}, and no git.credentials entry matches "${identity}" — a push spends the entry its Binding ` +
          `matches; add one: git: { credentials: [${fix}] } (ADR-0051)`,
      );
    }
    const spend = entry.push ?? (scheme === "ssh" ? entry.sshKey : entry.token);
    const fits =
      entry.push === undefined
        ? spend !== undefined
        : scheme === "ssh"
          ? "sshKey" in entry.push
          : "token" in entry.push;
    if (!fits) {
      const line =
        scheme === "ssh"
          ? `push: { sshKey: "<a Secret with identity and known_hosts>" }`
          : `push: { token: "<the env var that holds the token>" }`;
      throw new Error(
        `${at}, and git.credentials entry "${entry.match}" holds no credential a push over ${scheme} can spend — ` +
          `an entry with none admits a clone, never a push; add ${line} to it (ADR-0051)`,
      );
    }
    if (effect.sign && entry.sign === undefined) {
      throw new Error(
        `${at} signed, and git.credentials entry "${entry.match}" holds no sign field — add ` +
          `sign: { sshKey: "<a Secret with identity>", name: "<committer name>", email: "<committer email>" } ` +
          "to it; the email must belong to the forge account that holds the key (ADR-0051, ADR-0067)",
      );
    }
    out.push({ entry, url });
  }
  return out;
}

/** A push on a slot whose url the run chooses: `jr2 up` cannot place its credential. */
function perRunPushes(walk: PlacementWalk): string[] {
  const out: string[] = [];
  for (const ws of walk.workspaces) {
    const slots = Object.keys(ws.pod.bindings);
    for (const effect of ws.pod.effects) {
      if (effect.kind !== "push") continue;
      const slot = effect.slot ?? (slots.length === 1 ? slots[0] : undefined);
      if (slot === undefined || ws.pod.bindings[slot] !== undefined) continue;
      out.push(
        `workflow "${ws.workflow}": push "${effect.name}" pushes Repo Slot "${slot}", whose url the run or a ` +
          "customize() chooses — jr2 up places no push credential for it, and the push is refused when it runs (ADR-0051)",
      );
    }
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
  // Effector, an `upload` and a credentialed `command` in their Workspace's Sandbox Effector.
  const namedBy = new Map<string, Array<{ label: string; where: string }>>();
  const http = walk.effects.filter((p): p is HttpPlaced => p.effect.kind === "http");
  const sandboxOf = new Map<string, string>();
  for (const ws of walk.workspaces) {
    for (const e of ws.pod.effects)
      sandboxOf.set(`${ws.workflow}/${e.name}`, `the Sandbox Effector of ${workspaceLabel(ws)}`);
  }
  for (const { workflow, effect } of walk.effects) {
    const label = `${workflow}/${effect.name}`;
    const where =
      effect.placement === "instance"
        ? "the Instance Effector"
        : (sandboxOf.get(label) ?? "the Sandbox Effector of the Workspace that invokes it");
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
