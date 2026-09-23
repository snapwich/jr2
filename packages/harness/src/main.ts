// The Harness process's PID 1 (ADR-0018/0027): process → env → reach → serve. Runtime
// construction, not codegen — the retired boot assembly and its readiness lag are gone; binding
// :8080 is the pod's Ready signal. Everything here is wiring: validation lives in `spec.ts`, the
// wire in `app.ts`, the turn in `turn.ts`. Fatal errors land in the pod log by throwing.
//
// The env carries what this instance can REACH and nothing about WHO runs (ADR-0049): each
// admission brings its own Agent definition, so this process boots knowing no Agents at all.
//
// It is the container's command in BOTH placements: the stock image's own `CMD` (the Instance
// Harness, ADR-0031), and the command the operator overrides a Sandbox Image with, where jr2's
// runtime is mounted at `/opt/jr2` and nothing about this process came from the image (ADR-0037).

import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { harnessApp } from "./app.ts";
import { admissionFault, modelsFor } from "./provider.ts";
import { loadHarnessSpec } from "./spec.ts";
import { prepareProcess } from "./startup.ts";
import { runSubmissionFor } from "./turn.ts";

// FIRST, before anything reads the environment or writes a file: umask 002, PATH appended with
// /opt/jr2/bin, HOME defaulted. In a Sandbox the image is the user's and carries none of these, and
// every Working tool child inherits them from here (startup.ts, ADR-0037/ADR-0005).
// "First" is first STATEMENT, not first code: the imports above are ESM, so their module bodies run
// ahead of this line. That holds only because none of them touches PATH, HOME, the umask, or spawns
// a child at module scope — they declare constants and schemas (verified). A module that ever needs
// the conditioned environment at import time must read it inside a function, not at its top level.
prepareProcess();

function required(name: string, why: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`no ${name} in the environment — ${why}`);
  return value;
}

const harness = loadHarnessSpec(process.env);
const adapterUrl = required(
  "JR2_ADAPTER_URL",
  "the Agent has no Adapter to reach, so it cannot drive its Machine (ADR-0013)",
);
const models = modelsFor(harness, process.env);

// The wire's gate (ADR-0058): the Orchestrator bears a token derived for THIS placement, and the
// env carries only its sha-256 — the Agent has code execution in this container, and a digest
// verifies without minting, for this pod or any other. Required at boot: a Harness that could not
// check a bearer would admit anyone who can reach it, which is the hole this closes. Digests
// compare with `===` on purpose: what a timing leak could reveal is a hash prefix, which inverts to
// nothing.
const bearerSha256 = required(
  "JR2_HARNESS_TOKEN_SHA256",
  "the Harness cannot authenticate the Orchestrator, and an unauthenticated wire lets any pod that reaches it drive its conversations (ADR-0058)",
);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("base64url");

const app = harnessApp({
  runSubmissionFor: (seat) => runSubmissionFor({ models, adapterUrl, ...seat }),
  checkAdmission: (resolved) => admissionFault(models, resolved),
  // Set on the Instance Harness Deployment alone (deploy.ts, ADR-0031): this placement admits
  // Menu-only Agents and refuses every other definition — the gate that keeps "no code
  // execution in this pod" a property, not a comment.
  ...(process.env.JR2_MENU_ONLY ? { menuOnly: true } : {}),
  checkBearer: (bearer) => bearer !== undefined && sha256(bearer) === bearerSha256,
});

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080), hostname: "0.0.0.0" }, (info) => {
  // No agent count: this process holds no roster to count (ADR-0049) — every admission brings
  // the definition it runs.
  console.log(`jr2 harness serving on :${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Parked long-polls hold sockets open; without severing them a graceful close outlives the
    // pod's termination grace period.
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}
