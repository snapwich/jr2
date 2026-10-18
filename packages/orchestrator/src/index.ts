// @jr2/orchestrator — the Authoring surface (GLOSSARY.md): the names an author writes in a
// workflow module or in `jr2.config.ts`, and no other name. A name is here when an author writes
// it; a name an author only meets through inference (a jr2Setup event union, a gate's input, a
// pick's Frame) stays internal. A workflow authors against ONE package — `defineEvent`,
// `jr2Setup`, `workspace`, … all import from "@jr2/orchestrator" (ADR-0015) — and an Assistant that
// reads this file reads the whole of what it may write.
//
// Named re-exports only, never `export *`: each name below is a decision, and
// test/authoring-surface.test.ts pins the list. The kit's own packages (the CLI, the e2e suite,
// the Harness's tests) import "@jr2/orchestrator/internal", which holds everything here and the
// runtime besides.

// Machine and events: the setup a workflow writes its Machine with, the events its parties send,
// and the guard that makes a writing decline other senders (ADR-0011, ADR-0015).
export { defineEvent } from "@jr2/agent-protocol";
export { jr2Setup } from "./setup.ts";
export { sentBy } from "./party.ts";
export type { HostInjectedInput } from "./vocabulary.ts";

// Agents: an Agent slot and the definition it carries (ADR-0028, ADR-0049).
export { agent } from "./harness-client.ts";
export type { AgentDefinition, ThinkingLevel } from "./agent.ts";

// Workspaces and Repos: a Sandbox and the Repo Slots it binds (ADR-0012, ADR-0051).
export { workspace } from "./workspace.ts";
export type { Workspaced } from "./workspace.ts";
export type { Binding, RepoSlot } from "./parts.ts";

// Effects: work a Machine does outside itself, as an actor slot (ADR-0067, ADR-0068, ADR-0071),
// and what an author writes between a pick and that work.
export { arg } from "./effect.ts";
export type { CommandOutput } from "./effect.ts";
export { command } from "./harness-client.ts";
export { basic, bearer, file, http, secret, text } from "./http-effect.ts";
export type { HttpOutput } from "./effector-wire.ts";
export { push } from "./sandbox-effect.ts";
export type { PushOutput } from "./sandbox-effect.ts";
export { dispatch } from "./dispatch-effect.ts";
export type { DispatchOutput } from "./effect.ts";
export { answer, fromPick, paramsOf } from "./pick.ts";

// Composition: a part left Open, a Machine's parts retuned, a Pool over a Source (ADR-0017,
// ADR-0049, ADR-0054, ADR-0060).
export { open } from "./parts.ts";
export { customize } from "./customize.ts";
export type { Customize } from "./customize.ts";
export type { EffectBinding } from "./open-effect.ts";
export type { Size, UserContainer } from "./size.ts";
export { pool, source } from "./pool.ts";

// Charts: the Open body a Chart wrapper places in `actors`, and the grammar a planner's pick
// declares, whole or narrowed to one wrapper (ADR-0070).
export { openBody } from "./open-body.ts";
export type { OpenBodyDeclaration, OpenBodyOutput } from "./open-body.ts";
export { chartSchema, chartSchemaFor } from "./chart.ts";

// Config: `jr2.config.ts`, the deployment facts a Machine cannot carry (ADR-0050).
export { defineConfig } from "./config.ts";
export type { JR2Config } from "./config.ts";
