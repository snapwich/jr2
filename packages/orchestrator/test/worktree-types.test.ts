// The type claims of the Worktree surface (ADR-0075), in both directions. `pnpm typecheck` is what
// runs this file: a line under `@ts-expect-error` must be refused, and a bare line must compile.
import { setup } from "xstate";
import { z } from "zod";
import {
  agent as realAgent,
  arg,
  branchName,
  command,
  file,
  http,
  isReady,
  open as openPart,
  push,
  readyOf,
  secret,
  workspace,
  worktree,
  jr2Setup,
  type CommandOutput,
  type Workspaced,
  type WorktreeFound,
  type WorktreeOutput,
  type WorktreePath,
} from "../src/index.ts";

const agent = () => realAgent({ model: "m/x", instructions: "i" });
const url = "https://a.test/a.git";

type Door = { ticket: string; given: string };
type Body = Workspaced<Door, "app" | "docs">;
type Ctx = Body & { saved: string; savedWt: WorktreePath<"app"> };

const nameInput = z.object({ name: z.string() });
const parts = {
  cut: worktree(),
  newCut: worktree({ expect: "new" }),
  coder: agent(),
  nowhere: realAgent({ model: "m/x", workspace: "none", instructions: "i" }),
  ship: push(),
  shipApp: push({ slot: "app" }),
  pinned: push({ slot: "app", pin: true }),
  run: command(["npm", "test"]),
  lint: command(["eslint", arg("file")]),
  merge: command(["git", "merge", arg("branch")]),
  secured: command(["deploy"], { env: { TOKEN: secret("t") } }),
  openRun: command(openPart),
  send: http({
    method: "PUT",
    url: "https://x.test/up",
    input: nameInput,
    body: file<typeof nameInput>((i) => i.name),
  }),
};
const s = jr2Setup({ types: {} as { input: Body; context: Ctx }, actors: parts });
const ctx = {
  context: ({ input }: { input: Body }) => ({ ...input, saved: "", savedWt: "/work/app/a" as const }),
  on: { "agent.fault": {} },
  initial: "a" as const,
};
declare function join(...parts: string[]): string;
declare const flag: boolean;

export function correct() {
  // ---- 1. Correct, and it compiles ---------------------------------------------------------------
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "cut", input: { path: "/work/app/x", branch: "fix/one" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "cut", input: { path: "/work/app/hot", branch: "hot", from: "v3" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "cut", input: { path: "/work/docs/r", detach: "abc" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        invoke: {
          src: "cut",
          input: ({ context }) => ({ path: `${context.workspace.repos.docs}/x`, branch: context.ticket }),
        },
      },
    },
  });
  // A name with a door value after a constant start, in place: the start is what the type reads.
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        invoke: {
          src: "cut",
          input: ({ context }) => ({ path: `${context.workspace.repos.app}/t-${context.ticket}`, branch: "t" }),
        },
      },
    },
  });
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "coder", input: { prompt: "p", cwd: "/work/docs/default" } } } },
  });
  // `/work` is a legal, stated value.
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "coder", input: { prompt: "p", cwd: "/work" } } } } });
  // `workspace: "none"` is exempt.
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "nowhere", input: { prompt: "p" } } } } });
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "ship", input: { worktree: "/work/app/x" } } } } });
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "shipApp", input: { worktree: "/work/app/x" } } } } });
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "run", input: { worktree: "/work/app/x" } } } } });
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "lint", input: { file: "a.ts", worktree: "/work/app/x" } } } },
  });
  // An argv slot may be called `branch`: only the kit's own keys are refused.
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "merge", input: { branch: "task/1", worktree: "/work/app/x" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "secured", input: { worktree: "/work/app/x" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "openRun", input: { worktree: "/work/app/x", other: "y" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "send", input: { name: "r.md", worktree: "/work/app/x" } } } },
  });
  // A path in context typed for its slot; and the output path, typed with the body's slots.
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "ship", input: ({ context }) => ({ worktree: context.savedWt }) } } },
  });
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        invoke: {
          src: "cut",
          input: { path: "/work/app/x", branch: "b" },
          onDone: {
            actions: ({ event }) => {
              if (event.output.outcome !== "ready") return;
              const worktree: WorktreePath<"app" | "docs"> = event.output.path;
              void (worktree + event.output.head + event.output.found);
            },
          },
        },
      },
    },
  });
  // The narrowing pair, in a guard and an assign's reader.
  const output = {} as WorktreeOutput<"app">;
  if (isReady(output)) void output.head;
  void readyOf(output).path;
}

export function refused() {
  // ---- 2. Wrong, and refused ----------------------------------------------------------------------
  // `branch` is required unless `detach` is given.
  // @ts-expect-error a cut names a branch
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "cut", input: { path: "/work/app/x" } } } } });
  void s.createMachine({
    ...ctx,
    // @ts-expect-error typo in the slot
    states: { a: { invoke: { src: "cut", input: { path: "/work/ap/x", branch: "b" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: {
      // @ts-expect-error the handle alone is the slot's folder, not a Worktree
      a: { invoke: { src: "cut", input: ({ context }) => ({ path: context.workspace.repos.app, branch: "b" }) } },
    },
  });
  // a leading `.` or `-` and an empty name are refused by type.
  void s.createMachine({
    ...ctx,
    // @ts-expect-error leading dot
    states: { a: { invoke: { src: "cut", input: { path: "/work/app/.x", branch: "b" } } } },
  });
  void s.createMachine({
    ...ctx,
    // @ts-expect-error leading dash
    states: { a: { invoke: { src: "cut", input: { path: "/work/app/-x", branch: "b" } } } },
  });
  void s.createMachine({
    ...ctx,
    // @ts-expect-error no name
    states: { a: { invoke: { src: "cut", input: { path: "/work/app/", branch: "b" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: {
      // @ts-expect-error a Frame on the handle alone: the slot's folder is no Worktree
      a: { invoke: { src: "coder", input: ({ context }) => ({ prompt: "p", cwd: context.workspace.repos.app }) } },
    },
  });
  void s.createMachine({
    ...ctx,
    // @ts-expect-error cwd, another slot's typo
    states: { a: { invoke: { src: "coder", input: { prompt: "p", cwd: "/work/ap/x" } } } },
  });
  // @ts-expect-error push
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "ship", input: { worktree: "/work/ap/x" } } } } });
  // @ts-expect-error a push's input has no default Worktree
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "ship" } } } });
  // @ts-expect-error `docs` is a slot of the body, not of this push
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "shipApp", input: { worktree: "/work/docs/x" } } } } });
  // @ts-expect-error command
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "run", input: { worktree: "/work/ap/x" } } } } });
  void s.createMachine({
    ...ctx,
    // @ts-expect-error an Open argv's `worktree`
    states: { a: { invoke: { src: "openRun", input: { worktree: "/work/ap/x", other: "y" } } } },
  });
  void s.createMachine({
    ...ctx,
    // @ts-expect-error an http file body's Worktree
    states: { a: { invoke: { src: "send", input: { name: "r.md", worktree: "/work/ap/x" } } } },
  });
  // @ts-expect-error a credentialed command runs against one Worktree's commit: the key is required
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "secured" } } } });
  void s.createMachine({
    ...ctx,
    // @ts-expect-error a branch Worktree and a detached one at once
    states: { a: { invoke: { src: "cut", input: { path: "/work/app/x", branch: "b", detach: "abc" } } } },
  });
  void s.createMachine({
    ...ctx,
    // @ts-expect-error a detached cut takes no `from`
    states: { a: { invoke: { src: "cut", input: { path: "/work/app/x", detach: "abc", from: "main" } } } },
  });
  void s.createMachine({
    ...ctx,
    // @ts-expect-error `detach` is a commit, a string: a Chart holds only strings
    states: { a: { invoke: { src: "cut", input: { path: "/work/app/x", detach: true } } } },
  });
  // `expect` is static: an input cannot state it.
  void s.createMachine({
    ...ctx,
    // @ts-expect-error `expect` is no key of the input
    states: { a: { invoke: { src: "newCut", input: { path: "/work/app/x", branch: "b", expect: "existing" } } } },
  });
  // @ts-expect-error `expect` has two values
  void worktree({ expect: "maybe" });

  // no key of a push names a branch.
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        // @ts-expect-error the cut has `branch`, so the author gives the push `branch`
        invoke: {
          src: "ship",
          input: ({ context }) => ({ worktree: `${context.workspace.repos.app}/fix` as const, branch: "release/1.0" }),
        },
      },
    },
  });
  void s.createMachine({
    ...ctx,
    // @ts-expect-error no `to`
    states: { a: { invoke: { src: "ship", input: { worktree: "/work/app/x", to: "main" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        // @ts-expect-error a pinned push, the cut's key for the target
        invoke: {
          src: "pinned",
          input: ({ context }) => ({
            worktree: `${context.workspace.repos.app}/x` as const,
            sha: "a",
            branch: "release/1.0",
          }),
        },
      },
    },
  });
  // A key that belongs to the other kind of step, and the required keys.
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        // @ts-expect-error the Turn gets the Effect's key: the Agent would land in /work
        invoke: {
          src: "coder",
          input: ({ context }) => ({ prompt: "p", worktree: `${context.workspace.repos.app}/x` }),
        },
      },
    },
  });
  // @ts-expect-error a Turn says where it works
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "coder", input: { prompt: "p" } } } } });
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        // @ts-expect-error an argv key beside the Turn's key
        invoke: { src: "lint", input: ({ context }) => ({ file: "a.ts", cwd: `${context.workspace.repos.app}/x` }) },
      },
    },
  });
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        // @ts-expect-error a file body
        invoke: { src: "send", input: ({ context }) => ({ name: "r.md", cwd: `${context.workspace.repos.app}/x` }) },
      },
    },
  });
  const trailing = (c: Body) => `${c.workspace.repos.app}/` as const;
  void s.createMachine({
    ...ctx,
    // @ts-expect-error a helper's trailing slash gives no name
    states: { a: { invoke: { src: "ship", input: ({ context }) => ({ worktree: trailing(context) }) } } },
  });
  // @ts-expect-error a command in a Workspace with Repo Slots says which Worktree
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "run" } } } });
  // @ts-expect-error a no-arg command's mapper with the wrong key: refused by name
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "run", input: { cwd: "/work/app/fix" } } } } });
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        // @ts-expect-error the arg form, a typo beside the key
        invoke: { src: "lint", input: ({ context }) => ({ file: "a.ts", wt: `${context.workspace.repos.app}/x` }) },
      },
    },
  });
  // @ts-expect-error a file body says which Worktree
  void s.createMachine({ ...ctx, states: { a: { invoke: { src: "send", input: { name: "r.md" } } } } });
  // @ts-expect-error no `slot` on `command`
  void command(["npm", "test"], { slot: "app" });
  // @ts-expect-error no `slot` on `file`
  void file("a.txt", { slot: "app" });
  // What a Workspace does not have.
  const handles = {} as Body["workspace"];
  // @ts-expect-error no `workspace.branch`
  void handles.branch;
  // @ts-expect-error no `workspace.review`
  void handles.review;
  const appBody = setup({
    types: {} as { input: Workspaced<{ ticket: string }, "app">; context: Workspaced<{ ticket: string }, "app"> },
  }).createMachine({ context: ({ input }) => input, on: { "workspace.lost": {} } });
  // @ts-expect-error no `spec`
  void workspace(appBody, { repos: { app: url }, spec: () => ({ branch: "b" }) });
  void workspace(appBody, { repos: { app: url }, workGroup: 2000 });
  void workspace(appBody, { repos: { app: url, docs: url } });
  // @ts-expect-error the body names a slot the wrapper does not declare
  void workspace(appBody, { repos: { docs: url } });

  // No Repo Slot: no Worktree key, and a Frame is any folder of /work, `/work` itself included.
  type None = Workspaced<{ ticket: string }, never>;
  const none = jr2Setup({
    types: {} as { input: None; context: None },
    actors: { coder: agent(), cut: worktree(), ship: push(), run: command(["make"]) },
  });
  const noneCtx = { context: ({ input }: { input: None }) => input, on: { "agent.fault": {} }, initial: "a" as const };
  void none.createMachine({
    ...noneCtx,
    states: { a: { invoke: { src: "coder", input: { prompt: "p", cwd: "/work" } } } },
  });
  void none.createMachine({ ...noneCtx, states: { a: { invoke: { src: "coder", input: { prompt: "p" } } } } });
  void none.createMachine({ ...noneCtx, states: { a: { invoke: { src: "run" } } } });
  // @ts-expect-error no `worktree` under no slot
  void none.createMachine({ ...noneCtx, states: { a: { invoke: { src: "run", input: { worktree: "/work/x/y" } } } } });
  // @ts-expect-error a push under no slot
  void none.createMachine({ ...noneCtx, states: { a: { invoke: { src: "ship", input: { worktree: "/work/x/y" } } } } });
}

// ---- 3. The kit's `branchName` is a schema a pick param takes.
export const pickParam = z.object({ branch: branchName });
// ---- Surface: `found` and `outcome` are open. A new value breaks no author's code.
type LaterFound = WorktreeFound | "parked";
type LaterOutput = WorktreeOutput | { outcome: "parked"; since: string };

/** An author's router over today's output. It compiles over a later one with no change. */
function route<O extends WorktreeOutput | LaterOutput>(output: O): string {
  switch (output.outcome) {
    case "ready":
      return "go";
    case "refused":
      return "fix";
    default:
      return "stop";
  }
}
void route({} as WorktreeOutput);
void route({} as LaterOutput);
function foundWord(found: WorktreeFound): string {
  return found === "held" ? "resumed" : found === "none" ? "new" : "other";
}
void foundWord("parked" satisfies LaterFound);
export function noExhaustive(output: WorktreeOutput, found: WorktreeFound) {
  if (output.outcome === "ready" || output.outcome === "refused" || output.outcome === "unknown") return;
  // @ts-expect-error an exhaustive check cannot be written: the union has a later arm, so no author depends on three
  const none: never = output;
  void none;
  if (found === "held" || found === "local" || found === "remote" || found === "none" || found === "commit") return;
  // @ts-expect-error nor over `found`
  const nothing: never = found;
  void nothing;
}
// A bad Worktree on a command is `exited` 127, so a `.tail` read after that narrowing keeps working.
export const tailOf = (output: CommandOutput): string => (output.outcome === "exited" ? output.tail : "");

export function falseRefusals() {
  // ---- 4. FALSE REFUSALS: these paths are correct, and tsc refuses them -----------------------------
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        // @ts-expect-error a template in a `const` widens to `string`
        invoke: {
          src: "cut",
          input: ({ context }) => {
            const p = `/work/app/${context.ticket}`;
            return { path: p, branch: "b" };
          },
        },
      },
    },
  });
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        // @ts-expect-error a helper that returns `string`
        invoke: {
          src: "cut",
          input: ({ context }) => ({ path: join(context.workspace.repos.app, context.ticket), branch: "b" }),
        },
      },
    },
  });
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        // @ts-expect-error a name that is all a door value: the constant word is the rule, and a type sees it
        invoke: {
          src: "cut",
          input: ({ context }) => ({ path: `${context.workspace.repos.app}/${context.ticket}`, branch: "b" }),
        },
      },
    },
  });
  void s.createMachine({
    ...ctx,
    // @ts-expect-error a path in context as `string`
    states: { a: { invoke: { src: "ship", input: ({ context }) => ({ worktree: context.saved }) } } },
  });
  // A body generic in its slots.
  function reusable<S extends string>() {
    const r = jr2Setup({
      types: {} as { input: Workspaced<{ ticket: string }, S>; context: { ticket: string } },
      actors: { cut: worktree() },
    });
    return r.createMachine({
      context: { ticket: "t" },
      initial: "a",
      // A generic S refuses nothing: `keyof R` stays deferred, so nothing is checked here, in either direction.
      states: { a: { invoke: { src: "cut", input: { path: "/work/app/x", branch: "b" } } } },
    });
  }
  void reusable;
}

export function wrongThatCompiles() {
  // ---- 5. WRONG, and it COMPILES: for the run time (`refused`), never for tsc -------------------------
  // A second segment: the type reads the start of the name only.
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "cut", input: { path: "/work/app/a/b", branch: "b" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "cut", input: { path: "/work/app/x/../docs/y", branch: "b" } } } },
  }); // traversal below a good start
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "cut", input: { path: "/work/app/default", branch: "b" } } } },
  }); // the clone
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "cut", input: { path: "/work/app/x", branch: "-f" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "ship", input: { worktree: "/work/app/never-cut" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "ship", input: { worktree: "/work/app/default" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: { a: { invoke: { src: "coder", input: { prompt: "p", cwd: "/work/app/never-cut" } } } },
  });
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        invoke: {
          src: "cut",
          input: ({ context }) => ({ path: context.given as WorktreePath<"app">, branch: "b" }),
        },
      },
    },
  }); // a cast
  // A wrong key next to the right one, through a spread.
  void s.createMachine({
    ...ctx,
    states: {
      a: {
        invoke: {
          src: "coder",
          input: () => ({ prompt: "p", cwd: "/work" as const, ...(flag ? { cdw: "/work/ap/x" } : {}) }),
        },
      },
    },
  });

  // Plain `setup()`: no transform, so any slot passes. `workspace()`'s walk and the start refuse.
  const plain = setup({
    types: {} as { context: { ticket: string } },
    actors: { cut: worktree(), run: command(["make"]) },
  });
  void plain.createMachine({
    context: { ticket: "t" },
    initial: "a",
    states: { a: { invoke: { src: "cut", input: { path: "/work/ap/x", branch: "b" } } } },
  });
  // A child Machine whose input holds no handles.
  const child = jr2Setup({
    types: {} as { input: { path: string }; context: { path: string } },
    actors: { cut: worktree(), run: command(["make"]) },
  });
  void child.createMachine({
    context: { path: "" },
    initial: "a",
    states: { a: { invoke: { src: "run" } } },
  });
  // `repos: open`: each key reads, and any slot passes, but the key is required.
  type Open = Workspaced<{ ticket: string }, string>;
  const open = jr2Setup({ types: {} as { input: Open; context: Open }, actors: { cut: worktree(), coder: agent() } });
  const openCtx = { context: ({ input }: { input: Open }) => input, on: { "agent.fault": {} }, initial: "a" as const };
  void open.createMachine({
    ...openCtx,
    states: { a: { invoke: { src: "cut", input: { path: "/work/ap/x", branch: "b" } } } },
  });
  // @ts-expect-error the key is required under an Open map also
  void open.createMachine({ ...openCtx, states: { a: { invoke: { src: "coder", input: { prompt: "p" } } } } });
}
