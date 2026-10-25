// Top-level dispatch (ADR-0009). `argv[0]` is the verb; the rest is handed to that command, which does
// its own `parseArgs` against its entry in the command table (`command-table.ts`). Every help prints
// from that table too: `jr2 --help` the whole of it, `jr2 <verb> --help` (or `-h`) one entry — and
// then the verb does NOT run, so `jr2 up --help` never converges a cluster. `main` returns an exit
// code (the bin sets `process.exitCode`) and never throws: a command error becomes an `error: …` line
// on stderr + code 1. Codes: 0 ok, 1 runtime error, 2 usage.

import { activity, defaultIo, type Io } from "./output.ts";
import { JR2HttpError } from "./client.ts";
import { loadDotenv } from "./env.ts";
import { init } from "./commands/init.ts";
import { run } from "./commands/run.ts";
import { runs } from "./commands/runs.ts";
import { status } from "./commands/status.ts";
import { logs } from "./commands/logs.ts";
import { send } from "./commands/send.ts";
import { up } from "./commands/up.ts";
import { check } from "./commands/check.ts";
import { down } from "./commands/down.ts";
import { gc } from "./commands/gc.ts";
import { kit } from "./commands/kit.ts";
import { version } from "./commands/version.ts";
import { asksForHelp, commandsFor, GLOBAL, renderCommand, renderHelp } from "./command-table.ts";

/**
 * The catch-all half of skew reporting: a route-shaped failure gets ONE extra line naming what the
 * instance says it is. Deliberately not a diagnosis — `run-id.ts` diagnoses the one case we can
 * prove, and this covers the routes nobody has thought to special-case yet.
 *
 * Scoped to 404/405 because those are the codes a MISSING route produces; a 400/401/403/409 is the
 * instance understanding the request and refusing it, where naming the version would be noise. And
 * it says nothing when the instance reports no version at all, since a host-booted fixture process
 * (the e2e tier's) legitimately has neither version nor hash to report.
 */
function skewNote(err: unknown): string | undefined {
  if (!(err instanceof JR2HttpError)) return undefined;
  if (err.status !== 404 && err.status !== 405) return undefined;
  const { version, hash } = err.instance ?? {};
  if (!version) return undefined;
  const id = hash ? `${version} (${hash})` : version;
  return `  instance: ${id} — if it predates this CLI, \`jr2 up\` converges the cluster to this kit`;
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    // Before any verb, so the instance's `.env` is in `process.env` by the time a command imports
    // `jr2.config.ts` (whose deployment-varying values are read from there — ADR-0019).
    loadDotenv(io);
    const entries = cmd === undefined ? [] : commandsFor(cmd);
    if (entries.length && asksForHelp(entries, rest)) {
      activity(io, entries.map(renderCommand).join("\n\n"));
      return 0;
    }
    if (cmd !== undefined && (GLOBAL.help as readonly string[]).includes(cmd)) {
      activity(io, renderHelp());
      return 0;
    }
    switch (cmd) {
      case "init":
        return await init(rest, io);
      case "run":
        return await run(rest, io);
      case "runs":
        return await runs(rest, io);
      case "status":
        return await status(rest, io);
      case "logs":
        return await logs(rest, io);
      case "send":
        return await send(rest, io);
      case "check":
        return await check(rest, io);
      case "up":
        return await up(rest, io);
      case "down":
        return await down(rest, io);
      case "gc":
        return await gc(rest, io);
      case "kit":
        return await kit(rest, io);
      case "version":
      case "--version":
        return await version(rest, io);
      case undefined:
        activity(io, renderHelp());
        return 2;
      default:
        activity(io, `unknown command: ${cmd}`);
        activity(io, renderHelp());
        return 2;
    }
  } catch (err) {
    activity(io, `error: ${err instanceof Error ? err.message : String(err)}`);
    const note = skewNote(err);
    if (note) activity(io, note);
    return 1;
  }
}
