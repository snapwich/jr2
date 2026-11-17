// A `fetch` over a Unix socket (ADR-0076): the control requests of a Harness pod that has a
// Custodian container, to that container's control socket under `/run/jr2`, not to a loopback
// port. The domain cannot make a socket there, so it cannot take the control listener's place
// while the Custodian restarts, and never receives the control Stand-in. `control-fetch.ts` holds
// the client; a pod on the Fence reaches the Custodian over HTTPS instead.

import { controlFetch } from "./control-fetch.ts";

/** A `fetch` whose every request goes to the socket at `socketPath`; the URL gives the path. */
export function unixFetch(socketPath: string): typeof globalThis.fetch {
  return controlFetch({ socketPath });
}
