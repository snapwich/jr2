#!/usr/bin/env node
// The `control` container of a Custodian pod (ADR-0084): the second entrypoint of the Orchestrator Kit
// image. It makes each slot's rules live in the pod's Envoy and serves its API on port 18081. Logic
// lives in `custodian-control.ts`; this file owns only what a process owns: env, the port, signals.
//
//   JR2_NAMESPACE          the Instance's namespace (fieldRef)
//   JR2_FENCE_RANGE        the Instance's VLAN range k (`jr2-fence-range-<k>`)
//   JR2_FENCE_SEGMENT      the segment, when the Instance's `fence` moves it
//   JR2_FENCE_PLACEHOLDERS the placeholder range, when the Instance's `fence` moves it

import { serve } from "@hono/node-server";
import { custodianControl } from "../src/custodian-control.ts";
import { CUSTODIAN_ADMIN_PORT, CUSTODIAN_CONTROL_PORT } from "../src/custodian.ts";
import { fenceRangesOf } from "../src/egress.ts";
import { kubeClient } from "../src/kube-client.ts";

const env = process.env;
const namespace = env.JR2_NAMESPACE;
const range = Number(env.JR2_FENCE_RANGE);
if (!namespace || !Number.isInteger(range) || range < 0) {
  console.error("jr2.custodian control: JR2_NAMESPACE and JR2_FENCE_RANGE must be set (jr2 up sets both)");
  process.exit(2);
}

const control = custodianControl({
  kube: kubeClient(),
  namespace,
  range,
  ranges: fenceRangesOf({
    ...(env.JR2_FENCE_SEGMENT ? { segment: env.JR2_FENCE_SEGMENT } : {}),
    ...(env.JR2_FENCE_PLACEHOLDERS ? { placeholders: env.JR2_FENCE_PLACEHOLDERS } : {}),
  }),
  admin: async (path) => {
    const res = await fetch(`http://127.0.0.1:${CUSTODIAN_ADMIN_PORT}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Envoy's admin answered ${res.status}`);
    return res.text();
  },
});

const server = serve({ fetch: control.fetch, port: CUSTODIAN_CONTROL_PORT, hostname: "0.0.0.0" });
const stop = new AbortController();
const running = control.run(stop.signal);

const shutdown = async (): Promise<void> => {
  stop.abort();
  server.close();
  await running;
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
