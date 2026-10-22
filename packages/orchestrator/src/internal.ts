// @jr2/orchestrator/internal — NOT for workflow authors. Everything the kit's own packages share
// that is not on the Authoring surface (index.ts): the run host, the HTTP API, the Harness wire,
// the Custodian, the Effector wire, the cluster names, the load walk. The CLI, the e2e suite,
// and any other kit package that imports this one use it. No stability promise: any
// name here can change or go in any release, so a workflow or a `jr2.config.ts` that imports it
// is wrong, whatever compiles.
//
// It is the whole of index.ts plus the rest, so a kit file imports one specifier. The Orchestrator
// does NOT speak MCP (ADR-0013): the Harness presents the Menu to its model itself, and reaches the
// surface here through the Custodian in its pod.

export * from "./index.ts";

// The wire contract (ADR-0011): `defineEvent` is on the surface; the rest is the kit's.
export * from "@jr2/agent-protocol";
export * from "./agent.ts";
export * from "./effect.ts";
export * from "./http-effect.ts";
export * from "./sandbox-effect.ts";
export * from "./dispatch-effect.ts";
export type { EffectBinding, OpenEffect, OpenEffectPart } from "./open-effect.ts";
export { openPartsText } from "./open-effect.ts";
export * from "./effector-wire.ts";
export * from "./pick.ts";
export * from "./chart.ts";
export * from "./open-body.ts";
export * from "./charts.ts";
export * from "./parts.ts";
export * from "./size.ts";
export * from "./customize.ts";
export * from "./ambient.ts";
export * from "./config.ts";
export * from "./repo-identity.ts";
export * from "./pool.ts";
export * from "./setup.ts";
export { sentBy } from "./party.ts";
export * from "./vocabulary.ts";
export * from "./tokens.ts";
export * from "./durability.ts";
export * from "./snapshot-store.ts";
export * from "./actor.ts";
// The `gate` actor: jr2Setup pre-registers it and a state invokes it as `src: "gate"`, so no
// author writes the value (ADR-0015).
export * from "./gate.ts";
export * from "./workspace.ts";
export * from "./images.ts";
export * from "./content-hash.ts";
export * from "./assembly-tar.ts";
export * from "./assembly.ts";
export * from "./assembly-checks.ts";
export * from "./mount-digest.ts";
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
// Type-only: what a workflow event delivery looks like (the registration TABLE stays internal
// even here — ADR-0011).
export type { ChildErrorMarker, DeliveredEvent, PlacingMarker, RunMarker, TurnMarker } from "./registration.ts";
export * from "./machine-doc.ts";
export * from "./run-host.ts";
export * from "./http.ts";
export * from "./harness-client.ts";
export * from "./stub-harness.ts";
export * from "./instance.ts";
export * from "./server.ts";
export * from "./names.ts";
