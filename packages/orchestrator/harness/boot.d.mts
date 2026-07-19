// Hand-written types for boot.mjs (which stays dependency-free plain JS — it is the stock Harness
// image's PID 1). Only the pure codegen half is typed; the boot half is not an export.

import type { AgentDefinition, HarnessConfig } from "../src/index.ts";

export type HarnessBootSpec = {
  agents: Array<{ name: string; definition: AgentDefinition }>;
  harness?: Pick<HarnessConfig, "model" | "provider">;
};

export type AssembledFile = { path: string; content: string };

/** The mounted agents.json spec → the generated flue modules (throws on an invalid spec). */
export function assemble(spec: HarnessBootSpec): AssembledFile[];
