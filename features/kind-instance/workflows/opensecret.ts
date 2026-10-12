// The composer's file for a packaged Machine that leaves its secret Open (ADR-0054): `notifier`'s
// Bearer is `secret(open)`, and this one line names the secret this Instance spends — the tier's
// `echo-token`, which `jr2 up` then places in the Effect's Effector (the Instance Effector) and in
// no other pod. Leave it out and `jr2 up` refuses the converge with the `{ secret }` line.

import { customize } from "@jr2/orchestrator";
import { notifier } from "./_packaged-notifier.ts";

export const machine = customize(notifier, { effects: { notify: { secret: "echo-token" } } });
