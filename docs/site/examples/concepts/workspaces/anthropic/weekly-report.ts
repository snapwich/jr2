import { z } from "zod";
import {
  agent,
  arg,
  bearer,
  command,
  defineEvent,
  fail,
  file,
  http,
  jr2Setup,
  secret,
  workspace,
  type CommandOutput,
  type Workspaced,
} from "@jr2/orchestrator";

const drafted = defineEvent({
  name: "drafted",
  description: "Call this when report.md is written.",
  input: z.object({}),
});
const edited = defineEvent({
  name: "edited",
  description: "Call this when report.md is ready to send.",
  input: z.object({}),
});

const runInput = z.object({ week: z.string() });
// `never`: the Workspace has no Repo Slot, so the handles hold no path and no branch.
type BodyInput = Workspaced<z.infer<typeof runInput>, never>;

const passed = (output: CommandOutput): boolean => output.outcome === "exited" && output.code === 0;

const body = jr2Setup({
  types: {} as { context: BodyInput; input: BodyInput },
  events: [drafted, edited],
  actors: {
    // A command with no Effect secret runs in /work, beside the Agents.
    fetch: command(["curl", "-fsSLo", "sales.csv", arg("url")]),
    writer: agent({
      model: "anthropic/claude-haiku-5-5",
      instructions: "You write short, clear reports from data.",
    }),
    editor: agent({
      model: "anthropic/claude-haiku-5-5",
      instructions: "You edit reports. You make them shorter and correct each number.",
    }),
    // The Sandbox Effector reads the file from /work and sends it. The Agents never read the secret.
    upload: http({
      method: "PUT",
      url: "https://files.example.com/reports",
      auth: bearer(secret("files")),
      input: runInput,
      body: file<typeof runInput>("report.md", {
        segments: ({ week }) => [`${week}.md`],
        contentType: "text/markdown",
      }),
    }),
    fail: fail(),
  },
}).createMachine({
  id: "weekly-report",
  context: ({ input }) => input,
  // /work goes with the Sandbox. Nothing is sent yet, so this body fails the run.
  on: { "agent.fault": ".failed", "workspace.lost": ".lost" },
  initial: "fetching",
  states: {
    fetching: {
      invoke: {
        src: "fetch",
        input: ({ context }) => ({ url: `https://data.example.com/sales/${context.week}.csv` }),
        onDone: [{ guard: ({ event }) => passed(event.output), target: "writing" }, { target: "failed" }],
      },
    },
    // Each Agent's Turn frames no `cwd`, so it works in /work, where sales.csv is.
    writing: {
      invoke: { src: "writer", input: { prompt: "Write report.md: the sales of the week in sales.csv." } },
      on: { drafted: "editing" },
    },
    editing: {
      invoke: { src: "editor", input: { prompt: "Edit report.md. Check each number against sales.csv." } },
      on: { edited: "uploading" },
    },
    // Send the report before the body ends: jr2 deletes /work with the Sandbox.
    uploading: {
      invoke: {
        src: "upload",
        input: ({ context }) => ({ week: context.week }),
        onDone: [
          { guard: ({ event }) => event.output.outcome === "response" && event.output.status < 300, target: "done" },
          { target: "failed" },
        ],
      },
    },
    done: { type: "final" },
    // Not final states: a final state means `done`. Each one fails the run, and the run ends `failed`.
    failed: { invoke: { src: "fail", input: { reason: "a step of the report did not succeed" } } },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
  },
});

// No `repos`: the Workspace clones nothing, and its steps share /work.
export const machine = workspace(body, { input: runInput });
