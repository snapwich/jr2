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
export type { KubePort } from "./kube.ts";
// The held-secret PKI (ADR-0059): what `jr2 up` issues the Custodian's leaves with — exported so a
// test can issue its own fixtures the same way (the @kind tier's HTTPS model provider).
export { issueCa, issueLeaf } from "./held-pki.ts";
export type { Pem } from "./held-pki.ts";
