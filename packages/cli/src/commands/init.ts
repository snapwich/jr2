// `j2 init [dir] [--name <n>]` (ADR-0009): scaffold a new instance folder — the minimum `j2 up`
// can converge and `j2 run` can drive. v1 scope: the root marker (`j2.config.ts`), a package.json, a
// `tsconfig.json` so the instance typechecks (and an editor's language service understands it), a
// `.gitignore` for the runtime `.j2/`, ONE starter workflow (`ping`) that runs end-to-end with no
// Workspace/Agent — a small "respond directly" Machine to trim down and build on — and
// `images/default/Dockerfile`, the Sandbox Image every Workspace falls back to (ADR-0037).
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
    { path: join("images", "default", "Dockerfile"), content: IMAGE_DOCKERFILE },
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
  activity(io, "done — `pnpm install && j2 up` to deploy it, then `j2 run ping`");
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
// Workspaces (ADR-0012) are opt-in by adding repos — a Workspace needs them (ADR-0031): the orchestrator
// then reconciles \`repos/\` at boot and drives Sandbox CRs via kubectl in its own namespace (ADR-0019).

import { defineConfig } from "@j2/orchestrator";

export default defineConfig({
  repos: [],
});
`;

// The scaffolded Sandbox Image (ADR-0037). Scaffolding it is the point: `images/default` is the
// middle leg of the resolution chain (a `workspace()` spec's `image` → `images/default` → the stock
// Harness), so writing it out makes the fallback a visible convention rather than magic. It has
// ZERO j2 knowledge by contract — no ARG, no `FROM j2-harness`, no USER/CMD/WORKDIR — because the
// wrap owns all of that. It also satisfies the preflight by construction: a glibc base with git.
const IMAGE_DOCKERFILE = `# A Sandbox Image (ADR-0037): the tools your agents can reach, and the shell you get when you
# \`kubectl exec\` into a running Workspace. This file is yours — j2 never rewrites it and reads
# nothing out of it.
#
# The build context is THIS directory (\`images/default/\`), so \`COPY\` paths are relative to it and
# nothing outside it can invalidate the image's content hash.
#
# j2 injects its own runtime at /opt/j2 in a second, kit-owned stage on top of whatever this
# Dockerfile produces — node, ripgrep, the Harness, a writable /home/j2, and PATH appended (never
# prepended, so a toolchain YOU pin wins). So: no USER, no CMD, no WORKDIR, no j2 base image here.
#
# Two things j2 cannot vendor, both proven by \`j2 up\` before it converges:
#   - \`git\` — the agent clones, worktrees, and commits with the git you chose;
#   - a glibc base no older than j2's node. alpine/musl cannot run it at all.
#
# The name is the directory name. Add \`images/<other>/Dockerfile\` for a second Sandbox Image and name
# it from a workflow's \`workspace()\` spec. This instance has \`repos: []\`, so \`j2 up\` builds
# nothing here until it has repos to work on.

FROM node:24-slim

RUN apt-get update \\
  && apt-get install -y --no-install-recommends git ca-certificates \\
  && rm -rf /var/lib/apt/lists/*

# Your agents' toolchain goes here — compilers, CLIs, language servers, dotfiles.
`;

const GITIGNORE = `# Runtime state the orchestrator writes under the instance root (ADR-0009): the sqlite snapshot store
# and the dev server's live address. Never checked in.
.j2/
node_modules/

# Deployment-varying values + creds this instance's j2.config.ts reads from the environment; the
# \`j2\` CLI loads this file automatically (ADR-0019). Never checked in.
.env
`;

const PING_TS = `// The simplest j2 workflow: no Agent, no Workspace, no data plane at all. A Machine is free to "just
// respond to the request" with a plain actor (CONTEXT.md: a workflow need not spawn a Workspace) —
// this is that case, and the one workflow that runs end-to-end on a fresh instance before any Sandbox /
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
