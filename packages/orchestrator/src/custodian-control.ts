// The control process of a Custodian pod (ADR-0084, ADR-0059): the `control` container, beside
// `envoy`, on each Sandbox node, one for each Instance. It makes the rules of each slot live in its
// own Envoy, and it says when they are:
//
//   read     each slot Secret (`jr2-custodian-slot-<i>`, `custodian-slot.ts`) by name, and each
//            Secret that holds a value the slot names (a pod's literals, a user's `secretKeyRef`);
//            the Custodian may get these names and no other Secret
//   render   the slot's rules (`renderSlot`), with a mark of its values and leaves, so that a changed
//            value makes a new Lua table and Envoy reads the values again
//   write    into the in-memory state folder that Envoy reads: the slot's values, leaves and Lua
//            table first, then the CDS file, and, when Envoy has those clusters, the LDS file. Each
//            file whole, by a rename, because Envoy reads both files on a move in the folder
//   wait     until Envoy's admin (loopback only) shows each changed slot's listener active with the
//            chain that names the version of its rules (`rulesChainName`), and the slot's resolver
//            table is of that version. Then the slot is live
//
// A slot whose Secret is gone, or whose rules cannot be rendered, or whose listener Envoy refuses,
// is removed: a slot with no rules reaches nothing. A slot whose Secrets cannot be read now (the API
// does not answer) keeps the rules it has only while the slot Secret, if it was read, names the same
// Harness pod: a slot given to another pod never serves it the rules of the pod before.
//
// It reads every slot at start and every 60 s, and one slot when the Orchestrator asks
// (`POST /slots/<i>`) on port 18081, with the Instance's dial token. It writes the dial token to the
// file that Envoy's inbound listener reads at each dial, so both take the same token. It reports
// which rules Envoy holds for a slot (`active`), and whether a pod answers on the slot's VLAN
// (`present`): the slot allocator reads both before it gives a slot again.
//
// A log line names slots, Harness pods, secrets and reasons; never a value, a Stand-in or a token.

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  custodianXds,
  ownerText,
  renderSlot,
  rulesChainName,
  slotAddress,
  slotVlan,
  type ResolverTable,
  type SlotOwner,
  type SlotRules,
} from "./custodian-rules.ts";
import { readSlotSecret, type SlotFiles, type SlotSpec } from "./custodian-slot.ts";
import {
  CUSTODIAN_CDS,
  CUSTODIAN_DIAL_TOKEN,
  CUSTODIAN_LDS,
  CUSTODIAN_STATE,
  DIAL_PORTS,
  DIAL_TOKEN_HEADER,
  FENCE_SLOTS,
  slotFolder,
  slotInterface,
} from "./custodian.ts";
import type { FenceRanges } from "./egress.ts";
import { SECRETS, type KubeClient, type KubeObject } from "./kube-client.ts";
import { CUSTODIAN_DIAL_KEY, CUSTODIAN_DIAL_SECRET, custodianSlotSecret, heldSecretsSecret } from "./names.ts";

/** How often the control process reads every slot again. */
export const CUSTODIAN_RESYNC_MS = 60_000;
/** How long one sync waits for Envoy to take the rules. */
const LIVE_TIMEOUT_MS = 30_000;
/** How many Secrets one sync reads at once. */
const READS = 16;
/** How long the `present` check waits for a slot's address to answer. */
const PRESENT_TIMEOUT_MS = 1_500;
/** A held secret's name: an env name, and so a file name of the slot's values. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The resolver tables of the slots, which the resolver answers from (`custodian-resolver.ts`). A
 * slot is live only when its table is of the version of its rules. */
export interface ResolverTables {
  set(table: ResolverTable): void;
  remove(slot: number): void;
  get(slot: number): ResolverTable | undefined;
}

/** The tables in memory: what the resolver of this process reads. */
export function resolverTables(): ResolverTables {
  const tables = new Map<number, ResolverTable>();
  return {
    set: (t) => void tables.set(t.slot, t),
    remove: (slot) => void tables.delete(slot),
    get: (slot) => tables.get(slot),
  };
}

export type CustodianControlOptions = {
  kube: Pick<KubeClient, "get">;
  /** The Instance's namespace: where each Secret is. */
  namespace: string;
  ranges: FenceRanges;
  /** The Instance's VLAN range (`jr2-fence-range-<k>`): it gives each slot's address. */
  range: number;
  /** Envoy's admin: the body of a GET of `path` on its loopback listener. */
  admin: (path: string) => Promise<string>;
  /** Where the state folder (`CUSTODIAN_STATE`) is. Default: that folder. */
  root?: string;
  resolver?: ResolverTables;
  /** Whether a pod answers at `address` on slot `slot`'s VLAN, or undefined when it cannot tell.
   * Default: `slotPresent`. */
  present?: (slot: number, address: string) => Promise<boolean | undefined>;
  log?: (line: string) => void;
  /** How long one sync waits for Envoy. Default 30 s. */
  liveTimeoutMs?: number;
};

/** What the control process says of one slot. */
export type SlotStatus = {
  slot: number;
  /** The version of the rules that the slot's Secrets state now: live, or waited for, or refused by
   * Envoy. `null` when the slot has no Secret, or its rules cannot be read or made now. */
  version: string | null;
  live: boolean;
  /** The version of the rules that Envoy holds for the slot (seen active, or written and not yet
   * seen), whatever the Secrets state now; `null` when Envoy holds no rules of the slot. A slot is
   * given again only when each Custodian pod answers `null` here. */
  active: string | null;
  /** Why the slot is not live. Names a key, a secret or a host; never a value. */
  error?: string;
  /** Whether a pod answers on the slot's VLAN: only on a GET, and absent when this pod cannot tell.
   * `false` only on a sign that no pod is there. */
  present?: boolean;
};

export type CustodianControl = {
  /** Read every slot and make the rules of each one live. */
  syncAll(): Promise<void>;
  /** Read one slot and make its rules live. */
  syncSlot(slot: number): Promise<SlotStatus>;
  status(slot: number): SlotStatus;
  /** True after a sync in which every slot that has rules became live or was refused. */
  ready(): boolean;
  /** The control API on port 18081. */
  fetch(req: Request): Promise<Response>;
  /** Sync at start (again every 2 s until ready), then every 60 s, until `signal` aborts. */
  run(signal: AbortSignal): Promise<void>;
};

/** What one read of a slot gave. */
type Wanted =
  | { kind: "absent" }
  /** The slot cannot be read now. It keeps what it has while `owner` and `heldPod` (the slot Secret's,
   * when it was read) are those of its rules. */
  | { kind: "unreadable"; owner?: SlotOwner; heldPod?: string; error: string }
  /** The slot's Secret is there, and its rules cannot be made: it is removed. */
  | { kind: "refused"; owner?: SlotOwner; error: string }
  | { kind: "ok"; slot: Slot };

/** One slot's rules and what they are made of. */
type Slot = {
  rules: SlotRules;
  owner: SlotOwner;
  heldPod?: string;
  files: SlotFiles;
  secrets: string[];
  hosts: number;
};

type DynamicListener = {
  name?: string;
  active_state?: { listener?: { filter_chains?: Array<{ name?: string }> } };
  error_state?: { failed_configuration?: unknown; details?: string };
};

export function custodianControl(opts: CustodianControlOptions): CustodianControl {
  const root = opts.root ?? CUSTODIAN_STATE;
  const local = (path: string): string => join(root, relative(CUSTODIAN_STATE, path));
  const log = opts.log ?? ((line: string) => console.log(line));
  const resolver = opts.resolver ?? resolverTables();
  const present = opts.present ?? slotPresent;
  const liveTimeout = opts.liveTimeoutMs ?? LIVE_TIMEOUT_MS;
  // A range with no VLANs would make each slot's address a program error at the first GET.
  slotVlan(opts.range, 0);

  const wanted = new Map<number, Wanted>();
  const applied = new Map<number, Slot>();
  /** The version of each slot in the LDS file last written: what Envoy takes, or has taken. */
  const inLds = new Map<number, string>();
  /** A version of a slot's rules that Envoy refused: not tried again until the version changes. */
  const refusedByEnvoy = new Map<number, string>();
  /** Why a slot is not live, by slot. */
  const errors = new Map<number, { version: string | null; error: string }>();
  let dialToken: Buffer | undefined;
  let written = false;
  let isReady = false;
  /** True once a full sync has written what each slot's Secrets state: before it, Envoy may hold
   * rules from the files of the process before, which `applied` does not know. */
  let synced = false;
  /** The signal of `run`: a wait for Envoy ends when it aborts. */
  let stop: AbortSignal | undefined;
  const pause = (ms: number) => sleep(ms, undefined, stop === undefined ? {} : { signal: stop });

  // One sync at a time: two would write the LDS file over each other.
  let queue: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  const secretData = async (name: string): Promise<Record<string, string> | undefined> => {
    const s = await opts.kube.get<KubeObject & { data?: Record<string, string> }>(SECRETS, opts.namespace, name);
    return s === undefined ? undefined : (s.data ?? {});
  };

  /** Read the dial token, and write it where Envoy's inbound listener reads it. */
  const readDialToken = async (): Promise<void> => {
    let data: Record<string, string> | undefined;
    try {
      data = await secretData(CUSTODIAN_DIAL_SECRET);
    } catch (e) {
      log(`jr2.custodian control action=read secret=${CUSTODIAN_DIAL_SECRET} error=${reasonOf(e)}`);
      return;
    }
    const value = data?.[CUSTODIAN_DIAL_KEY];
    if (value === undefined) {
      log(`jr2.custodian control action=read secret=${CUSTODIAN_DIAL_SECRET} error=no-token`);
      return;
    }
    const token = dialTokenOf(Buffer.from(value, "base64"));
    if (token === undefined) {
      log(`jr2.custodian control action=read secret=${CUSTODIAN_DIAL_SECRET} error=empty-token`);
      return;
    }
    if (dialToken !== undefined && token.equals(dialToken)) return;
    await put(local(CUSTODIAN_DIAL_TOKEN), token);
    dialToken = token;
  };

  /** One slot, as its Secrets state it now. Never throws: what goes wrong is the slot's alone. */
  const read = async (
    slot: number,
    cache: Map<string, Promise<Record<string, string> | undefined>>,
  ): Promise<Wanted> => {
    const get = (name: string) => {
      if (!cache.has(name)) cache.set(name, secretData(name));
      return cache.get(name)!;
    };
    /** A get that failed. 403 is a lasting answer (the Role does not name the Secret): the slot is
     * refused. Any other error is a pause of the API. */
    const failed = (what: string, e: unknown, spec?: SlotSpec): Wanted => {
      const error = `${what} cannot be read: ${reasonOf(e)}`;
      const owner = spec === undefined ? {} : { owner: spec.owner };
      if ((e as { status?: number }).status === 403) return { kind: "refused", ...owner, error };
      return { kind: "unreadable", ...owner, ...(spec?.heldPod === undefined ? {} : { heldPod: spec.heldPod }), error };
    };
    let data: Record<string, string> | undefined;
    try {
      data = await get(custodianSlotSecret(slot));
    } catch (e) {
      return failed("the slot Secret", e);
    }
    if (data === undefined) return { kind: "absent" };
    let owner: SlotOwner | undefined;
    try {
      const { spec, files } = readSlotSecret(data);
      owner = spec.owner;
      for (const binding of spec.manifest.secrets) {
        if (!ENV_NAME.test(binding.name)) {
          return { kind: "refused", owner, error: "a held secret's name is not an env name" };
        }
        // A slot that names no pod holds its literal values itself (a check pod).
        if (binding.source.kind === "literal" && spec.heldPod === undefined) {
          if (files.has(`values/${binding.name}`)) continue;
          return {
            kind: "refused",
            owner,
            error: `the value of ${binding.name} is missing: no key values.${binding.name} in the slot Secret, and it names no pod that holds it`,
          };
        }
        const [secret, key] =
          binding.source.kind === "secret"
            ? [binding.source.secret, binding.source.key]
            : [heldSecretsSecret(spec.heldPod!), binding.name];
        let values: Record<string, string> | undefined;
        try {
          values = await get(secret);
        } catch (e) {
          return failed(`the Secret ${secret}`, e, spec);
        }
        const value = values?.[key];
        if (value === undefined) {
          return {
            kind: "refused",
            owner,
            error: `the value of ${binding.name} is missing: no key ${key} in the Secret ${secret}`,
          };
        }
        files.set(`values/${binding.name}`, Buffer.from(value, "base64"));
      }
      const rules = renderSlot({
        slot,
        owner: spec.owner,
        manifest: spec.manifest,
        placeholders: spec.placeholders,
        ranges: opts.ranges,
        valuesVersion: filesVersion(files),
      });
      const secrets = spec.manifest.secrets.map((x) => x.name);
      const hosts = new Set(spec.manifest.egress.map((e) => e.host)).size;
      const heldPod = spec.heldPod === undefined ? {} : { heldPod: spec.heldPod };
      return { kind: "ok", slot: { rules, owner: spec.owner, ...heldPod, files, secrets, hosts } };
    } catch (e) {
      return { kind: "refused", ...(owner === undefined ? {} : { owner }), error: (e as Error).message };
    }
  };

  const who = (slot: number, owner: SlotOwner | undefined): string => {
    if (owner === undefined) return `slot=${slot}`;
    try {
      return `slot=${slot} ${ownerText(owner)}`;
    } catch {
      return `slot=${slot}`;
    }
  };

  /** Make Envoy serve the rules that `wanted` states, and wait until it does. `verify` also reads
   * each live slot back from Envoy (the full sync does; one slot's sync does not). */
  const converge = async (verify: boolean): Promise<void> => {
    const next = new Map<number, Slot>();
    for (let slot = 0; slot < FENCE_SLOTS; slot++) {
      const w = wanted.get(slot);
      if (w?.kind === "ok" && refusedByEnvoy.get(slot) !== w.slot.rules.version) next.set(slot, w.slot);
      const a = applied.get(slot);
      // Rules kept through a pause of the API are those of the same Harness pod: a slot that was
      // given to another pod is removed, so that the new pod never gets the old pod's rules.
      if (w?.kind === "unreadable" && a !== undefined && (w.owner === undefined || sameHolder(a, w))) {
        next.set(slot, a);
      }
    }
    // A slot whose rules Envoy no longer shows (its container started again and read an older
    // file) is written again.
    const lost = verify ? await lostSlots() : new Set<number>();
    const changed = [...next.values()].filter(
      (s) => applied.get(s.rules.slot)?.rules.version !== s.rules.version || lost.has(s.rules.slot),
    );
    const removed = [...applied.keys()].filter((slot) => !next.has(slot));
    if (written && changed.length === 0 && removed.length === 0) return;

    // A name of a removed slot stops answering before its listener goes.
    for (const slot of removed) resolver.remove(slot);
    for (const s of changed) await writeSlot(s);
    await writeXds([...next.values()].map((s) => s.rules));
    written = true;
    const outcome = await settle(
      changed.map((s) => s.rules),
      removed,
    );

    if (outcome.refused.length > 0) {
      for (const r of outcome.refused) {
        refusedByEnvoy.set(r.slot, r.version);
        next.delete(r.slot);
      }
      // Envoy keeps the old listener of a slot whose new one it refused: the slot is written out,
      // so that it reaches nothing rather than what it reached before. Its names stop answering
      // first.
      for (const r of outcome.refused) resolver.remove(r.slot);
      await writeXds([...next.values()].map((s) => s.rules));
      const out = await settle(
        [],
        outcome.refused.map((r) => r.slot).filter((slot) => applied.has(slot)),
      );
      outcome.removed.push(...out.removed);
    }
    for (const r of outcome.live) {
      const s = next.get(r.slot)!;
      // The resolver answers the slot's names once Envoy carries them.
      resolver.set(r.resolver);
      applied.set(r.slot, s);
      errors.delete(r.slot);
      await removeStale(s);
      log(
        `jr2.custodian ready ${who(r.slot, s.owner)} version=${r.version} secrets=${s.secrets.join(",")} hosts=${s.hosts}`,
      );
    }
    for (const slot of outcome.removed) {
      const was = applied.get(slot);
      resolver.remove(slot);
      applied.delete(slot);
      await rm(local(slotFolder(slot)), { recursive: true, force: true });
      log(`jr2.custodian removed ${who(slot, was?.owner)}`);
    }
    for (const r of outcome.refused) {
      const s = changed.find((c) => c.rules.slot === r.slot)!;
      if (!applied.has(r.slot)) await rm(local(slotFolder(r.slot)), { recursive: true, force: true });
      errors.set(r.slot, { version: r.version, error: "Envoy refused the slot's rules: its own log says why" });
      log(`jr2.custodian refuse ${who(r.slot, s.owner)} version=${r.version} reason=envoy`);
    }
    for (const r of outcome.waiting) {
      errors.set(r.slot, { version: r.version, error: "Envoy did not take the slot's rules in time" });
      log(`jr2.custodian control ${who(r.slot, next.get(r.slot)?.owner)} version=${r.version} error=envoy-timeout`);
    }
  };

  /** The slots that `applied` holds and whose rules Envoy's active listeners no longer show. */
  const lostSlots = async (): Promise<Set<number>> => {
    const lost = new Set<number>();
    if (applied.size === 0) return lost;
    const dump = await listeners(`^slot-[0-9]*$`).catch(() => undefined);
    if (dump === undefined) return lost;
    for (const [slot, a] of applied) {
      if (!activeWith(dump.get(`slot-${slot}`), a.rules.version)) lost.add(slot);
    }
    return lost;
  };

  /** Each file of the slot, then its Lua table. */
  const writeSlot = async ({ rules, files }: Slot): Promise<void> => {
    for (const [path, content] of files) await put(local(`${slotFolder(rules.slot)}/${path}`), content);
    await put(local(rules.lua.path), Buffer.from(rules.lua.text));
  };

  /** The files of a slot that its live rules no longer name: an old Lua table, a value or a leaf. */
  const removeStale = async ({ rules: r, files }: Slot): Promise<void> => {
    const folder = local(slotFolder(r.slot));
    const keep = new Set([...files.keys(), relative(slotFolder(r.slot), r.lua.path)]);
    const entries = await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      const path = relative(folder, join(e.parentPath, e.name));
      if (!keep.has(path)) await rm(join(folder, path), { force: true });
    }
  };

  /** The folders of slots that neither `applied` nor the LDS file holds: a slot that went while
   * this process was down leaves its values, tokens and leaves there, and the first sync removes
   * them. */
  const removeOrphans = async (): Promise<void> => {
    const slots = local(`${CUSTODIAN_STATE}/slots`);
    for (const name of await readdir(slots).catch(() => [] as string[])) {
      const slot = /^(0|[1-9][0-9]{0,2})$/.test(name) ? Number(name) : -1;
      if (slot < 0 || slot >= FENCE_SLOTS || applied.has(slot) || inLds.has(slot)) continue;
      await rm(join(slots, name), { recursive: true, force: true });
      log(`jr2.custodian removed slot=${slot}`);
    }
  };

  /** The CDS file, and when Envoy has its clusters, the LDS file: a listener that names a cluster
   * Envoy does not know yet is refused, and nothing reads the LDS file again until its next move. */
  const writeXds = async (slots: SlotRules[]): Promise<void> => {
    const { lds, cds } = custodianXds(slots.sort((a, b) => a.slot - b.slot));
    await put(local(CUSTODIAN_CDS), Buffer.from(JSON.stringify(cds)));
    const deadline = performance.now() + liveTimeout;
    const want = `"${cds.version_info as string}"`;
    for (;;) {
      const stats = await opts.admin("/stats?filter=^cluster_manager\\.cds\\.version_text$").catch(() => "");
      if (stats.includes(want) || performance.now() > deadline) break;
      await pause(10);
    }
    await put(local(CUSTODIAN_LDS), Buffer.from(JSON.stringify(lds)));
    inLds.clear();
    for (const r of slots) inLds.set(r.slot, r.version);
  };

  /** The dynamic listeners whose names match `regex`, by name. */
  const listeners = async (regex: string): Promise<Map<string, DynamicListener>> => {
    const text = await opts.admin(`/config_dump?resource=dynamic_listeners&name_regex=${regex}`);
    const parsed = JSON.parse(text) as { configs?: DynamicListener[] };
    return new Map((parsed.configs ?? []).map((c) => [c.name ?? "", c]));
  };

  /** Wait until each changed slot is live or refused, and each removed slot has no active listener. */
  const settle = async (changed: SlotRules[], removed: number[]) => {
    const live: SlotRules[] = [];
    const refused: SlotRules[] = [];
    const gone: number[] = [];
    let waiting = [...changed];
    let going = [...removed];
    const deadline = performance.now() + liveTimeout;
    while (waiting.length > 0 || going.length > 0) {
      const names = [...waiting.map((r) => r.slot), ...going];
      const dump = await listeners(`^slot-(${names.join("|")})$`).catch(() => undefined);
      if (dump !== undefined) {
        for (const r of waiting) {
          const l = dump.get(`slot-${r.slot}`);
          if (activeWith(l, r.version)) live.push(r);
          else if (JSON.stringify(l?.error_state?.failed_configuration ?? "").includes(rulesChainName(r.version))) {
            refused.push(r);
          }
        }
        for (const slot of going) if (dump.get(`slot-${slot}`)?.active_state === undefined) gone.push(slot);
        waiting = waiting.filter((r) => !live.includes(r) && !refused.includes(r));
        going = going.filter((s) => !gone.includes(s));
      }
      if (waiting.length === 0 && going.length === 0) break;
      if (performance.now() > deadline) break;
      await pause(20);
    }
    return { live, refused, removed: gone, waiting };
  };

  /** Keep what one read of a slot gave, and log a reason that is new. */
  const record = (slot: number, w: Wanted): void => {
    wanted.set(slot, w);
    if (w.kind === "absent" || (w.kind === "ok" && refusedByEnvoy.get(slot) !== w.slot.rules.version)) {
      errors.delete(slot);
      return;
    }
    if (w.kind === "ok") return;
    const known = errors.get(slot);
    if (known?.error === w.error) return;
    errors.set(slot, { version: null, error: w.error });
    const line = w.error.replace(/\s+/g, " ");
    if (w.kind === "refused") log(`jr2.custodian refuse ${who(slot, w.owner)} reason=rules why=${line}`);
    // While the API does not answer, a line for each slot with rules; `syncAll` writes one for all.
    else if (applied.has(slot)) {
      log(`jr2.custodian control ${who(slot, w.owner ?? applied.get(slot)!.owner)} error=${line}`);
    }
  };

  const syncAll = (): Promise<void> =>
    locked(async () => {
      await readDialToken();
      const cache = new Map<string, Promise<Record<string, string> | undefined>>();
      const slots = [...Array(FENCE_SLOTS).keys()];
      const reads: Wanted[] = new Array(FENCE_SLOTS);
      for (let i = 0; i < slots.length; i += READS) {
        const batch = slots.slice(i, i + READS);
        const got = await Promise.all(batch.map((slot) => read(slot, cache)));
        batch.forEach((slot, j) => (reads[slot] = got[j]!));
      }
      for (const slot of slots) record(slot, reads[slot]!);
      const unread = slots.filter((slot) => reads[slot]!.kind === "unreadable").length;
      if (unread > 0) log(`jr2.custodian control action=read error=unreadable slots=${unread}`);
      await converge(true);
      if (!synced) await removeOrphans();
      synced = true;
      // Ready once it has the dial token and each slot was read, and each that has rules is live or refused: a pod that starts
      // later is live for each slot before the Orchestrator dials through it. Then it stays ready, so
      // that a pause of the API does not take a pod that serves out of the EndpointSlice.
      isReady ||=
        dialToken !== undefined &&
        slots.every((slot) => {
          const w = wanted.get(slot)!;
          if (w.kind === "unreadable") return false;
          if (w.kind !== "ok") return true;
          const version = w.slot.rules.version;
          return applied.get(slot)?.rules.version === version || refusedByEnvoy.get(slot) === version;
        });
    });

  /** A slot is live when Envoy shows its rules active and its resolver table is of their version. */
  const status = (slot: number): SlotStatus => {
    const a = applied.get(slot);
    const w = wanted.get(slot);
    const e = errors.get(slot);
    const wantedVersion = w?.kind === "ok" ? w.slot.rules.version : null;
    const active = a?.rules.version ?? inLds.get(slot) ?? null;
    const live =
      a !== undefined &&
      e === undefined &&
      (wantedVersion === null || a.rules.version === wantedVersion) &&
      resolver.get(slot)?.version === a.rules.version;
    if (live) return { slot, version: a.rules.version, live: true, active };
    return {
      slot,
      version: wantedVersion ?? e?.version ?? null,
      live: false,
      active,
      ...(e !== undefined ? { error: e.error } : {}),
    };
  };

  const syncSlot = (slot: number): Promise<SlotStatus> =>
    locked(async () => {
      record(slot, await read(slot, new Map()));
      await converge(false);
      return status(slot);
    });

  const authorized = (req: Request): boolean => {
    const given = req.headers.get(DIAL_TOKEN_HEADER);
    if (dialToken === undefined || given === null) return false;
    const a = createHash("sha256").update(given).digest();
    const b = createHash("sha256").update(dialToken).digest();
    return timingSafeEqual(a, b);
  };

  const text = (status: number, body: string): Response =>
    new Response(`jr2 custodian: ${body}\n`, { status, headers: { "content-type": "text/plain" } });

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return req.method === "GET" ? (isReady ? text(200, "ok") : text(503, "not ready")) : text(405, "GET only");
    }
    const m = /^\/slots\/(0|[1-9][0-9]{0,2})$/.exec(url.pathname);
    const slot = m === null ? -1 : Number(m[1]);
    if (slot < 0 || slot >= FENCE_SLOTS) return text(404, "no such route");
    if (!authorized(req)) {
      log(`jr2.custodian control action=refuse slot=${slot} reason=dial`);
      return text(401, "refused: this API takes the Instance's dial token (ADR-0084)");
    }
    // Before the first full sync, Envoy may hold rules that this process does not know of yet.
    if (!synced) return text(503, "not ready: the first sync of every slot has not ended");
    if (req.method === "GET") {
      const address = slotAddress(opts.ranges.segment, slotVlan(opts.range, slot));
      // An error says nothing of the VLAN: `present` is then absent, never `false`.
      const seen = await present(slot, address).catch(() => undefined);
      return Response.json({ ...status(slot), ...(seen === undefined ? {} : { present: seen }) });
    }
    if (req.method === "POST") return Response.json(await syncSlot(slot));
    return text(405, "GET or POST");
  };

  /** Each wait for Envoy ends when `signal` aborts, so that the process stops at once: it holds
   * nothing that must be written, and the next process reads every slot again. */
  const run = async (signal: AbortSignal): Promise<void> => {
    stop = signal;
    while (!signal.aborted) {
      try {
        await syncAll();
      } catch (e) {
        if (signal.aborted) break;
        log(`jr2.custodian control action=sync error=${reasonOf(e)}`);
      }
      await sleep(isReady ? CUSTODIAN_RESYNC_MS : 2_000, undefined, { signal }).catch(() => {});
    }
  };

  return { syncAll, syncSlot, status, ready: () => isReady, fetch: fetchHandler, run };
}

/** True when a read of a slot names the Harness pod, and the pod of literal values, of its rules. */
function sameHolder(a: Slot, w: { owner?: SlotOwner; heldPod?: string }): boolean {
  return JSON.stringify(a.owner) === JSON.stringify(w.owner) && a.heldPod === w.heldPod;
}

/** The dial token as Envoy's inbound role reads it (`custodian.lua`): one trailing `\n` or `\r\n`
 * taken off; `undefined` when nothing is left. */
export function dialTokenOf(raw: Buffer): Buffer | undefined {
  let end = raw.length;
  if (raw[end - 1] === 0x0a) end -= raw[end - 2] === 0x0d ? 2 : 1;
  return end === 0 ? undefined : raw.subarray(0, end);
}

/** True when the listener's active state has the chain of the rules of `version`. */
function activeWith(l: DynamicListener | undefined, version: string): boolean {
  const mark = rulesChainName(version);
  return (l?.active_state?.listener?.filter_chains ?? []).some((c) => (c.name ?? "").split(" ").includes(mark));
}

/** A mark of a slot's files: changes when a value, a Stand-in, a token or a leaf changes. */
function filesVersion(files: SlotFiles): string {
  const h = createHash("sha256");
  for (const path of [...files.keys()].sort()) h.update(path).update("\0").update(files.get(path)!).update("\0");
  return h.digest("hex").slice(0, 16);
}

/** Write a file whole: a temp name, then a rename. */
async function put(path: string, content: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.next`, content, { mode: 0o644 });
  await rename(`${path}.next`, path);
}

/** A reason for a log line: the error's class and status, never a body. */
function reasonOf(e: unknown): string {
  const err = e as { name?: string; status?: number; code?: string; message?: string };
  if (err.status !== undefined) return `${err.name ?? "Error"}:${err.status}`;
  return `${err.name ?? "Error"}:${(err.code ?? err.message ?? "").slice(0, 120).replace(/\s+/g, "-")}`;
}

/**
 * Whether a pod answers at a slot's address (the slot allocator reads it before it gives a slot
 * again), or undefined when this process cannot tell. A TCP connection to the Harness port on the
 * slot's VLAN makes the kernel ask for the address by ARP: an answer, or a refusal, says a pod is
 * there; `EHOSTUNREACH` says that no pod answered the ARP. Else the neighbour table tells
 * (`neighbourSays`). No capability: the control container has none.
 */
export async function slotPresent(slot: number, address: string): Promise<boolean | undefined> {
  const answered = await new Promise<boolean | undefined>((resolve) => {
    const socket = connect({ host: address, port: DIAL_PORTS[0]! });
    const done = (v: boolean | undefined) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(PRESENT_TIMEOUT_MS, () => done(undefined));
    socket.once("connect", () => done(true));
    socket.once("error", (e: NodeJS.ErrnoException) =>
      done(e.code === "ECONNREFUSED" ? true : e.code === "EHOSTUNREACH" ? false : undefined),
    );
  });
  if (answered !== undefined) return answered;
  const table = await readFile("/proc/net/arp", "utf8").catch(() => undefined);
  return table === undefined ? undefined : neighbourSays(table, address, slotInterface(slot));
}

/**
 * What `/proc/net/arp` says of `address` on `device`: true when it is resolved (flag 0x2), false
 * when the kernel asked and no pod answered (flags 0x0), and undefined with no entry (no ARP request
 * went out, so the table says nothing) or with other flags.
 */
export function neighbourSays(table: string, address: string, device: string): boolean | undefined {
  const entry = table
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .find((cols) => cols[0] === address && cols[5] === device);
  if (entry === undefined) return undefined;
  const flags = Number(entry[2]);
  if ((flags & 0x2) !== 0) return true;
  return flags === 0 ? false : undefined;
}
