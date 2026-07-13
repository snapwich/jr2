// Top-level dispatch (ADR-0009). `argv[0]` is the verb; the rest is handed to that command, which does
// its own `parseArgs`. `main` returns an exit code (the bin sets `process.exitCode`) and never throws:
// a command error becomes an `error: …` line on stderr + code 1. Codes: 0 ok, 1 runtime error, 2 usage.

import { activity, defaultIo, type Io } from "./output.ts";
import { init } from "./commands/init.ts";
import { dev } from "./commands/dev.ts";
import { run } from "./commands/run.ts";
import { runs } from "./commands/runs.ts";
import { status } from "./commands/status.ts";
import { logs } from "./commands/logs.ts";
import { approve } from "./commands/approve.ts";
import { send } from "./commands/send.ts";
import { visualize } from "./commands/visualize.ts";
import { cluster } from "./commands/cluster.ts";

const USAGE = `j2 — orchestrate agentic workflows (ADR-0009)

usage: j2 <command> [args]

  init [dir] [--name <n>]            scaffold a new instance folder
  dev [--port <p>] [--hostname <h>] boot this instance's orchestrator (writes .j2/dev.json)
  run <workflow> [--input <json>]   start a run; stream activity, print terminal result
       [--detach]                   ...or just print the runId and return
  runs                              list live runs
  status <runId>                    print a run's current status (read-through)
  logs <runId> [-f]                 replay a run's status; -f to follow until it settles
  approve <runId> [--reject]        answer a parked request_approval
  send <runId> --event <E>          feed a down-channel event (APPROVE | CANCEL | STEER)
  visualize <workflow> [--no-open]  open the workflow's Machine in the browser
  cluster up|down [--name <n>]      create/delete the kind cluster (repos/ baked in via extraMounts)

global: --url <u> / J2_URL attaches to a specific orchestrator (skips the folder walk)`;

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "init":
        return await init(rest, io);
      case "dev":
        return await dev(rest, io);
      case "run":
        return await run(rest, io);
      case "runs":
        return await runs(rest, io);
      case "status":
        return await status(rest, io);
      case "logs":
        return await logs(rest, io);
      case "approve":
        return await approve(rest, io);
      case "send":
        return await send(rest, io);
      case "visualize":
        return await visualize(rest, io);
      case "cluster":
        return await cluster(rest, io);
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
