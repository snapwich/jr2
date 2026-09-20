// `jr2 init [dir] [--name <n>]` (ADR-0009): scaffold a new instance folder — the minimum `jr2 up`
// can converge and `jr2 run` can drive. v1 scope: the root marker (`jr2.config.ts`), a package.json, a
// `tsconfig.json` the instance typechecks against (an editor's language service reads it, and so
// does `jr2 up`, which refuses to converge a folder the compiler rejects — ADR-0050), a
// `.gitignore` for the runtime `.jr2/`, ONE starter workflow (`ping`) that runs end-to-end with no
// Workspace/Agent — a small "respond directly" Machine to trim down and build on — and
// `images/default/Dockerfile`, the Sandbox Image every Workspace falls back to (ADR-0037).
//
// What it does NOT scaffold is as deliberate: there is no `agents/` folder and no `images/` scan,
// because a Machine carries its own Agents and Sandbox Images (ADR-0049) and only what the CLI
// names by string is discovered from files (ADR-0050). `workflows/` is the one discovered folder.
//
// Templates mirror `templates/default/` verbatim (that folder is the model instance, ADR-0054) —
// byte-for-byte except package.json's `name`/`description`, which are per-instance.
// `test/init.test.ts` enforces that; without it the two drift silently, and since the manifest
// carries KIT_VERSION that same test is the version-bump tripwire (bump the kit, re-render the
// template). Existing files are left untouched (init is additive); created paths are reported on
// stderr.
//
// ONE template serves both checkout and installed mode (ADR-0043) — a branch there would mean the
// tested output and the shipped output diverge. So the scaffold names no package manager, and pins
// @jr2/* at the exact running KIT_VERSION: 0.x minors break, and the checkout resolves that literal
// to its own packages via `linkWorkspacePackages: true`.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { KIT_VERSION } from "@jr2/orchestrator";
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
    { path: "jr2.config.ts", content: CONFIG_TS },
    { path: ".gitignore", content: GITIGNORE },
    { path: join("workflows", "ping.ts"), content: PING_TS },
    { path: join("images", "default", "Dockerfile"), content: IMAGE_DOCKERFILE },
  ];

  activity(io, `jr2 init — scaffolding ${name} in ${dir}`);
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
  activity(io, "done — install dependencies (npm, pnpm, or bun), then `jr2 up` and `jr2 run ping`");
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

// The scaffold declares the tool every script it writes runs. `typescript` is the one that had to
// be learned the hard way, and `jr2 up` now RUNS this compiler as a converge gate (ADR-0050), so it
// is load-bearing twice over: the scaffold ships a `typecheck` script but named no compiler, so `tsc`
// resolved to whatever happened to be hoisted — in an installed instance that is `@jr2/cli`'s own
// transitive `ts-blank-space` → `typescript`, which floats across MAJORS. A scaffolded folder
// checked its kit's sources with a compiler the kit never ran, and reported ~120 errors in
// @jr2/orchestrator that the kit's own gate does not see. The range is the kit's own (ADR-0043's
// rule for `@jr2/*`, applied to the checker): the instance's PROGRAM includes the kit's `.ts`
// sources — zero-build, `exports` point at source — so the compiler is part of the contract, not
// the user's choice, and it moves when the kit moves.
function packageJson(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: { typecheck: "tsc --noEmit" },
      dependencies: { "@jr2/orchestrator": KIT_VERSION, xstate: "^5.18.0" },
      devDependencies: { "@jr2/cli": KIT_VERSION, "@types/node": "^26.0.1", typescript: "^5.6.0" },
    },
    null,
    2,
  )}\n`;
}

// The instance's compiler options live in @jr2/orchestrator, not here: a scaffolded folder resolves
// them from node_modules, so they arrive with the dependency and stay in step with the engine.
const TSCONFIG_JSON = `{
  "extends": "@jr2/orchestrator/tsconfig.instance.json",
  "include": ["**/*.ts"]
}
`;

const CONFIG_TS = `import { defineConfig } from "@jr2/orchestrator";

export default defineConfig({
  git: {
    // The fence (ADR-0051): a per-run repo url — run input, a ticket field — must match an entry here or the
    // attach refuses it, so nothing can spend this cluster's credential against an arbitrary host. \`*\` is
    // today's two implicit defaults made visible (JR2_GIT_TOKEN from .env for https, the jr2-git-ssh Secret
    // for ssh). Narrow it to your hosts (\`match: "github.com/yourorg/"\`) before anything untrusted can start
    // a run. The longest match wins; the url's scheme picks token vs sshKey.
    credentials: [{ match: "*", token: "JR2_GIT_TOKEN", sshKey: "jr2-git-ssh" }],
  },
  // Where Sandboxes land (ADR-0052): by default wherever an ordinary pod lands — not cordoned, no taint — and
  // the Repo cache agent follows the same set. No node label is needed. To admit a tainted pool or narrow to
  // a labeled one, name it in raw pod-spec shapes; \`jr2 up\` reports the Sandbox nodes it sees.
  // sandbox: { nodeSelector: { pool: "agents" }, tolerations: [{ key: "gpu", operator: "Exists" }] },
});
`;

// The scaffolded Sandbox Image (ADR-0037). Scaffolding it is the point: `images/default` is the
// middle leg of the resolution chain (a `workspace()`'s `image` option → `images/default` → the
// stock Harness), so writing it out makes the fallback a visible convention rather than magic — and
// it is the ONE path jr2 still checks by convention, so a local Machine never has to spell
// `import.meta.resolve("../images/default")` for its own instance's toolchain. It has
// ZERO jr2 knowledge by contract — no ARG, no `FROM jr2-harness`, nothing about /opt/jr2 — because jr2
// injects its runtime at POD time and never builds a stage on top of this file. It also satisfies
// the floor by construction — a glibc base with git — so the `preflight` init step that proves it
// at the pod's first provision passes without the author ever meeting it.
const IMAGE_DOCKERFILE = `# A Sandbox Image (ADR-0037): the tools your agents can reach, and the shell you get when you
# \`kubectl exec\` into a running Workspace. This file is yours — jr2 never rewrites it and reads
# nothing out of it.
#
# The build context is THIS directory (\`images/default/\`), so \`COPY\` paths are relative to it and
# nothing outside it can invalidate the image's content hash.
#
# jr2 never builds on top of this file. Your image is run byte-for-byte: jr2 mounts its own runtime
# at /opt/jr2 when the pod starts and overrides the container's COMMAND to launch the Harness from
# there, appending (never prepending) /opt/jr2/bin to PATH — so a toolchain YOU pin wins. Your
# \`USER\` and \`HOME\` are respected, dotfiles included; declare neither and the pod runs uid 1000
# with HOME=/home/jr2. Your \`ENTRYPOINT\`/\`CMD\` simply do not run — a container has one command and
# the Harness must own it. A process you need running anyway gets its own seat: the User Container
# (\`user:\` on \`workspace()\`, ADR-0005).
#
# Two things jr2 cannot vendor, both proven by \`jr2 up\` before it converges:
#   - \`git\` — the agent clones, worktrees, and commits with the git you chose;
#   - a glibc base no older than jr2's node. alpine/musl cannot run it at all.
#
# This one folder is a path convention; there is no \`images/\` scan (ADR-0049/0050). A SECOND Sandbox
# Image is a docker context that travels with the Machine that names it — put the folder beside the
# workflow module and pass \`image: import.meta.resolve("./my-image")\` to \`workspace()\`, and \`jr2 up\`
# finds it by walking the registered Machines. \`image\` also takes a registry REF (anything that is
# not a \`file:\` URL) for an image you baked and host yourself, which jr2 never builds. This instance
# builds it once a registered Machine composes a Sandbox (a \`workspace()\` with \`repos\`).

FROM node:24-slim

RUN apt-get update \\
  && apt-get install -y --no-install-recommends git ca-certificates \\
  && rm -rf /var/lib/apt/lists/*

# Your agents' toolchain goes here — compilers, CLIs, language servers, dotfiles.
`;

const GITIGNORE = `# Runtime state the orchestrator writes under the instance root (ADR-0009): the sqlite snapshot store
# and the dev server's live address. Never checked in.
.jr2/
node_modules/

# Deployment-varying values + creds this instance's jr2.config.ts reads from the environment; the
# \`jr2\` CLI loads this file automatically (ADR-0019). Never checked in.
.env
`;

const PING_TS = `// The simplest jr2 workflow: no Agent, no Workspace, no data plane at all. A Machine is free to "just
// respond to the request" with a plain actor (CONTEXT.md: a workflow need not spawn a Workspace) —
// this is that case, and the one workflow that runs end-to-end on a fresh instance before any Sandbox /
// Harness infrastructure exists. Filename \`ping.ts\` → workflow "ping".
//
// Shape: take the run input, invoke a plain \`fromPromise\` actor, fold its result into context, finish.
// \`jr2 run ping --input '{"message":"hi"}'\` → the run reaches \`done\` and \`jr2 status\` shows the reply.
//
// Module contract (ADR-0011/0015): one named export — \`machine\`. A workflow that accepts
// external events authors with \`jr2Setup({ events: [...] })\`; ping accepts none, so plain
// xstate \`setup()\` is all it needs.
//
// The next step is a Machine the kit already ships (ADR-0054). \`@jr2/machines\` exports \`task\` — one
// prompt, one Workspace, one human says done — and a Workflow is only the name an Instance
// registers a Machine under, so the whole of \`workflows/task.ts\` is:
//
//   import { customize } from "@jr2/orchestrator";
//   import { task } from "@jr2/machines";
//
//   export const machine = customize(task, {
//     repos: { target: { url: "https://github.com/you/repo.git" } },
//     agents: { coder: { model: "anthropic/claude-sonnet-4-6" } },
//   });
//
// A packaged Machine leaves the parts it cannot honestly fill OPEN: it does not know your
// repository and cannot pay for your model. \`jr2 up\` refuses an Open part nobody bound and prints
// the \`customize\` line that binds it, so forgetting one stops the converge instead of spending
// money on a model you never chose. Add \`@jr2/machines\` to this folder's dependencies when you
// write that file. \`ping\` stays Agent-free on purpose: it is the workflow that runs before any
// model provider, Harness, or Sandbox exists.

import { setup, assign, fromPromise } from "xstate";

type Input = { message?: string };
type Ctx = { message: string; reply?: string };

export const machine = setup({
  types: {} as { context: Ctx; input: Input },
  actors: {
    // A plain actor — no Harness, no Sandbox. Stands in for any non-Agent compute a workflow runs.
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
