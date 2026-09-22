// `npm start` (alias `npm run stage`) — everything the talk needs except the model, which lives longer than the deck.
//
// Preflight first, because each of these failures is silent and late otherwise: a kube context
// pointing somewhere else, an instance that was never converged, a model endpoint that is not
// answering, or two live runs (the Console auto-selects the FIRST one it knows, so a stale run
// steals the picture the audience is meant to be watching).
//
// Then three processes: ttyd serving the demo session (writable), the port-forward that gives the
// Console a stable address, and this deck's own server. Ctrl-C takes down all three and kills the
// `intro` session with them, so `stage` is the whole lifecycle and nothing of the talk outlives it.
// The cost is that the session's scrollback and its `$RUN` go too: after a restart, a Gate still
// parked server-side needs its runId again (`jr2 runs`).

import { spawn, execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const INSTANCE = resolve(HERE, "..", "instance");

const SESSION = "intro";
const NAMESPACE = "intro";
const DECK_PORT = Number(process.env.JR2_DECK_PORT ?? 9000);
const TERMINAL_PORT = Number(process.env.JR2_TERMINAL_PORT ?? 7681);
const CONSOLE_PORT = Number(process.env.JR2_CONSOLE_PORT ?? 8080);
/** The Service `jr2 up` deploys (packages/orchestrator/src/names.ts). */
const ORCHESTRATOR_PORT = 4000;
/** llama-server as seen from THIS machine — the instance's own url is the pod's view of it. */
const LLAMA = "http://127.0.0.1:8000/v1/models";

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const die = (s, fix) => {
  console.log(`  \x1b[31m✗\x1b[0m ${s}`);
  if (fix) console.log(`      → ${fix}`);
  process.exit(1);
};

async function out(cmd, args) {
  const { stdout } = await exec(cmd, args);
  return stdout.trim();
}

async function free(port) {
  return await new Promise((r) => {
    const s = createServer();
    s.once("error", () => r(false));
    s.listen(port, "127.0.0.1", () => s.close(() => r(true)));
  });
}

// --- preflight ------------------------------------------------------------------------------------

console.log("preflight");

/** On PATH? Asked by walking PATH rather than by shelling out, so no quoting question arises. */
async function onPath(bin) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (
      dir &&
      (await access(join(dir, bin), constants.X_OK).then(
        () => true,
        () => false,
      ))
    )
      return true;
  }
  return false;
}

for (const bin of ["tmux", "ttyd", "kubectl", "jq"]) {
  if (!(await onPath(bin))) die(`${bin} is not installed`, `brew install ${bin}`);
}
ok("tmux, ttyd, kubectl, jq");

for (const [port, what] of [
  [DECK_PORT, "deck"],
  [TERMINAL_PORT, "terminal"],
  [CONSOLE_PORT, "console forward"],
]) {
  if (!(await free(port))) die(`port ${port} (${what}) is already in use`, `lsof -nP -iTCP:${port} -sTCP:LISTEN`);
}
ok(`ports ${DECK_PORT}, ${TERMINAL_PORT}, ${CONSOLE_PORT} free`);

const context = await out("kubectl", ["config", "current-context"]).catch(() => "");
if (!context) die("no current kube context", "kind create cluster --name jr2 && kubectl config use-context kind-jr2");
context === "kind-jr2"
  ? ok(`kube context ${context}`)
  : warn(`kube context is ${context} — jr2 up converges into THIS one`);

const replicas = await out("kubectl", [
  "-n",
  NAMESPACE,
  "get",
  "deploy",
  "jr2-orchestrator",
  "-o",
  "jsonpath={.status.readyReplicas}",
]).catch(() => "");
if (replicas === "1") ok(`orchestrator ready in namespace ${NAMESPACE}`);
else die(`no ready orchestrator in namespace ${NAMESPACE}`, `cd ../instance && npx jr2 up`);

const env = await readFile(join(INSTANCE, ".env"), "utf8").catch(() => "");
const key = /^JR2_PROVIDER_API_KEY=(.*)$/m.exec(env)?.[1]?.trim();
const models = await fetch(LLAMA, { headers: key ? { authorization: `Bearer ${key}` } : {} })
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
if (models) ok(`model endpoint answering: ${models.data?.map((m) => m.id).join(", ") ?? "?"}`);
else
  warn("llama-server is not answering on :8000 — `ping` still runs, `task` will not (npm run llama, in ../instance)");

const runs = await out(join(INSTANCE, "node_modules", ".bin", "jr2"), ["runs", "--json"]).catch(() => "");
const live = (() => {
  try {
    return JSON.parse(runs).filter((r) => r.state !== "done" && r.state !== "failed").length;
  } catch {
    return null;
  }
})();
if (live === null) warn("could not read the run list — skipping the one-live-run check");
else if (live > 1)
  warn(`${live} live runs — the Console auto-selects the first it hears about; consider clearing them`);
else ok(`${live} live run${live === 1 ? "" : "s"}`);

// --- the session the demo runs in -----------------------------------------------------------------

// `-A` is attach-or-create, so re-running stage rejoins the session you already have. PATH carries
// the instance's own `jr2` so every command the room reads is the bare verb, not an npx incantation.
await exec("tmux", [
  "new-session",
  "-d",
  "-A",
  "-s",
  SESSION,
  "-c",
  INSTANCE,
  "-e",
  `PATH=${join(INSTANCE, "node_modules", ".bin")}:${process.env.PATH}`,
]);
// The window follows its CLIENTS, not a pinned number: ttyd reports the size of the terminal it
// renders (xterm.js refits whenever its frame changes shape, and ttyd sends that size down the
// socket), so tmux resizes to whatever room the stage gives it. `smallest` rather than the default
// `latest` because you can attach a second client to repair something mid-talk: `latest` would hand
// the room YOUR terminal's geometry and clip the deck's view, while `smallest` keeps the whole
// window visible in BOTH — the cost is that a small control terminal shrinks what the room sees,
// which a resize or a detach undoes.
const window = (await out("tmux", ["list-windows", "-t=" + SESSION, "-F", "#{window_id}"])).split("\n")[0];
await exec("tmux", ["set-option", "-t", window, "window-size", "smallest"]);
// --- the three processes --------------------------------------------------------------------------

const children = [];
function start(name, cmd, args) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd: HERE });
  child.stdout.on("data", (b) => process.stdout.write(`[${name}] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[${name}] ${b}`));
  child.on("exit", (code) => code !== null && code !== 0 && console.log(`[${name}] exited ${code}`));
  children.push(child);
  return child;
}

// WRITABLE (`-W`, and the tmux client is not `-r`): the deck is a place to type, not only a place to
// watch, so the terminal in the stage is a real one. Loopback-bound, because ttyd's default is every
// interface — which on conference wifi is a shell on the LAN, and this one accepts input. It
// attaches to the demo session itself, so whatever window you select is the window the room sees.
start("ttyd", "ttyd", [
  "-W",
  "-p",
  String(TERMINAL_PORT),
  "-i",
  "127.0.0.1",
  "-t",
  "fontSize=18",
  "-t",
  'theme={"background":"#0a0f1a","foreground":"#c8d6e8","cursor":"#4ef0a7"}',
  "tmux",
  "attach",
  "-t",
  "=" + SESSION,
]);
start("forward", "kubectl", [
  "port-forward",
  "-n",
  NAMESPACE,
  "svc/jr2-orchestrator",
  `${CONSOLE_PORT}:${ORCHESTRATOR_PORT}`,
]);
start("deck", process.execPath, ["server.mjs"]);

console.log(`
stage up
  deck      http://localhost:${DECK_PORT}
  console   http://localhost:${CONSOLE_PORT}      (forwarded from ${NAMESPACE}/jr2-orchestrator)
  terminal  http://localhost:${TERMINAL_PORT}      (tmux "${SESSION}", writable)

  you type here:  tmux attach -t =${SESSION}
  ctrl-c here stops the three processes and kills the ${SESSION} session
`);

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    for (const child of children) child.kill();
    await exec("tmux", ["kill-session", "-t=" + SESSION]).catch(() => {});
    console.log("\nstage down");
    process.exit(0);
  });
}
