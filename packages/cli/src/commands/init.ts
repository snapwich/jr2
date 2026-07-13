// `j2 init [dir] [--name <n>]` (ADR-0009): scaffold a new instance folder — the minimum a `j2 dev`
// can boot and `j2 run` can drive. v1 scope: the root marker (`j2.config.ts`), a package.json, a
// `.gitignore` for the runtime `.j2/`, and ONE starter workflow (`ping`) that runs end-to-end with no
// Workspace/Agent — a small "respond directly" Machine to trim down and build on.
//
// Templates mirror `examples/starter/` verbatim (that folder is the model instance). Existing files are
// left untouched (init is additive); created paths are reported on stderr.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { activity, type Io } from "../output.ts";

export async function init(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { name: { type: "string" } },
  });

  const dir = positionals[0] ? resolve(io.cwd, String(positionals[0])) : io.cwd;
  const name = (values.name as string | undefined) ?? basename(dir);

  const files: Array<{ path: string; content: string }> = [
    { path: "package.json", content: packageJson(name) },
    { path: "j2.config.ts", content: CONFIG_TS },
    { path: ".gitignore", content: GITIGNORE },
    { path: join("workflows", "ping.ts"), content: PING_TS },
  ];

  activity(io, `j2 init — scaffolding ${name} in ${dir}`);
  for (const file of files) {
    const full = join(dir, file.path);
    if (await exists(full)) {
      activity(io, `  skip   ${file.path} (exists)`);
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, file.content);
    activity(io, `  create ${file.path}`);
  }
  activity(io, "done — `j2 dev` to boot it, then `j2 run ping`");
  return 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function packageJson(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: { "@j2/orchestrator": "workspace:*", xstate: "^5.18.0" },
      devDependencies: { "@j2/cli": "workspace:*" },
    },
    null,
    2,
  )}\n`;
}

const CONFIG_TS = `// Instance config (ADR-0009): its presence marks this folder as a j2 instance — the \`j2\` CLI walks up
// from cwd to find it. \`repos\` lists the source repos the orchestrator materializes a read-only
// \`default/\` checkout of per Workspace; empty until a workflow needs a Workspace. Workspaces are
// opt-in via \`sandbox: { image: "<harness image>" }\` (+ a cluster from \`j2 cluster up\`).

import { defineConfig } from "@j2/orchestrator";

export default defineConfig({
  repos: [],
});
`;

const GITIGNORE = `# Runtime state the orchestrator writes under the instance root (ADR-0009): the sqlite snapshot store
# and the dev server's live address. Never checked in.
.j2/
node_modules/
`;

const PING_TS = `// The simplest j2 workflow: no Agent, no Workspace — a Machine that "just responds to the request"
// with a plain actor. Runs end-to-end under \`j2 dev\` before any Sandbox/Harness exists. Filename
// \`ping.ts\` → workflow "ping". Trim this down or expand it for your use case.
//
// Module contract (ADR-0011): named exports — \`machine\` plus an \`events\` manifest declaring the
// events external callers may deliver to this workflow (defineEvent). Ping accepts none.

import { setup, assign, fromPromise } from "xstate";

type Input = { message?: string };
type Ctx = { message: string; reply?: string };

export const events = [];

export const machine = setup({
  types: {} as { context: Ctx; input: Input },
  actors: {
    respond: fromPromise<string, { message: string }>(async ({ input }) => \`pong: \${input.message}\`),
  },
}).createMachine({
  id: "ping",
  context: ({ input }) => ({ message: input.message ?? "ping" }),
  initial: "responding",
  states: {
    responding: {
      invoke: {
        src: "respond",
        input: ({ context }) => ({ message: context.message }),
        onDone: { target: "done", actions: assign({ reply: ({ event }) => event.output }) },
      },
    },
    done: { type: "final" },
  },
});
`;
