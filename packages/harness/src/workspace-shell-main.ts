// The entry of `jr2 workspace shell` in the pod (ADR-0076): the client that `workspace-shell.ts`
// describes. It reads the control Stand-in's file to prove that it is not a process of the domain,
// asks the Harness for the shell, and carries this terminal to it. It starts nothing itself.
// First, before any other module runs: node looks for modules in jr2's folders alone, as in the
// Harness (`module-paths.ts`).
import "./module-paths-guard.ts";
import { CONTROL_STANDIN_FILE, readControlStandIn, SHELL_SOCKET } from "./children.ts";
import { shellClient, shellProof } from "./workspace-shell.ts";

/** Run as the exec's command: the shell's exit code is this process's. */
async function main(argv: readonly string[]): Promise<number> {
  const dash = argv.indexOf("--");
  const command = dash >= 0 ? argv.slice(dash + 1) : [];
  const proof = shellProof(readControlStandIn(process.env.JR2_CONTROL_STANDIN_FILE || CONTROL_STANDIN_FILE));
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const client = shellClient({
    socket: process.env.JR2_SHELL_SOCKET || SHELL_SOCKET,
    proof,
    argv: command,
    ...(terminal ? { tty: { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 } } : {}),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  if (terminal) {
    // Each key goes to the shell's terminal as it is typed: Ctrl-C is a byte that the shell's
    // terminal makes SIGINT of, for its foreground job.
    process.stdin.setRawMode(true);
    process.stdout.on("resize", () => client.resize(process.stdout.rows, process.stdout.columns));
  } else {
    // No terminal: `kubectl exec -i` sends this process no signal. A Ctrl-C ends jr2 and kubectl,
    // and this process gets the end of its stdin, which goes to the command as `stdin-end`. The
    // command can run on after it; when this process can no longer write its output (EPIPE), it
    // ends the connection, and the Harness hangs up the command. A signal that reaches this process
    // in another way (a `kill` in the container) goes to the command.
    for (const signal of ["SIGINT", "SIGQUIT", "SIGTERM"] as const) process.on(signal, () => client.signal(signal));
  }
  // The person went away (the exec's terminal hung up): the shell gets the hang-up.
  process.on("SIGHUP", () => client.signal("SIGHUP"));
  try {
    return await client.done;
  } finally {
    if (terminal) process.stdin.setRawMode(false);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`jr2 workspace shell: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
