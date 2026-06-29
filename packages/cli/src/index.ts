// Library entry for `@j2/cli`: the dispatch + the HTTP client surface, for programmatic callers and
// tests. The `j2` binary itself is `bin/j2.ts`.

export { main } from "./cli.ts";
export { J2Client } from "./client.ts";
export type { RunStatus, RunFeedEvent, RunEvent, FetchLike } from "./client.ts";
export type { Io } from "./output.ts";
export { resolveRoot, readDevJson, resolveBaseUrl } from "./instance.ts";
export type { DevInfo } from "./instance.ts";
