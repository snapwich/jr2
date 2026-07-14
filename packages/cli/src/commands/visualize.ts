// `j2 visualize <workflow> [--no-open] [--url <u>] [--port <p>]`: open the workflow's Machine in
// the browser. The page itself is served by the orchestrator (`/viz/:name` — every orchestrator
// carries its own visualizer), so this verb's job is only to find one to attach to, or boot one:
//
//   - an explicit address (`--url` / `J2_URL`) or a live `j2 dev` (`.j2/dev.json`) → attach, print
//     the page URL, open the browser, exit — the server's lifecycle is not ours;
//   - otherwise → boot an ephemeral in-process instance (same `startInstance` seam as `j2 dev`,
//     but WITHOUT writing `.j2/dev.json` — this server is private to the visualizer) and serve
//     until Ctrl-C. Like `dev`, the signal/blocking half is exercised e2e, not unit-tested.
//
// A stale `.j2/dev.json` (dev died without cleanup) fails its probe and falls through to the
// ephemeral boot; an explicit address that doesn't answer stays a hard error.

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { opaqueStates, startInstance } from "@j2/orchestrator";
import { J2Client } from "../client.ts";
import { readDevJson, resolveRoot } from "../instance.ts";
import { activity, result, type Io } from "../output.ts";

const USAGE = "usage: j2 visualize <workflow> [--no-open] [--url <u>] [--port <p>]";

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
async function warnOpaque(baseUrl: string, workflow: string, io: Io): Promise<void> {
  try {
    const states = opaqueStates(await new J2Client(baseUrl, io.fetch).machine(workflow));
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

export async function visualize(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: { url: { type: "string" }, "no-open": { type: "boolean" }, port: { type: "string" } },
  });
  const workflow = positionals[0];
  if (!workflow) {
    activity(io, USAGE);
    return 2;
  }

  /** Attach to a serving orchestrator: validate the workflow, print, open, done. */
  const attach = async (baseUrl: string): Promise<number> => {
    const workflows = await new J2Client(baseUrl, io.fetch).workflows();
    if (!workflows.includes(workflow)) {
      activity(io, `no workflow "${workflow}" — available: ${workflows.join(", ") || "(none)"}`);
      return 1;
    }
    const url = vizUrl(baseUrl, workflow);
    activity(io, `visualizing "${workflow}" — ${url}`);
    await warnOpaque(baseUrl, workflow, io);
    result(io, { url, workflow });
    if (!values["no-open"]) openInBrowser(url, io);
    return 0;
  };

  // An explicit address is trusted: if it doesn't answer, that's a hard error (main → exit 1).
  const explicit = (values.url as string | undefined) ?? io.env.J2_URL;
  if (explicit) return attach(explicit);

  const root = resolveRoot(io.cwd);
  const dev = readDevJson(root);
  if (dev) {
    try {
      return await attach(dev.url);
    } catch {
      activity(io, `stale .j2/dev.json (no orchestrator at ${dev.url}) — booting one just for the visualizer`);
    }
  }

  // No server to attach to: serve this instance ourselves until Ctrl-C.
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

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    activity(io, "stopping…");
    await inst.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise<void>(() => {}); // serve until a signal triggers shutdown
  return 0; // unreachable
}
