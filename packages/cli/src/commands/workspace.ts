// `jr2 workspace ls | shell | forward | rm` (ADR-0009, ADR-0012, ADR-0021): the Workspaces as the
// cluster holds them. Each sub-verb reads the Sandbox CRs over the kube API (`workspaces.ts`) and
// never the Orchestrator, so it works when the Orchestrator is down, and kube RBAC is the gate. They
// take the deployment's addressing (`-n`, `--context`) and not `--url`. With `-n`, no instance
// folder is needed: an ssh ProxyCommand runs in any folder.
//
//   ls [run]                     the Workspaces, and whether a run holds each
//   shell <ws> [--user] [-- cmd] a shell in the Agents' Landlock domain (ADR-0076), or in the User Container
//   forward <ws> <port> [--stdio] a local port to the pod, or one connection on stdin and stdout
//   rm <ws>                      remove a Sandbox that no run holds

import { connect as netConnect, type Socket } from "node:net";
import { constants as osConstants } from "node:os";
import { basename } from "node:path";
import { loadConfig } from "@jr2/orchestrator/internal";
import { commandNamed, parseCommand, renderCommand, usageLine } from "../command-table.ts";
import { resolveRoot } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";
import {
  age,
  kubectlWorkspaces,
  matchHandle,
  removable,
  rowOf,
  WorkspaceChangedError,
  type WorkspaceKube,
  type WorkspaceRow,
} from "../workspaces.ts";

/** How `jr2 workspace shell` starts in the Harness container: the client that asks the Harness for the
 * shell, which its spawner starts in the Agents' domain (ADR-0076). It starts as the Harness starts,
 * with the client's entry in place of the Harness's. */
export const SHELL_ENTRY: readonly string[] = [
  "/opt/jr2/bin/effector",
  "nocore",
  "--harness-env",
  "--",
  "/opt/jr2/bin/node",
  "--disable-sigusr1",
  "/opt/jr2/src/workspace-shell-main.ts",
];

/** A User Container's shell: bash where the image has it, else sh. */
export const USER_SHELL: readonly string[] = ["sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"];

/** What `forward --stdio` needs of the process: its stdin and stdout, and a TCP connect. Seams for tests. */
export type StdioPipe = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  connect(port: number): Socket;
};

const SUBS = ["ls", "shell", "forward", "rm"] as const;
type Sub = (typeof SUBS)[number];

function usage(io: Io, sub: string | undefined): number {
  activity(io, sub === undefined ? "jr2 workspace: no subcommand" : `unknown workspace subcommand: ${sub}`);
  activity(io, SUBS.map((s) => renderCommand(commandNamed(`workspace ${s}`))).join("\n\n"));
  return 2;
}

/** The deployment: `-n` as given, else the instance folder's config name, else its folder's name. */
async function deployment(
  io: Io,
  kube: WorkspaceKube,
  values: { namespace?: string | boolean; context?: string | boolean },
): Promise<{ namespace: string; context?: string }> {
  let namespace = typeof values.namespace === "string" ? values.namespace : undefined;
  if (namespace === undefined) {
    const root = resolveRoot(io.cwd);
    namespace = (await loadConfig(root))?.name ?? basename(root);
  }
  const context = typeof values.context === "string" ? values.context : await kube.context();
  if (!context) throw new Error("no kube context — `kind create cluster` (or point kubectl at one), then `jr2 up`");
  activity(io, `→ context ${context} / namespace ${namespace}`);
  return { namespace, ...(typeof values.context === "string" ? { context: values.context } : {}) };
}

/** Every Workspace of the instance, and the API server's clock. */
async function rows(
  kube: WorkspaceKube,
  where: { namespace: string; context?: string },
): Promise<{ rows: WorkspaceRow[]; serverNow?: number }> {
  let listed;
  try {
    listed = await kube.list(where);
  } catch (e) {
    throw new Error(`cannot list the Sandboxes in namespace ${where.namespace}: ${(e as Error).message}`);
  }
  return {
    rows: listed.items.map((cr) => rowOf(cr, listed.serverNow)),
    ...(listed.serverNow !== undefined ? { serverNow: listed.serverNow } : {}),
  };
}

/** The one Workspace a handle names, or a refusal that lists the candidates. */
function one(io: Io, all: readonly WorkspaceRow[], handle: string): WorkspaceRow | undefined {
  const found = matchHandle(all, handle);
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    activity(io, `no Workspace "${handle}" — \`jr2 workspace ls\` lists them`);
  } else {
    activity(io, `"${handle}" names ${found.length} Workspaces — give more of the run id:`);
    for (const r of found) activity(io, `  ${r.runId}/${r.path}  (${r.name})`);
  }
  return undefined;
}

/** The `ls` table: one row a Workspace, the columns padded. */
export function workspaceTable(all: readonly WorkspaceRow[], now: number): string {
  const LIVE: Record<WorkspaceRow["hold"], string> = {
    held: "held",
    released: "released",
    idle: "idle",
    unknown: "unknown",
  };
  const table = [
    ["WORKSPACE", "SANDBOX", "WORKFLOW", "PHASE", "AGE", "RUN"],
    ...all.map((r) => [r.handle, r.name, r.workflow, r.phase, age(r.created, now), LIVE[r.hold]]),
  ];
  const widths = table[0]!.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
  return table
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** The signals that end a forward: ssh's SIGHUP to its ProxyCommand, SIGTERM, and Ctrl-C. */
const ENDING_SIGNALS = ["SIGHUP", "SIGTERM", "SIGINT"] as const;

/**
 * On each of `ENDING_SIGNALS`, `close` runs, then this process exits as that signal would have
 * ended it (128 + its number). Without it a signal ends node by its default action, and the
 * kubectl child that holds the forward runs on. Returns the unhook.
 */
export function endOnSignals(close: () => void): () => void {
  const handlers = ENDING_SIGNALS.map((signal) => {
    const handler = () => {
      close();
      process.exit(128 + osConstants.signals[signal]);
    };
    process.once(signal, handler);
    return [signal, handler] as const;
  });
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

/** `forward --stdio`: one connection to the forwarded port, on stdin and stdout, then the forward
 * closes. */
function stdioForward(
  io: Io,
  given: StdioPipe | undefined,
  fwd: { port: number; close: () => void },
  where: string,
): Promise<number> {
  const pipe: StdioPipe = given ?? {
    stdin: process.stdin,
    stdout: process.stdout,
    connect: (p) => netConnect({ host: "127.0.0.1", port: p }),
  };
  return new Promise<number>((resolve) => {
    const socket = pipe.connect(fwd.port);
    const end = (code: number) => {
      fwd.close();
      resolve(code);
    };
    socket.on("error", (err) => {
      activity(io, `the forward to ${where} failed: ${err.message}`);
      end(1);
    });
    socket.on("close", () => end(0));
    pipe.stdin.pipe(socket);
    socket.pipe(pipe.stdout, { end: false });
  });
}

export async function workspace(
  args: string[],
  io: Io,
  opts: { pipe?: StdioPipe; onSignals?: (close: () => void) => () => void } = {},
): Promise<number> {
  const sub = args[0] as Sub | undefined;
  if (sub === undefined || !SUBS.includes(sub)) return usage(io, sub);
  const kube = io.workspaces ?? kubectlWorkspaces;

  if (sub === "ls") {
    const { values, positionals } = parseCommand("workspace ls", args);
    const where = await deployment(io, kube, values);
    const run = positionals[1];
    const listed = await rows(kube, where);
    const shown = listed.rows
      .filter((r) => run === undefined || r.runId.startsWith(run))
      .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? "") || a.handle.localeCompare(b.handle));
    if (values.json === true) result(io, { workspaces: shown });
    else io.stdout(`${workspaceTable(shown, listed.serverNow ?? Date.now())}\n`);
    return 0;
  }

  if (sub === "shell") {
    // `-- <cmd>` is the command, kept apart before the parse.
    const dash = args.indexOf("--");
    const own = dash >= 0 ? args.slice(0, dash) : args;
    const command = dash >= 0 ? args.slice(dash + 1) : [];
    const { values, positionals } = parseCommand("workspace shell", own);
    const handle = positionals[1];
    if (!handle || positionals.length > 2) {
      activity(io, usageLine("workspace shell"));
      return 2;
    }
    const where = await deployment(io, kube, values);
    const row = one(io, (await rows(kube, where)).rows, handle);
    if (!row) return 1;
    if (values.user === true) {
      const listed = await kube.list(where);
      const cr = listed.items.find((c) => c.metadata.name === row.name);
      if (!cr?.spec?.sidecars?.some((s) => s.name === "user")) {
        activity(io, `Workspace ${row.handle} has no User Container: its workspace() names no \`user\` image`);
        return 1;
      }
      const code = await kube.exec({
        ...where,
        pod: row.name,
        container: "user",
        argv: command.length ? command : USER_SHELL,
        tty: command.length === 0,
      });
      if (code === 126 || code === 127) {
        activity(
          io,
          command.length
            ? `the User Container could not run ${command[0]} (exit ${code})`
            : "the User Container's image has no sh: give it a shell, or name a command after --",
        );
      }
      return code;
    }
    return await kube.exec({
      ...where,
      pod: row.name,
      container: "harness",
      argv: command.length ? [...SHELL_ENTRY, "--", ...command] : SHELL_ENTRY,
      tty: command.length === 0,
    });
  }

  if (sub === "forward") {
    const { values, positionals } = parseCommand("workspace forward", args);
    const [, handle, portText] = positionals;
    const port = Number(portText);
    if (!handle || !Number.isInteger(port) || port < 1 || port > 65535 || positionals.length > 3) {
      activity(io, usageLine("workspace forward"));
      return 2;
    }
    const where = await deployment(io, kube, values);
    const row = one(io, (await rows(kube, where)).rows, handle);
    if (!row) return 1;
    const fwd = await kube.forward({ ...where, pod: row.name, port });
    // The forward ends with this verb. ssh ends a ProxyCommand with SIGHUP, a supervisor with
    // SIGTERM, a person with Ctrl-C: each closes the forward first, then exits as the signal would.
    const unhook = (opts.onSignals ?? endOnSignals)(() => fwd.close());
    try {
      if (values.stdio !== true) {
        io.stdout(`127.0.0.1:${fwd.port}\n`);
        activity(io, `forwarding 127.0.0.1:${fwd.port} → ${row.handle}:${port} — Ctrl-C ends it`);
        return await fwd.closed;
      }
      return await stdioForward(io, opts.pipe, fwd, `${row.handle}:${port}`);
    } finally {
      unhook();
    }
  }

  const { values, positionals } = parseCommand("workspace rm", args);
  const handle = positionals[1];
  if (!handle || positionals.length > 2) {
    activity(io, usageLine("workspace rm"));
    return 2;
  }
  const where = await deployment(io, kube, values);
  const row = one(io, (await rows(kube, where)).rows, handle);
  if (!row) return 1;
  if (!removable(row)) {
    const why =
      row.hold === "held" ? `run ${row.runId} holds it` : `it has no hold mark, so it may be held by run ${row.runId}`;
    activity(
      io,
      `Workspace ${row.handle} (${row.name}) is not removed: ${why} — cancel the run first ` +
        `(\`jr2 send ${row.runId} --event CANCEL\`)`,
    );
    return 1;
  }
  try {
    // Only the version that was read: a run that placed the same name again since then holds it.
    await kube.delete({
      ...where,
      name: row.name,
      ...(row.resourceVersion !== undefined ? { resourceVersion: row.resourceVersion } : {}),
    });
  } catch (err) {
    if (!(err instanceof WorkspaceChangedError)) throw err;
    activity(
      io,
      `Workspace ${row.handle} (${row.name}) is not removed: it changed after it was read, ` +
        "so a run may hold it again — run `jr2 workspace ls` and try again",
    );
    return 1;
  }
  activity(io, `removed Workspace ${row.handle} (${row.name})`);
  return 0;
}
