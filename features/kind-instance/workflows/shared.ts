// The kind tier's Workspace with NO Repo Slot (ADR-0051): a Sandbox that clones nothing, whose
// steps share `/work`, as the steps of one GitHub Actions job share its folder. Each step leaves a
// file there for the next, and only a shared folder makes the last one whole:
//
//   preparing  a command with no Effect secret writes data.txt and prints its cwd — `/work`, named
//              by the start, never the Sandbox Image's own WORKDIR (ADR-0067)
//   writing    the writer's Turn frames no `cwd`, so its `write` Working tool lands notes.md in
//              `/work` (the scenario releases the scripted model's call)
//   editing    the editor, a second Agent, joins data.txt and notes.md into report.txt with `bash`
//   uploading  a file-body `http` sends report.txt from the Sandbox Effector, its path relative to
//              `/work` — the job's way out, since `/work` goes with the Sandbox
//
// The body's output carries the command's and the upload's answers, and the wrapper forwards it.

import { z } from "zod";
import { assign } from "xstate";
import {
  agent,
  bearer,
  command,
  defineEvent,
  fail,
  file,
  http,
  jr2Setup,
  secret,
  workspace,
  type HostInjectedInput,
  type Workspaced,
} from "@jr2/orchestrator";
import { coder } from "./_agents.ts";

const ECHO = "http://echo.jr2-e2e-seed.svc";

const door = z.object({ mode: z.enum(["job"]), marker: z.string().regex(/^m-[a-z0-9]+$/) });
// `never`: no Repo Slot, so the handles are `{ repos: {} }`, with no branch.
type BodyInput = Workspaced<HostInjectedInput & z.infer<typeof door>, never>;
type BodyContext = BodyInput & { prepared?: unknown; said?: string[]; upload?: unknown };

const drafted = defineEvent({ name: "drafted", input: z.object({ summary: z.string() }) });
const edited = defineEvent({ name: "edited", input: z.object({ summary: z.string() }) });
const sendInput = z.object({ marker: z.string() });

const body = jr2Setup({
  types: {} as { context: BodyContext; input: BodyInput; output: unknown },
  events: [drafted, edited],
  actors: {
    prepare: command(["sh", "-c", "printf 'from the command\\n' > data.txt && pwd"]),
    // Two Agents, one definition: the slot key is each one's name on the Harness wire.
    writer: agent(coder),
    editor: agent(coder),
    send: http({
      method: "PUT",
      url: `${ECHO}/shared`,
      auth: bearer(secret("echo-token")),
      input: sendInput,
      body: file<typeof sendInput>("report.txt", { segments: ({ marker }) => [marker], contentType: "text/plain" }),
    }),
    fail: fail(),
  },
}).createMachine({
  id: "shared",
  context: ({ input }) => input,
  initial: "preparing",
  on: { "workspace.lost": ".lost", "agent.fault": ".faulted" },
  states: {
    preparing: {
      invoke: {
        src: "prepare",
        onDone: { target: "writing", actions: assign({ prepared: ({ event }) => event.output }) },
      },
    },
    // Each pick's summary is kept: what the Agents said, beside what they did.
    writing: {
      invoke: { src: "writer", input: { prompt: "write notes.md" } },
      on: { drafted: { target: "editing", actions: assign({ said: ({ event }) => [event.summary] }) } },
    },
    editing: {
      invoke: { src: "editor", input: { prompt: "join data.txt and notes.md into report.txt" } },
      on: {
        edited: {
          target: "uploading",
          actions: assign({ said: ({ context, event }) => [...(context.said ?? []), event.summary] }),
        },
      },
    },
    uploading: {
      invoke: {
        src: "send",
        input: ({ context }) => ({ marker: context.marker }),
        onDone: { target: "settled", actions: assign({ upload: ({ event }) => event.output }) },
      },
    },
    settled: { type: "final" },
    lost: { invoke: { src: "fail", input: { reason: "the Sandbox was lost" } } },
    faulted: { invoke: { src: "fail", input: { reason: "an Agent's Turn could not go on" } } },
  },
  output: ({ context }: { context: BodyContext }) => ({
    prepared: context.prepared,
    said: context.said,
    upload: context.upload,
  }),
});

// No `repos`: the Workspace clones nothing, and its steps share `/work`.
export const machine = workspace(body, { input: door });
