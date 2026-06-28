// Driver: the coder-Actor tier of the mock↔real swap, executed against a REAL
// Harness + real model. Same coding template; only the `coder` slot is swapped
// to `makeRealAgent` — the FROZEN duplex Actor (`agentRunActor`, ADR-0002)
// driving a real flue Agent over the MCP control plane. Work source, Sandbox,
// worktree, and the reviewer stay mock (the reviewer's approve/request_changes
// menu is not on the frozen control plane — ADR-0006).
//
// Wired by `run-coder.sh`, which builds/starts the Harness (PoC #5 worker
// overlay) and passes BASE + CP_PORT. Proves: the real Actor drops into the
// coding template by `provide()` alone, with no template change.

import { createActor } from "xstate";
import { ControlPlane } from "../../control-plane.ts";
import { assembleCodingMachine } from "../index.ts";
import { InMemoryWorkSource } from "../testing/mock-work-source.ts";
import { mockCodingProviders, newTracker, type ReviewerScript } from "../testing/mock-providers.ts";
import { makeRealAgent } from "../providers/real-coder.ts";

const BASE = process.env.BASE ?? "http://localhost:8092";
const CP_PORT = Number(process.env.CP_PORT ?? 8391);
const log = (s: string) => console.log(`\x1b[36m[coder-driver]\x1b[0m ${s}`);

async function main() {
  // The Sandbox → Orchestrator ingress (fixed port; the Harness was told this
  // base at start and the Actor attaches lazily at first prompt).
  const controlPlane = new ControlPlane({ port: CP_PORT });
  await controlPlane.start();
  log(`control plane up on :${controlPlane.port}`);

  const source = new InMemoryWorkSource([{ id: "demo", tasks: ["t0"] }]);
  const tracker = newTracker();
  const reviewer: ReviewerScript = () => ({ emit: "approve" });

  const providers = {
    // mock everything, then swap the coder to the REAL duplex Actor.
    ...mockCodingProviders({ source, tracker, coder: () => [{ emit: "done" }], reviewer }),
    coder: makeRealAgent({
      controlPlane,
      harnessBase: BASE,
      agentNameFor: () => "worker", // the PoC #5 control-plane-speaking agent
    }),
  };

  log("starting coding Machine with the REAL coder Actor…");
  const actor = createActor(assembleCodingMachine(providers), { input: { maxConcurrent: 1 } });
  actor.start();

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && !source.allFeaturesDone()) {
    await new Promise((r) => setTimeout(r, 250));
  }
  actor.stop();
  await controlPlane.stop();

  if (!source.allFeaturesDone()) {
    log("\x1b[31mFAILED\x1b[0m — task did not complete (Harness/model reachable?)");
    process.exit(1);
  }
  log(
    `real coder turns: ${tracker.coderTurns.length === 0 ? "(emitted via control plane)" : tracker.coderTurns.length}`,
  );
  log("\x1b[32mOK\x1b[0m — the real coder Actor drove the same template to task completion.");
  process.exit(0);
}

void main();
