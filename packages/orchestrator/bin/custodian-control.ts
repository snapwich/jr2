#!/usr/bin/env node
// The `control` container of a Custodian pod (ADR-0084): the second entrypoint of the Orchestrator Kit
// image. It makes each slot's rules live in the pod's Envoy, serves its API on port 18081, and serves
// each slot's resolver on port 25000 + i (UDP and TCP). Logic lives in `custodian-control.ts` and
// `custodian-resolver.ts`; this file owns only what a process owns: env, the ports, signals.
//
//   JR2_NAMESPACE          the Instance's namespace (fieldRef)
//   JR2_FENCE_RANGE        the Instance's VLAN range k (`jr2-fence-range-<k>`)
//   JR2_FENCE_SEGMENT      the segment, when the Instance's `fence` moves it
//   JR2_FENCE_PLACEHOLDERS the placeholder range, when the Instance's `fence` moves it

import { serve } from "@hono/node-server";
import { custodianControl, resolverTables } from "../src/custodian-control.ts";
import { custodianResolver } from "../src/custodian-resolver.ts";
import { slotVlan } from "../src/custodian-rules.ts";
import { CUSTODIAN_ADMIN_PORT, CUSTODIAN_CONTROL_PORT } from "../src/custodian.ts";
import { fenceRangesOf } from "../src/egress.ts";
import { kubeClient } from "../src/kube-client.ts";

const env = process.env;
const namespace = env.JR2_NAMESPACE;
const range = env.JR2_FENCE_RANGE ? Number(env.JR2_FENCE_RANGE) : Number.NaN;
const rangeError = (() => {
  try {
    slotVlan(range, 0);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
})();
if (!namespace || rangeError !== undefined) {
  console.error(
    `jr2.custodian control: JR2_NAMESPACE and JR2_FENCE_RANGE must be set (jr2 up sets both)${rangeError ? `: ${rangeError}` : ""}`,
  );
  process.exit(2);
}

const stop = new AbortController();
// The control process sets a slot's table once Envoy carries that version of its rules; the resolver
// answers from it.
const tables = resolverTables();
const resolver = custodianResolver({ tables });
try {
  await resolver.listen();
} catch (e) {
  console.error(`jr2.custodian control: the resolver cannot listen: ${(e as Error).message}`);
  process.exit(1);
}

const control = custodianControl({
  resolver: tables,
  kube: kubeClient(),
  namespace,
  range,
  ranges: fenceRangesOf({
    ...(env.JR2_FENCE_SEGMENT ? { segment: env.JR2_FENCE_SEGMENT } : {}),
    ...(env.JR2_FENCE_PLACEHOLDERS ? { placeholders: env.JR2_FENCE_PLACEHOLDERS } : {}),
  }),
  admin: async (path) => {
    const res = await fetch(`http://127.0.0.1:${CUSTODIAN_ADMIN_PORT}${path}`, {
      signal: AbortSignal.any([AbortSignal.timeout(10_000), stop.signal]),
    });
    if (!res.ok) throw new Error(`Envoy's admin answered ${res.status}`);
    return res.text();
  },
});

const server = serve({ fetch: control.fetch, port: CUSTODIAN_CONTROL_PORT, hostname: "0.0.0.0" });
const running = control.run(stop.signal);

// The process holds nothing that must be written: each wait for Envoy ends on the abort.
const shutdown = async (): Promise<void> => {
  stop.abort();
  server.close();
  await resolver.close();
  await running;
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
