// The child Harness's half of a Handoff (ADR-0080): `PUT /handoffs/<id>` lands the files that the
// Orchestrator carries for the cut whose Effect id is `<id>`, in the folder of that cut
// (`landedFolder`), through the land process (`handoff-land-main.ts`), which the spawner starts in
// the child Agent's domain. So the files are written with what an Agent of the child can write, and
// nothing in the body gets more than that. The cut reads them in the same domain.
//
// The Harness pipes the body into the land process's stdin, in chunks, and holds no part of it: it
// sends the next chunk only while the bytes that it sent and the land process did not yet say it
// took (`{"took":n}` on its stdout) are under a window. The land process is in the domain, so its
// words are the domain's data: they decide only when this Harness sends more of a body that the
// Orchestrator bounds, and whether this Harness answers `landed`.

import { fileURLToPath } from "node:url";
import { HARNESS_HOME, type ChildPolicy } from "./children.ts";
import { HANDOFF_LAND_DIR, LAND_ID } from "./handoff-land-main.ts";
import { SpawnerGoneError, SpawnError, type Spawned } from "./spawner.ts";

/** The land process's entry, beside this module: `/opt/jr2/src/handoff-land-main.ts` in a pod. */
export const HANDOFF_LAND_ENTRY = fileURLToPath(new URL("./handoff-land-main.ts", import.meta.url));

/** The bytes that the Harness sends ahead of what the land process took. */
const WINDOW = 4 << 20;
/** The largest stdin frame: the spawner's channel carries it in base64 in one JSON line. */
const PIECE = 256 << 10;
/** The longest line that the land process may write. */
const MAX_LINE = 256;

export type LandOptions = {
  /** Where the Repo Slots are. Default `/work`. */
  workRoot?: string;
  /** The land process's entry. Default {@link HANDOFF_LAND_ENTRY}; a test names another. */
  entry?: string;
  /** The bytes sent ahead of what the land process took. Default 4 MiB. */
  window?: number;
  /** The bounds that the land process checks. Default `HANDOFF_MAX_BYTES` and `HANDOFF_MAX_OBJECTS`. */
  maxBytes?: number;
  maxObjects?: number;
};

/** What a `PUT /handoffs/<id>` lands: `landed`, or why not. */
export type Landing = { landed: true } | { fault: string };

/** What `PUT /handoffs/<id>` refuses before anything runs. */
export function landIdFault(id: string): string | undefined {
  return LAND_ID.test(id) ? undefined : `"${id.slice(0, 200)}" is no Effect id`;
}

/**
 * Land `body` for the cut whose Effect id is `id`. It resolves `landed` when the land process
 * renamed the folder into place and said so, and else names the fault. A body that errors (the
 * Orchestrator ended the carry) kills the land process's group, and nothing is kept.
 */
export async function landHandoff(
  children: ChildPolicy,
  id: string,
  body: ReadableStream<Uint8Array> | null,
  opts: LandOptions = {},
): Promise<Landing> {
  const bad = landIdFault(id);
  if (bad !== undefined) return { fault: bad };
  if (body === null) return { fault: "the body is empty" };
  const window = opts.window ?? WINDOW;
  const input = {
    root: `${opts.workRoot ?? "/work"}/${HANDOFF_LAND_DIR}`,
    id,
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.maxObjects !== undefined ? { maxObjects: opts.maxObjects } : {}),
  };

  let took = 0;
  let landed = false;
  let fault: string | undefined;
  let line = "";
  let stderr = "";
  let wake: (() => void) | undefined;
  const nudge = (): void => {
    const w = wake;
    wake = undefined;
    w?.();
  };

  let proc: Spawned;
  const onStdout = (chunk: Buffer): void => {
    line += chunk.toString("utf8");
    let nl: number;
    while ((nl = line.indexOf("\n")) >= 0) {
      const text = line.slice(0, nl);
      line = line.slice(nl + 1);
      let f: unknown;
      try {
        f = JSON.parse(text);
      } catch {
        f = undefined;
      }
      const h = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
      if (typeof h.took === "number" && Number.isSafeInteger(h.took) && h.took >= took) took = h.took;
      else if (h.landed === true && Object.keys(h).length === 1) landed = true;
      else fault ??= "the land process wrote a line out of its form";
    }
    if (line.length > MAX_LINE) fault ??= "the land process wrote a line out of its form";
    if (fault !== undefined) proc.signal("SIGKILL");
    nudge();
  };

  proc = children.spawner.spawn(
    {
      argv: [process.execPath, opts.entry ?? HANDOFF_LAND_ENTRY, JSON.stringify(input)],
      // node's HOME is the Harness's own, which the domain cannot reach: no `NODE_OPTIONS` of the
      // image loads code into it (as the bundle step, `handoff-bundle.ts`).
      env: { HOME: HARNESS_HOME },
      cwd: "/",
      stdin: true,
    },
    { onStdout, onStderr: (c) => void (stderr = (stderr + c.toString("utf8")).slice(-4096)) },
  );
  let exited = false;
  const exit = proc.exited.then(
    (e) => {
      exited = true;
      nudge();
      return e;
    },
    (err: unknown) => {
      exited = true;
      nudge();
      throw err;
    },
  );
  exit.catch(() => {});

  const reader = body.getReader();
  // A body that breaks while the Harness waits for the land process (the Orchestrator ended the
  // carry) ends the wait.
  let broke: unknown;
  reader.closed.catch((err: unknown) => {
    broke = err ?? new Error("the body broke");
    nudge();
  });
  let sent = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let at = 0; at < value.byteLength; at += PIECE) {
        while (sent - took > window && !exited && fault === undefined && broke === undefined) {
          await new Promise<void>((r) => (wake = r));
        }
        if (broke !== undefined) throw broke;
        if (exited || fault !== undefined) break;
        const piece = value.subarray(at, Math.min(value.byteLength, at + PIECE));
        proc.write(Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength));
        sent += piece.byteLength;
      }
      if (exited || fault !== undefined) break;
    }
  } catch (err) {
    proc.signal("SIGKILL");
    await exit.catch(() => {});
    return { fault: `the body broke: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (exited || fault !== undefined) await reader.cancel().catch(() => {});
  proc.end();
  try {
    const e = await exit;
    if (fault !== undefined) return { fault };
    if (e.code === 0 && e.signal === null && landed) return { landed: true };
    const last = stderr.trim().split("\n").at(-1)?.slice(0, 500);
    const how = e.signal !== null ? `by ${e.signal}` : `with exit ${e.code}`;
    return { fault: `the land process ended ${how}${last ? `: ${last}` : ""}` };
  } catch (err) {
    const why = err instanceof SpawnError || err instanceof SpawnerGoneError ? err.message : String(err);
    return { fault: `the land process did not run: ${why}` };
  } finally {
    proc.signal("SIGKILL");
  }
}
