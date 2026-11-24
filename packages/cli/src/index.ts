// Library entry for `@jr2/cli`: the dispatch + the HTTP client surface, for programmatic callers and
// tests. The `jr2` binary itself is `bin/jr2.js`.

export { main } from "./cli.ts";
export { JR2Client } from "./client.ts";
export type { RunStatus, RunFeedEvent, RunEvent, FetchLike } from "./client.ts";
export type { Io } from "./output.ts";
export { resolveRoot, resolveTarget } from "./instance.ts";
export { assertKitVersion, checkKitVersion, resolvePackage, CLI_VERSION } from "./kit-version.ts";
export type { Target, TargetOptions } from "./instance.ts";
export { kubectlKube } from "./kube.ts";
// The rules of the Fence's admission policies in TypeScript, which the audit of `jr2 up` uses
// (ADR-0084): exported so the @kind tier judges each row of its matrix with them and with the API
// server, and the two cannot drift apart.
export { attachmentGuardRefusal, podGuardRefusal } from "./fence-guard.ts";
export type { GuardNamespace } from "./fence-guard.ts";
export type { KubePort } from "./kube.ts";
// The held-secret PKI (ADR-0059): what `jr2 up` issues the Custodian's leaves with — exported so a
// test can issue its own fixtures the same way (the @kind tier's HTTPS model provider).
export { issueCa, issueLeaf } from "@jr2/orchestrator/internal";
export type { Pem } from "@jr2/orchestrator/internal";
// The command table (ADR-0072): every verb as data, and the renderers `--help` prints with — what the
// docs' CLI Reference is generated from, so the help and the site cannot disagree.
export {
  COMMANDS,
  GLOBAL,
  GLOBAL_OPTIONS,
  HELP_FLAG,
  SECTIONS,
  EXIT_CODES,
  nameOf,
  synopsis,
  renderHelp,
  renderCommand,
} from "./command-table.ts";
export type {
  Command,
  CommandName,
  Flag,
  Arg,
  EnvVar,
  Form,
  Output,
  OutputKind,
  GlobalOption,
  Section,
} from "./command-table.ts";
