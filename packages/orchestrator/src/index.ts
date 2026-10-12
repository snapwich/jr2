// @jr2/orchestrator — the deployed app that runs Machines: workflow config, the agent + gate
// delivery surfaces, the duplex Actor over the Harness wire, and durable snapshot persistence
// (ADR-0002/0006/0007). Builds on the `@jr2/agent-protocol` wire contract.
//
// It does NOT speak MCP (ADR-0013): the Harness presents the Menu to its model itself, and reaches
// the surface here through the Custodian in its pod. What lives here is the registration table and
// two thin HTTP adapters over it — plus what composes a Custodian (ADR-0059).

// The wire contract, re-exported: a workflow authors against ONE package (`defineEvent`,
// `jr2Setup`, `workspace`, … all import from "@jr2/orchestrator" — ADR-0015).
export * from "@jr2/agent-protocol";
export * from "./agent.ts";
// The Effect surface (ADR-0067): `command` itself is the wire-bound one, from harness-client.ts;
// `fromPick`, `paramsOf` and `answer` are what an author writes between a pick and its work.
export * from "./effect.ts";
// The http kind (ADR-0068): `http`, `secret`, `bearer`, `basic`, `text`, and the Effector's wire.
export * from "./http-effect.ts";
export * from "./sandbox-effect.ts";
// An Effect's Open parts (ADR-0054): the types `customize({ effects })` reads.
export type { EffectBinding, OpenEffect, OpenEffectPart } from "./open-effect.ts";
export * from "./effector-wire.ts";
export * from "./pick.ts";
export * from "./parts.ts";
export * from "./size.ts";
export * from "./customize.ts";
export * from "./ambient.ts";
export * from "./config.ts";
export * from "./repo-identity.ts";
export * from "./pool.ts";
export * from "./setup.ts";
// The author's routing guard (ADR-0015).
export { sentBy } from "./party.ts";
export * from "./vocabulary.ts";
export * from "./tokens.ts";
export * from "./durability.ts";
export * from "./snapshot-store.ts";
export * from "./actor.ts";
export * from "./gate.ts";
export * from "./workspace.ts";
export * from "./images.ts";
export * from "./model-keys.ts";
export * from "./held-secrets.ts";
export * from "./secret-placement.ts";
export * from "./git-push.ts";
export * from "./git-clone.ts";
export * from "./custodian.ts";
export * from "./sandbox-kube.ts";
export {
  effectorManifestKey,
  LABEL_EFFECTOR_POD,
  readSandboxEffectorManifest,
  sandboxEffectorKeySecret,
  sandboxEffectorObjectsOf,
  type ProjectedSecret,
  type SandboxEffectorManifest,
} from "./sandbox-effector.ts";
export * from "./repos.ts";
export * from "./repo-fetch.ts";
// Type-only: what a workflow event delivery looks like (the registration TABLE stays internal —
// ADR-0011: workflows speak only defineEvent/agent/gate).
export type { ChildErrorMarker, DeliveredEvent, PlacingMarker, RunMarker, TurnMarker } from "./registration.ts";
export * from "./machine-doc.ts";
export * from "./run-host.ts";
export * from "./http.ts";
export * from "./harness-client.ts";
export * from "./stub-harness.ts";
export * from "./instance.ts";
export * from "./server.ts";
export * from "./names.ts";
