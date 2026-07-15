// `j2 init [dir] [--name <n>]` (ADR-0009): scaffold a new instance folder — the minimum a `j2 dev`
// can boot and `j2 run` can drive. v1 scope: the root marker (`j2.config.ts`), a package.json, a
// `tsconfig.json` so the instance typechecks (and an editor's language service understands it), a
// `.gitignore` for the runtime `.j2/`, and ONE starter workflow (`ping`) that runs end-to-end with no
// Workspace/Agent — a small "respond directly" Machine to trim down and build on.
//
// Templates mirror `examples/starter/` verbatim (that folder is the model instance) — byte-for-byte
// except package.json's `name`/`description`, which are per-instance. `test/init.test.ts` enforces
// that; without it the two drift silently. Existing files are left untouched (init is additive);
// created paths are reported on stderr.

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
    { path: "tsconfig.json", content: TSCONFIG_JSON },
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
      scripts: { typecheck: "tsc --noEmit" },
      dependencies: { "@j2/orchestrator": "workspace:*", xstate: "^5.18.0" },
      devDependencies: { "@j2/cli": "workspace:*", "@types/node": "^26.0.1" },
    },
    null,
    2,
  )}\n`;
}

// The instance's compiler options live in @j2/orchestrator, not here: a scaffolded folder resolves
// them from node_modules, so they arrive with the dependency and stay in step with the engine.
const TSCONFIG_JSON = `{
  "extends": "@j2/orchestrator/tsconfig.instance.json",
  "include": ["**/*.ts"]
}
`;

const CONFIG_TS = `// Instance config (ADR-0009). Its presence at the folder root is what marks this directory as a j2
// instance — the \`j2\` CLI walks up from cwd to find it. \`defineConfig\` is an identity passthrough
// that pins the shape to \`J2Config\` for authoring-time inference.
//
// \`repos\` is the one irreducible entry: the orchestrator materializes a read-only \`default/\` checkout
// per repo as the source-of-truth volume every Workspace worktrees against. This starter has none yet
// (its workflows don't touch a Workspace), so the list is empty.
//
// Workspaces (ADR-0012) are opt-in by adding \`sandbox: { image: "<harness image>" }\`: \`j2 dev\` then
// reconciles \`repos/\` at boot and drives Sandbox CRs via kubectl (cluster from \`j2 cluster up\`).

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

const PING_TS = `// The simplest j2 workflow: no Agent, no Workspace, no data plane at all. A Machine is free to "just
// respond to the request" with a plain actor (CONTEXT.md: a workflow need not spawn a Workspace) —
// this is that case, and the one workflow that runs end-to-end under \`j2 dev\` before any Sandbox /
// Harness infrastructure exists. Filename \`ping.ts\` → workflow "ping".
//
// Shape: take the run input, invoke a plain \`fromPromise\` actor, fold its result into context, finish.
// \`j2 run ping --input '{"message":"hi"}'\` → the run reaches \`done\` and \`j2 status\` shows the reply.
//
// Module contract (ADR-0011/0015): one named export — \`machine\`. A workflow that accepts
// external events authors with \`j2Setup({ events: [...] })\`; ping accepts none, so plain
// xstate \`setup()\` is all it needs.

import { setup, assign, fromPromise } from "xstate";

type Input = { message?: string };
type Ctx = { message: string; reply?: string };

export const machine = setup({
  types: {} as { context: Ctx; input: Input },
  actors: {
    // A plain actor — no flue client, no Sandbox. Stands in for any non-Agent compute a workflow runs.
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
