// An e2e fixture for the Console's start-run form (ADR-0033): the one fixture that DECLARES its
// run input — `createMachine({ input: z.object(...) })` — so `GET /workflows/intake` serves a real
// JSON Schema and the Console renders a typed field ("subject *", a text input), never the
// no-schema raw-JSON textarea. Like `loop`, it parks in `working` indefinitely, so the run the
// browser starts stays visible in the rail as a live run. Filename `intake.ts` → workflow "intake".

import { z } from "zod";
import { j2Setup } from "@j2/orchestrator";

type Input = { subject: string };
type Ctx = { subject: string };

export const machine = j2Setup({
  types: {} as { context: Ctx; input: Input },
  events: [],
}).createMachine({
  id: "intake",
  input: z.object({ subject: z.string() }),
  context: ({ input }) => ({ subject: input.subject }),
  initial: "working",
  states: { working: {} },
});
