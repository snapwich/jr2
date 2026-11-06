// The wait for the kubelet (ADR-0069, ADR-0078). The Orchestrator reads `jr2-images`, `jr2-held`
// and the two digests Secrets through mounts, and the kubelet refreshes a mount on its own period,
// about a minute. A write to one of them rolls no pod. So `GET /assembly` reports a digest of what
// the process reads from each, and a command that wrote one waits until the Orchestrator reports
// the digest of what the command wrote. Then the door's checks and the next provision read the new
// data, a new Caller token or Hook secret works, and a rotated value has stopped working.

import { configMapDigest, DIGEST_SECRETS, MOUNTED_CONFIGMAPS } from "@jr2/orchestrator/internal";
import { activity, type Io } from "./output.ts";

/**
 * How long a command waits for the Orchestrator to read what it wrote, and how often it asks. The
 * kubelet's period is about a minute by default. Exported so a test can shorten it.
 */
export const MAP_PROPAGATION = { budgetMs: 150_000, stepMs: 5_000 };

/** The part of `GET /assembly` that this wait reads: the digest of each mount, by object name. A
 * process that is not deployed reports no `mounts`, and has nothing to wait for. */
export type MountsView = { mounts?: Record<string, string> };

/** An applied object, read loosely: the fields that `mountedDigests` reads. */
export type AppliedObject = {
  kind?: string;
  metadata?: { name?: string };
  data?: Record<string, string>;
  stringData?: Record<string, string>;
};

/**
 * The digest of each object in `items` that the Orchestrator reads through a mount, by name: the
 * mounted ConfigMaps by their `data`, and the digests Secrets by their `stringData`, which is the
 * file content the kubelet writes.
 */
export function mountedDigests(items: readonly AppliedObject[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    const name = item.metadata?.name;
    if (name === undefined) continue;
    if (item.kind === "ConfigMap" && name in MOUNTED_CONFIGMAPS) out[name] = configMapDigest(item.data ?? {});
    if (item.kind === "Secret" && name in DIGEST_SECRETS) out[name] = configMapDigest(item.stringData ?? {});
  }
  return out;
}

/** The names in `want` that are digests Secrets: what a new token or Hook secret waits for. */
export function digestSecretsOf(want: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(want).filter(([name]) => name in DIGEST_SECRETS));
}

/**
 * Wait until the Orchestrator reports each digest in `want`, asking again each step until the
 * budget ends. It says once, under `prefix`, which objects it waits for. Returns the last view and
 * the names that were still older at the end: none when the wait succeeded.
 */
export async function awaitMounts<V extends MountsView>(
  io: Io,
  opts: { seen: V; view: () => Promise<V>; want: Readonly<Record<string, string>>; prefix: string },
): Promise<{ seen: V; stale: string[] }> {
  const { want } = opts;
  const stale = (v: V): string[] =>
    v.mounts ? Object.keys(want).filter((name) => v.mounts![name] !== want[name]) : [];
  const deadline = Date.now() + MAP_PROPAGATION.budgetMs;
  let seen = opts.seen;
  let said = false;
  for (let names = stale(seen); names.length; names = stale(seen)) {
    if (Date.now() >= deadline) return { seen, stale: names };
    if (!said)
      activity(io, `${opts.prefix}: waiting for the kubelet to deliver ${names.join(", ")} to the Orchestrator`);
    said = true;
    await new Promise((ok) => setTimeout(ok, MAP_PROPAGATION.stepMs));
    seen = await opts.view();
  }
  return { seen, stale: [] };
}

/** What a wait that ran out says, before the command's own consequence. */
export function staleLine(names: readonly string[]): string {
  return (
    `after ${Math.round(MAP_PROPAGATION.budgetMs / 1000)}s the Orchestrator still reads an older ` +
    `${names.join(", ")} from its mount — the kubelet has not refreshed it`
  );
}
