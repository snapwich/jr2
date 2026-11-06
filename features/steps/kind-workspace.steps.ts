// @kind steps for the `jr2 workspace` verbs (ADR-0009, ADR-0012, ADR-0021, ADR-0076) and the kept
// conversation of a real Harness (ADR-0023). The verbs read the Sandbox CRs over the kube API: the
// steps run the real `jr2` binary in the scenario's namespace and read the CRs with kubectl.

import { After, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { ANNOTATION_WORKSPACE_PATH, LABEL_SANDBOX_WORKSPACE, workspaceLabel } from "@jr2/orchestrator/internal";
import { kubectl, podStandIns, waitForReadySandbox } from "./kind.steps.ts";
import { E2EWorld } from "./world.ts";

type Row = { handle: string; name: string; runId: string; path: string; hold: string };

/** The run's Workspace handle, as `jr2 workspace ls` printed it. */
const handles = new WeakMap<E2EWorld, string>();

/** The Sandbox CR of the run, whole: its labels and annotations. */
async function sandboxCr(
  world: E2EWorld,
): Promise<{ metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> } }> {
  const name = (await waitForReadySandbox(world)).metadata.name;
  return JSON.parse(await kubectl(world, ["get", "sandbox", name, "-o", "json"])) as {
    metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  };
}

/** The handle of the run's Workspace: from `ls`, or else from the CR as `ls` makes it. */
async function handleOf(world: E2EWorld): Promise<string> {
  const known = handles.get(world);
  if (known) return known;
  const cr = await sandboxCr(world);
  const path = cr.metadata.annotations?.[ANNOTATION_WORKSPACE_PATH];
  assert.ok(path, `the Sandbox ${cr.metadata.name} names its Workspace path`);
  const handle = `${world.runId!.slice(0, 8)}/${path}`;
  handles.set(world, handle);
  return handle;
}

Then(
  "the run's Sandbox carries its Workspace path in the jr2.dev\\/workspace label",
  async function (this: E2EWorld): Promise<void> {
    const cr = await sandboxCr(this);
    const path = cr.metadata.annotations?.[ANNOTATION_WORKSPACE_PATH];
    assert.ok(path, `the Sandbox names its Workspace path: ${JSON.stringify(cr.metadata.annotations)}`);
    const label = cr.metadata.labels?.[LABEL_SANDBOX_WORKSPACE];
    assert.equal(label, workspaceLabel(path));
    // The label is for a selector: kubectl finds the Sandbox by it.
    const found = await kubectl(this, [
      "get",
      "sandbox",
      "-l",
      `${LABEL_SANDBOX_WORKSPACE}=${label},jr2.dev/run=${this.runId}`,
      "-o",
      "jsonpath={.items[*].metadata.name}",
    ]);
    assert.equal(found.trim(), cr.metadata.name);
  },
);

When("I list the run's Workspaces", async function (this: E2EWorld): Promise<void> {
  const r = await this.runCli(["workspace", "ls", this.runId!, "--json"]);
  assert.equal(r.code, 0, `jr2 workspace ls failed: ${r.stderr}`);
});

Then(
  "the Workspace list has the run's Sandbox as {string}, by its handle",
  { timeout: 30_000 },
  async function (this: E2EWorld, hold: string): Promise<void> {
    // The hold mark changes a moment after the run ends (a kube patch): read the list again for a while.
    const started = Date.now();
    while (
      this.last?.code === 0 &&
      this.resultJson<{ workspaces: Row[] }>().workspaces[0]?.hold !== hold &&
      Date.now() - started < 20_000
    ) {
      await sleep(500);
      await this.runCli(["workspace", "ls", this.runId!, "--json"]);
    }
    const { workspaces } = this.resultJson<{ workspaces: Row[] }>();
    assert.equal(workspaces.length, 1, JSON.stringify(workspaces));
    const [row] = workspaces;
    assert.equal(row!.runId, this.runId);
    assert.ok(row!.path, "the row names the Workspace path");
    assert.equal(row!.handle, `${this.runId!.slice(0, 8)}/${row!.path}`);
    assert.equal(row!.hold, hold);
    handles.set(this, row!.handle);
  },
);

/** `jr2 workspace shell <ws> -- sh -c <command>`. The namespace flag goes before `--`, which ends
 * jr2's own words. */
When(
  "I run {string} in the run's Workspace with jr2 workspace shell",
  async function (this: E2EWorld, command: string): Promise<void> {
    const handle = await handleOf(this);
    await this.runCli(["workspace", "shell", handle, "-n", this.namespace!, "--", "sh", "-c", command], {
      namespaced: false,
    });
  },
);

/** `jr2 workspace shell <ws> --user -- sh -c <command>`: the User Container, not the Agents' domain. */
When(
  "I run {string} in the run's User Container with jr2 workspace shell --user",
  async function (this: E2EWorld, command: string): Promise<void> {
    const handle = await handleOf(this);
    await this.runCli(["workspace", "shell", handle, "--user", "-n", this.namespace!, "--", "sh", "-c", command], {
      namespaced: false,
    });
  },
);

Then("the shell's command exits 0 and prints {string}", function (this: E2EWorld, text: string): void {
  assert.equal(this.last?.code, 0, this.last?.stderr ?? "");
  assert.equal(this.last?.stdout.trim(), text);
});

Then("the shell's command fails and prints no Stand-in of the pod", async function (this: E2EWorld): Promise<void> {
  assert.notEqual(this.last?.code, 0, `the read was denied: ${this.last?.stdout}`);
  // The domain refuses the read (EACCES). A missing file or a command that never ran is no refusal.
  assert.match(this.last?.stderr ?? "", /Permission denied/, `the read was refused: ${this.last?.stderr}`);
  const seen = `${this.last?.stdout ?? ""}${this.last?.stderr ?? ""}`;
  for (const standIn of await podStandIns(this)) {
    assert.ok(!seen.includes(standIn), "the shell printed no Stand-in of the pod");
  }
});

Then(
  "the shell's command exits 0 and its env holds no Stand-in of the pod and no JR2_ name but the Custodian's address",
  async function (this: E2EWorld): Promise<void> {
    assert.equal(this.last?.code, 0, this.last?.stderr ?? "");
    const env = this.last?.stdout ?? "";
    assert.match(env, /^PATH=/m, "the shell printed its env");
    // The Agents' domain keeps `JR2_CUSTODIAN_URL` (the Harness's KEPT_JR2), and nothing else of jr2's.
    const jr2 = env
      .split("\n")
      .filter((l) => l.startsWith("JR2_"))
      .map((l) => l.split("=")[0]);
    assert.deepEqual(jr2, ["JR2_CUSTODIAN_URL"], "no JR2_ name but the Custodian's address reaches the shell");
    for (const standIn of await podStandIns(this)) {
      assert.ok(!env.includes(standIn), "no Stand-in of the pod is in the shell's env");
    }
  },
);

/** The server of the forward steps: a `kubectl exec` child that holds it until the scenario ends. */
const servers = new WeakMap<E2EWorld, ChildProcess>();

After({ tags: "@kind" }, function (this: E2EWorld): void {
  servers.get(this)?.kill("SIGTERM");
  servers.delete(this);
});

When(
  "a server in the run's Sandbox answers {string} on port {int}",
  { timeout: 60_000 },
  async function (this: E2EWorld, text: string, port: number): Promise<void> {
    const pod = (await waitForReadySandbox(this)).metadata.name;
    const server = `require("http").createServer((q,s)=>s.end(${JSON.stringify(text)})).listen(${port},"127.0.0.1")`;
    const exec = ["-n", this.namespace!, "exec", `pod/${pod}`, "-c", "harness", "--", "node", "-e"];
    // The exec holds the server for the scenario. Its output goes into the error below.
    const child = spawn("kubectl", [...exec, server]);
    servers.set(this, child);
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const probe = `fetch("http://127.0.0.1:${port}/").then(()=>process.exit(0),()=>process.exit(1))`;
    const started = Date.now();
    while (Date.now() - started < 45_000) {
      assert.equal(child.exitCode, null, `the server in the pod stopped: ${out}`);
      const answered = await kubectl(this, [...exec.slice(2), probe]).then(
        () => true,
        () => false,
      );
      if (answered) return;
      await sleep(500);
    }
    throw new Error(`the server in the pod never answered on port ${port}: ${out}`);
  },
);

Then(
  "jr2 workspace forward to port {int} reaches it at the address it prints",
  { timeout: 120_000 },
  async function (this: E2EWorld, port: number): Promise<void> {
    const handle = await handleOf(this);
    const started = this.startCli(["workspace", "forward", handle, String(port)]);
    try {
      let address = "";
      for (let i = 0; i < 300 && !address; i++) {
        address = /127\.0\.0\.1:\d+/.exec(started.output().stdout)?.[0] ?? "";
        if (!address) await sleep(100);
      }
      assert.ok(address, `forward printed its address: ${JSON.stringify(started.output())}`);
      const res = await fetch(`http://${address}/`);
      assert.equal(await res.text(), "hello from the pod");
    } finally {
      started.child.kill("SIGINT");
    }
  },
);

/** `<name>.jr2` is the handle that an ssh `Host *.jr2` ProxyCommand gives (ADR-0009). */
Then(
  "jr2 workspace forward --stdio to port {int}, by the Sandbox's name.jr2, carries one connection to it",
  { timeout: 120_000 },
  async function (this: E2EWorld, port: number): Promise<void> {
    const name = (await waitForReadySandbox(this)).metadata.name;
    const started = this.startCli(["workspace", "forward", `${name}.jr2`, String(port), "--stdio"]);
    try {
      started.child.stdin?.write("GET / HTTP/1.0\r\nHost: pod\r\n\r\n");
      let out = "";
      for (let i = 0; i < 300 && !out.includes("hello from the pod"); i++) {
        await sleep(100);
        out = started.output().stdout;
      }
      assert.match(out, /^HTTP\/1\.[01] 200/, `the answer came back on stdout: ${JSON.stringify(started.output())}`);
      assert.ok(out.includes("hello from the pod"));
    } finally {
      started.child.kill("SIGINT");
    }
  },
);

/** The hidden `jr2 completion __complete` for the handle of `jr2 workspace shell`, with the
 * namespace on the line ahead of the empty word that the cursor is in (ADR-0009). The lookup reads
 * the Sandbox CRs over kube, so it needs no Orchestrator. */
When("I complete a Workspace handle for jr2 workspace shell", async function (this: E2EWorld): Promise<void> {
  const words = ["completion", "__complete", "workspace", "shell", "-n", this.namespace!, ""];
  const r = await this.runCli(words, { namespaced: false });
  assert.equal(r.code, 0, r.stderr);
});

Then("the completions include the run's handle", async function (this: E2EWorld): Promise<void> {
  const got = (this.last?.stdout ?? "").split("\n").filter((w) => w !== "");
  const handle = await handleOf(this);
  assert.ok(got.includes(handle), `the completions include "${handle}": ${JSON.stringify(got)}`);
});

When("I remove the run's Workspace with jr2 workspace rm", async function (this: E2EWorld): Promise<void> {
  await this.runCli(["workspace", "rm", await handleOf(this)]);
});

When("I cancel the run and keep its Workspace", async function (this: E2EWorld): Promise<void> {
  await handleOf(this); // the handle, while the CR still names it
  const r = await this.runCli(["send", this.runId!, "--event", "CANCEL", "--keep"]);
  assert.equal(r.code, 0, `jr2 send CANCEL --keep failed: ${r.stderr}`);
  // Bound below the step's timeout, so that a failure gives this step's words and not a timeout.
  let last = "";
  for (const started = Date.now(); Date.now() - started < 100_000; await sleep(500)) {
    const s = await this.runCli(["status", this.runId!]);
    last = s.code === 0 ? this.resultJson<{ status: string }>().status : `exit ${s.code}: ${s.stderr.trim()}`;
    if (last === "cancelled") return;
  }
  throw new Error(`run ${this.runId} did not end as cancelled; the last status read: ${last}`);
});

/** `jr2 logs <run>` reads what the Orchestrator keeps (ADR-0023). The Harness sends each entry at the
 * end of its model message, or within about a second: the step reads again for a while. */
Then(
  "jr2 logs of the run prints a {string} line holding {string}",
  { timeout: 120_000 },
  async function (this: E2EWorld, agent: string, text: string): Promise<void> {
    let last = "";
    const started = Date.now();
    // Bound below the step's timeout, so that a failure gives this step's words and not a timeout.
    while (Date.now() - started < 100_000) {
      const r = await this.runCli(["logs", this.runId!]);
      last = `${r.stdout}${r.stderr}`;
      if (r.code === 0 && r.stdout.split("\n").some((l) => l.startsWith(`[${agent}] `) && l.includes(text))) return;
      await sleep(1000);
    }
    throw new Error(`jr2 logs never printed a ${agent} line holding "${text}":\n${last}`);
  },
);

When("the run's Sandbox pod is killed in the Turn", { timeout: 180_000 }, async function (this: E2EWorld) {
  const pod = (await waitForReadySandbox(this)).metadata.name;
  const uid = (await kubectl(this, ["get", "pod", pod, "-o", "jsonpath={.metadata.uid}"])).trim();
  await kubectl(this, ["delete", "pod", pod, "--grace-period=0", "--force", "--wait=true"]);
  // The pod that held the Turn is gone: none of that name, or a new one.
  const now = (await kubectl(this, ["get", "pod", pod, "-o", "jsonpath={.metadata.uid}", "--ignore-not-found"])).trim();
  assert.notEqual(now, uid, "the pod that held the Turn is gone");
});
