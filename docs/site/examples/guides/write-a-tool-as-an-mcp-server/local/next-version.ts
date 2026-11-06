import { assign } from "xstate";
import { z } from "zod";
import { agent, defineEvent, fail, jr2Setup, workspace, type Workspaced } from "@jr2/orchestrator";

const decided = defineEvent({
  name: "decided",
  description: "Call this with the next version, after the next_version tool gave it.",
  input: z.object({ version: z.string().describe("The next version, such as 1.5.0.") }),
});

const runInput = z.object({
  version: z.string().describe("The current version, such as 1.4.2."),
  changes: z.string().describe("The changes since that version, one on each line."),
});
// `never`: the Workspace has no Repo Slot.
type BodyInput = Workspaced<z.infer<typeof runInput>, never>;
type Ctx = BodyInput & { next?: string };

const body = jr2Setup({
  types: {} as { context: Ctx; input: BodyInput; output: { version: string } },
  events: [decided],
  actors: {
    releaser: agent({
      model: "local/qwen3.6-35b-a3b",
      instructions: "You decide how large a release is: major, minor or patch. You use semantic versioning.",
      workspace: "read",
      // A stdio server takes no tools list: the Agent gets every tool of the server.
      mcp: [{ server: "semver" }],
    }),
    fail: fail(),
  },
}).createMachine({
  id: "next-version",
  context: ({ input }) => input,
  on: { "agent.fault": ".failed", "workspace.lost": ".failed" },
  initial: "deciding",
  states: {
    // The Turn frames no `cwd`, so it works in /work. The server starts there too.
    deciding: {
      invoke: {
        src: "releaser",
        input: ({ context }) => ({
          prompt: `The current version is ${context.version}. The changes are:\n${context.changes}`,
        }),
      },
      on: { decided: { target: "done", actions: assign({ next: ({ event }) => event.version }) } },
    },
    done: { type: "final" },
    // Not a final state: the run ends `failed`, with the reason.
    failed: { invoke: { src: "fail", input: { reason: "the releaser could not decide" } } },
  },
  output: ({ context }) => ({ version: context.next ?? "" }),
});

// No `repos`: the Workspace clones nothing. The Sandbox Image holds the server.
export const machine = workspace(body, { input: runInput });
