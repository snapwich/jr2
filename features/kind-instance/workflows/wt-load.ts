// The Worktree load, a measurement: N coders in one clone of a large repository, in
// one real pod: commits, an Agent's `git fetch` through the real ext:: program and the real coalescer,
// and cuts beside them, on a remote that a step moves from outside. Its output is the report.
import { z } from "zod";
import { assign } from "xstate";
import { arg, command, jr2Setup, workspace, type HostInjectedInput, type Workspaced } from "@jr2/orchestrator";

const SCRIPT = String.raw`
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const [seconds, coders] = process.argv.slice(1).map(Number);
const end = Date.now() + seconds * 1000;
const run = (cwd, program, args) =>
  new Promise((done) => {
    const at = Date.now();
    const p = spawn(program, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => done({ code, err, out, ms: Date.now() - at }));
  });
const stat = () => ({ ok: 0, fail: 0, lock: 0, warned: 0, ms: [], reasons: {} });
const fetches = stat();
const commits = stat();
const cuts = stat();
const count = (s, r) => {
  s.ms.push(r.ms);
  if (/remote fetch failed/.test(r.err)) s.warned++;
  if (r.code === 0) s.ok++;
  else {
    s.fail++;
    if (/cannot lock ref|\.lock/.test(r.err)) s.lock++;
    const line = (r.err.split("\n").find((l) => /^(fatal|error)/.test(l)) || r.err).replace(/[0-9a-f]{40}/g, "<sha>").replace(/'[^']*'/g, "'…'").slice(0, 90);
    s.reasons[line] = (s.reasons[line] || 0) + 1;
  }
};
const cut = async (name, branch) => {
  const req = JSON.stringify({ id: name + Date.now(), path: "/work/app/" + name, branch, base: "main" });
  const r = await run("/work", "/opt/jr2/bin/node", ["/opt/jr2/src/cut.ts", req]);
  const answer = JSON.parse(r.out.trim().split("\n").pop() || "{}");
  cuts.ms.push(r.ms);
  if (answer.outcome === "ready") {
    cuts.ok++;
    if (answer.stale) cuts.warned++;
  } else {
    cuts.fail++;
    const line = String(answer.reason || r.err).slice(0, 90);
    cuts.reasons[line] = (cuts.reasons[line] || 0) + 1;
  }
};
const coder = async (i) => {
  const path = "/work/app/coder-" + i;
  await cut("coder-" + i, "load/" + i);
  for (let n = 0; Date.now() < end; n++) {
    writeFileSync(path + "/load-" + i + ".txt", String(n));
    await run(path, "git", ["add", "."]);
    count(commits, await run(path, "git", ["-c", "user.name=l", "-c", "user.email=l@l", "commit", "-qm", "n" + n]));
    count(fetches, await run(path, "git", ["fetch", "-q", "origin"]));
  }
};
const cutter = async () => {
  for (let n = 0; Date.now() < end; n++) {
    await cut("cut-" + n, "cut/" + n);
    await new Promise((r) => setTimeout(r, 2000));
  }
};
const shape = (s) => {
  const ms = s.ms.sort((a, b) => a - b);
  const at = (q) => ms[Math.floor(ms.length * q)] ?? 0;
  return { ok: s.ok, fail: s.fail, lock: s.lock, warned: s.warned, p50: at(0.5), p95: at(0.95), max: at(0.9999), reasons: s.reasons };
};
(async () => {
  await Promise.all([...Array.from({ length: coders }, (_, i) => coder(i)), cutter()]);
  console.log(JSON.stringify({ commits: shape(commits), fetches: shape(fetches), cuts: shape(cuts) }));
})();
`;

const door = z.object({ seconds: z.string(), coders: z.string() });
type BodyInput = Workspaced<HostInjectedInput & z.infer<typeof door>, "app">;
type Ctx = BodyInput & { report?: unknown };

const body = jr2Setup({
  types: {} as { context: Ctx; input: BodyInput; output: unknown },
  actors: {
    load: command(["/opt/jr2/bin/node", "-e", SCRIPT, arg("seconds"), arg("coders")], { timeout: "15m", tail: 8192 }),
  },
}).createMachine({
  id: "body",
  context: ({ input }) => input,
  on: { "workspace.lost": ".done" },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({
          seconds: context.seconds,
          coders: context.coders,
          worktree: "/work/app/default",
        }),
        onDone: { target: "done", actions: assign({ report: ({ event }) => event.output }) },
      },
    },
    done: { type: "final", output: ({ context }) => context.report ?? null },
  },
  output: ({ event }: { event: unknown }) => (event as { output?: unknown }).output,
});

export const machine = workspace(body, {
  input: door,
  resources: { limits: { memory: "6Gi", cpu: "4" } },
  repos: { app: { url: "http://seed.jr2-e2e-seed.svc/large.git", ref: "main" } },
});
