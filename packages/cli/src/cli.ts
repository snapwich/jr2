// Top-level dispatch (ADR-0009). `argv[0]` is the verb; the rest is handed to that command, which does
// its own `parseArgs`. `main` returns an exit code (the bin sets `process.exitCode`) and never throws:
// a command error becomes an `error: …` line on stderr + code 1. Codes: 0 ok, 1 runtime error, 2 usage.

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
import { down } from "./commands/down.ts";
import { gc } from "./commands/gc.ts";
import { kit } from "./commands/kit.ts";
import { version } from "./commands/version.ts";

const USAGE = `jr2 — orchestrate agentic workflows (ADR-0009)

usage: jr2 <command> [args]

  version [--local] [--json]        what runs here (this jr2, the global that handed off, the
                                    Instance's Kit) and what the cluster runs; --local skips the cluster
  init [dir] [--name <n>]            scaffold a new instance folder
  up [--yes] [--force]              converge the current kube context to this instance (ADR-0019)
  down [--all]                      remove the instance from the cluster (--all: operator too)
  gc [--dry-run] [--repo-ttl 7d]    remove jr2's images that no live instance names (ADR-0039), and
                                    Repo resources no Machine binds and no run attached lately (ADR-0051)
  kit push <registry>               mirror the published kit images into a registry (ADR-0044)
  run <workflow> [--input <json>]   start a run; stream activity, print terminal result
       [--detach]                   ...or just print the runId and return
  runs                              list live runs
  status [runId]                    print a run's current status (read-through),
         [--json]                   or the instance's Repos, per node, when given none (ADR-0048/0051)
  logs <runId> [-f]                 replay a run's status; -f to follow until it settles
  send <runId> --event CANCEL       abandon a live run
  send <runId> --gate <gate> --event <name> [--input <json>]
                                    deliver a workflow event to an open gate

run ids: any <runId> above may be abbreviated to a unique prefix (4+ chars, git-style);
         an ambiguous prefix lists the candidates and fails rather than guessing

global (run verbs): -n/--namespace <ns>, --context <ctx> address the deployment (ADR-0019);
                    --url <u> / JR2_URL attaches to a specific orchestrator (skips kube entirely)

output: result verbs (run, runs, status <runId>, send, logs) print one JSON result on stdout and
        activity on stderr, so \`jr2 run … | jq\` yields the result; report verbs (version, bare
        status) print a table on stdout, or the one object with --json`;

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
      case "help":
      case "--help":
      case "-h":
        activity(io, USAGE);
        return 0;
      case undefined:
        activity(io, USAGE);
        return 2;
      default:
        activity(io, `unknown command: ${cmd}`);
        activity(io, USAGE);
        return 2;
    }
  } catch (err) {
    activity(io, `error: ${err instanceof Error ? err.message : String(err)}`);
    const note = skewNote(err);
    if (note) activity(io, note);
    return 1;
  }
}
