// Top-level dispatch (ADR-0009). `argv[0]` is the verb; the rest is handed to that command, which does
// its own `parseArgs`. `main` returns an exit code (the bin sets `process.exitCode`) and never throws:
// a command error becomes an `error: …` line on stderr + code 1. Codes: 0 ok, 1 runtime error, 2 usage.

import { activity, defaultIo, type Io } from "./output.ts";
import { loadDotenv } from "./env.ts";
import { init } from "./commands/init.ts";
import { run } from "./commands/run.ts";
import { runs } from "./commands/runs.ts";
import { status } from "./commands/status.ts";
import { logs } from "./commands/logs.ts";
import { send } from "./commands/send.ts";
import { visualize } from "./commands/visualize.ts";
import { up } from "./commands/up.ts";
import { down } from "./commands/down.ts";

const USAGE = `j2 — orchestrate agentic workflows (ADR-0009)

usage: j2 <command> [args]

  init [dir] [--name <n>]            scaffold a new instance folder
  up [--yes] [--force]              converge the current kube context to this instance (ADR-0019)
  down [--all]                      remove the instance from the cluster (--all: operator too)
  run <workflow> [--input <json>]   start a run; stream activity, print terminal result
       [--detach]                   ...or just print the runId and return
  runs                              list live runs
  status <runId>                    print a run's current status (read-through)
  logs <runId> [-f]                 replay a run's status; -f to follow until it settles
  send <runId> --event CANCEL       abandon a live run
  send <runId> --gate <gate> --event <name> [--input <json>]
                                    deliver a workflow event to an open gate
  visualize <workflow> [--no-open]  open the workflow's Machine in the browser

run ids: any <runId> above may be abbreviated to a unique prefix (4+ chars, git-style);
         an ambiguous prefix lists the candidates and fails rather than guessing

global (run verbs): -n/--namespace <ns>, --context <ctx> address the deployment (ADR-0019);
                    --url <u> / J2_URL attaches to a specific orchestrator (skips kube entirely)`;

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    // Before any verb, so the instance's `.env` is in `process.env` by the time a command imports
    // `j2.config.ts` (whose deployment-varying values are read from there — ADR-0019).
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
      case "visualize":
        return await visualize(rest, io);
      case "up":
        return await up(rest, io);
      case "down":
        return await down(rest, io);
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
    return 1;
  }
}
