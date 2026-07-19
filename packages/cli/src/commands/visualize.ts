// `j2 visualize <workflow> [--no-open] [-n ns] [--context c] [--url <u>] [--port <p>]`: open the
// workflow's Machine in the browser. The page itself is served by the orchestrator (`/viz/:name` —
// every orchestrator carries its own visualizer), so this verb's job is only to find one to attach
// to, or boot one:
//
//   - an explicit address (`--url` / `J2_URL`) → attach, print the page URL, open the browser,
//     exit — the server's lifecycle is not ours;
//   - otherwise → the DEPLOYED orchestrator, resolved exactly like every run-verb (ADR-0019:
//     current kube context + instance namespace). The page rides the port-forward, so the verb
//     serves the tunnel until Ctrl-C — exiting would kill the page mid-look. This is also where
//     live runs are: an ephemeral instance can only ever show an empty diagram.
//   - not deployed → fall back to an ephemeral in-process instance, private to the visualizer
//     (the machine structure is in this folder's code; no cluster needed to look at a diagram),
//     and say so — the fallback shows NO live runs by construction.

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { opaqueStates, startInstance } from "@j2/orchestrator";
import { J2Client } from "../client.ts";
import { resolveRoot, resolveTarget, TARGET_ARGS, targetOptions, type Target } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";

const USAGE = "usage: j2 visualize <workflow> [--no-open] [-n ns] [--context c] [--url <u>] [--port <p>]";

/** Fire-and-forget the platform opener; failure is a notice, never an exit code. */
function openInBrowser(url: string, io: Io): void {
  const [cmd, cmdArgs] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" });
    child.on("error", () => activity(io, `could not open a browser — visit ${url}`));
    child.unref();
  } catch {
    activity(io, `could not open a browser — visit ${url}`);
  }
}

const vizUrl = (baseUrl: string, workflow: string): string =>
  `${baseUrl.replace(/\/+$/, "")}/viz/${encodeURIComponent(workflow)}`;

/**
 * Say so when the diagram cannot be trusted to be complete. A state that runs an `enqueueActions`
 * closure may spawn children the doc has no way to see, so the subgraph beneath them is simply
 * absent — the page cannot tell you that, because it never knew. Without this the failure is
 * silent, which is how `examples/coding` once lost its whole feature pipeline from the picture.
 *
 * Advisory only: it never changes the exit code, and a doc it cannot fetch is not worth failing a
 * visualize over.
 */
async function warnOpaque(baseUrl: string, workflow: string, io: Io, token?: string): Promise<void> {
  try {
    const states = opaqueStates(await new J2Client(baseUrl, io.fetch, token).machine(workflow));
    if (!states.length) return;
    activity(
      io,
      `notice: ${states.map((s) => `\`${s}\``).join(", ")} ${states.length > 1 ? "run" : "runs"} an ` +
        "enqueueActions closure — any child machine spawned inside one is NOT shown in this diagram " +
        "(keep `spawnChild` a top-level action to see it).",
    );
  } catch {
    // The doc is a nicety here; the page is the product. Never fail a visualize over the warning.
  }
}

/** Block until SIGINT/SIGTERM, then run `close` and exit 0. */
async function serveUntilSignal(io: Io, close: () => Promise<void> | void): Promise<never> {
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    activity(io, "stopping…");
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  return new Promise<never>(() => {}); // serve until a signal triggers shutdown
}

export async function visualize(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { ...TARGET_ARGS, "no-open": { type: "boolean" }, port: { type: "string" } },
  });
  const workflow = positionals[0];
  if (!workflow) {
    activity(io, USAGE);
    return 2;
  }

  /** Attach to a serving orchestrator: validate the workflow, print, open, done. */
  const attach = async (baseUrl: string, token?: string): Promise<number> => {
    const workflows = await new J2Client(baseUrl, io.fetch, token).workflows();
    if (!workflows.includes(workflow)) {
      activity(io, `no workflow "${workflow}" — available: ${workflows.join(", ") || "(none)"}`);
      return 1;
    }
    const url = vizUrl(baseUrl, workflow);
    activity(io, `visualizing "${workflow}" — ${url}`);
    await warnOpaque(baseUrl, workflow, io, token);
    result(io, { url, workflow });
    if (!values["no-open"]) openInBrowser(url, io);
    return 0;
  };

  // An explicit address is trusted: if it doesn't answer, that's a hard error (main → exit 1).
  const explicit = (values.url as string | undefined) ?? io.env.J2_URL;
  if (explicit) return attach(explicit, io.env.J2_TOKEN);

  // The deployed instance first (ADR-0019: same resolution as every run-verb) — that is where
  // live runs are. Resolution failing (not deployed / no kube context) falls through to the
  // ephemeral instance, loudly.
  let target: Target | undefined;
  try {
    target = await resolveTarget(io, targetOptions(values));
  } catch (err) {
    activity(
      io,
      `${err instanceof Error ? err.message : String(err)}\n` +
        "  → serving an ephemeral orchestrator instead — the diagram works, but it has NO live runs",
    );
  }
  if (target) {
    const t = target;
    const code = await attach(t.url, t.token);
    if (code !== 0 || !t.close) {
      t.close?.();
      return code;
    }
    // The page's transport IS this process's port-forward: hold it open until Ctrl-C.
    activity(io, "  port-forwarding the deployed orchestrator; press Ctrl-C to stop");
    return serveUntilSignal(io, () => t.close?.());
  }

  const root = resolveRoot(io.cwd);

  // No deployed instance: serve this folder's machine structure ourselves until Ctrl-C.
  const inst = await startInstance({ dir: root, port: values.port ? Number(values.port) : undefined });
  if (!inst.workflows.includes(workflow)) {
    activity(io, `no workflow "${workflow}" — available: ${inst.workflows.join(", ") || "(none)"}`);
    await inst.close();
    return 1;
  }
  const url = vizUrl(inst.url, workflow);
  activity(io, `visualizing "${workflow}" — ${url}`);
  activity(io, "  serving an ephemeral orchestrator; press Ctrl-C to stop");
  await warnOpaque(inst.url, workflow, io);
  result(io, { url, workflow }); // before blocking, so `--no-open | jq` yields data immediately
  if (!values["no-open"]) openInBrowser(url, io);
  return serveUntilSignal(io, () => inst.close());
}
