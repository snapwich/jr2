// The kind tier's THIRD-SEAT workflow (ADR-0005/0053): `sandboxed`'s body and Binding, plus a User
// Container — the optional seat a `workspace()` names statically, where a human's session runs
// beside the Agent's on the same worktree.
//
// It is its OWN workflow rather than one more line on `sandboxed` so that the seat is composed
// where it is the subject and nowhere else: every other kind scenario keeps the two-container pod
// it has always run, and a fault in the seat names itself instead of failing the whole tier.
//
// What it carries the tier is ADR-0053's last consequence: the fetch url lives in the SHARED
// `default/.git/config`, so a seat that holds the checkouts and not the program has checkouts
// whose `git fetch` dies. `/opt/j2` therefore rides in read-only beside `/repos`, and the human
// gets the same fetch as the Agent with no credential of their own.

import { workspace } from "@j2/orchestrator";
import { body } from "./_body.ts";

export const machine = workspace(body, {
  repos: { app: { url: "http://seed.j2-e2e-seed.svc/app.git", ref: "main" } },
  spec: () => ({ branch: "feat-e2e" }),
  // A `file:` URL to a docker context this module ships — `j2 up` builds it like any other
  // (ADR-0037/0049), and the deployed Orchestrator recomputes the same content digest to find the
  // ref, which is why `images/` must travel in the instance bundle (see package.json's `files`).
  user: import.meta.resolve("../images/user"),
});
