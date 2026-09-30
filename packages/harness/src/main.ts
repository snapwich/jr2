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
import { harnessServer } from "./app.ts";
import { attacher } from "./attach.ts";
import { seatFacts, standingBriefing } from "./briefing.ts";
import { clearShm, podMemoryGuard } from "./memory-guard.ts";
import { admissionFault, modelsFor } from "./provider.ts";
import { loadHarnessSpec } from "./spec.ts";
import { prepareProcess } from "./startup.ts";
import { serveHarness } from "./serve.ts";
import { runSubmissionFor } from "./turn.ts";

// FIRST, before anything reads the environment or writes a file: umask 002, PATH appended with
// /opt/jr2/bin, HOME defaulted. In a Sandbox the image is the user's and carries none of these, and
// every Working tool child inherits them from here (startup.ts, ADR-0037/ADR-0005).
// "First" is first STATEMENT, not first code: the imports above are ESM, so their module bodies run
// ahead of this line. That holds only because none of them touches PATH, HOME, the umask, or spawns
// a child at module scope — they declare constants and schemas (verified). A module that ever needs
// the conditioned environment at import time must read it inside a function, not at its top level.
prepareProcess();

// `/dev/shm` empty before any Working tool runs (ADR-0060): shm files outlive a container restart
// and stay charged to the pod, so a Harness restarted after a memory kill would start against the
// memory that killed it — the lab's crash loop.
clearShm();

function required(name: string, why: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`no ${name} in the environment — ${why}`);
  return value;
}

const harness = loadHarnessSpec(process.env);
// The Menu's route (ADR-0013, ADR-0059): the Custodian on this pod's loopback, and the Sandbox
// token's STAND-IN — the Agent reads this env, so the token itself is the Custodian's alone.
const menu = {
  url: required("JR2_CUSTODIAN_URL", "the Agent has no Custodian to reach, so it cannot drive its Machine (ADR-0013)"),
  token: required("JR2_SANDBOX_TOKEN", "the Menu is read with the Sandbox token's Stand-in (ADR-0059)"),
};
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

// One guard for the process (ADR-0061): it reads this container's cgroup, so every conversation's
// `bash` calls share it. It polls from here on, not only while a `bash` call runs — a dev server
// left from an earlier call or a human's exec session is one of the Agent's processes too. Off
// where `memory.max` is `max` or unreadable (a host run).
const guard = podMemoryGuard();
guard.start();

// The Briefing's standing part (ADR-0062), composed once for the pod: its CPUs from the Downward API
// (`JR2_CPUS`, ADR-0060) and its Size from the cgroup — read here, not per Turn, so every Turn of
// every conversation sends the same bytes. Unknown where this is not a Sandbox, and then unsaid.
const standing = standingBriefing(seatFacts(process.env));

const harnessWire = harnessServer({
  runSubmissionFor: (seat) => runSubmissionFor({ models, menu, guard, standing, ...seat }),
  // A guard kill lands on the running conversations' streams, for the Orchestrator's notice (ADR-0062).
  memoryKills: (listener) => guard.onKill(listener),
  // The attach (ADR-0063): the Workspace's Repos into `/work`, on the Orchestrator's call.
  attach: attacher(),
  checkAdmission: (resolved) => admissionFault(models, resolved),
  // Set on the Instance Harness StatefulSet alone (deploy.ts, ADR-0031): this placement admits
  // Menu-only Agents and refuses every other definition — the gate that keeps "no code
  // execution in this pod" a property, not a comment.
  ...(process.env.JR2_MENU_ONLY ? { menuOnly: true } : {}),
  checkBearer: (bearer) => bearer !== undefined && sha256(bearer) === bearerSha256,
  // Where each conversation is persisted and rebuilt from (ADR-0031): the Instance Harness's
  // PersistentVolumeClaim, a Sandbox Harness's emptyDir. Unset, conversations live in memory.
  ...(process.env.JR2_CONVERSATIONS_DIR ? { conversationsDir: process.env.JR2_CONVERSATIONS_DIR } : {}),
});

// A port another container in the pod took is said in one line, exit 1 (R16 — serve.ts).
const served = serveHarness(harnessWire, { port: Number(process.env.PORT ?? 8080) });

// A rollout drains Turns (ADR-0031): the first signal stops admitting and exits 0 once every
// admitted Submission has settled. A second is someone who will not wait — a human's second ^C.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log(`jr2 harness draining on ${signal}: admitting nothing, settling what it holds`);
    void served.stop();
  });
}
