// Named Charts (ADR-0070), socket-free: the Chart-file discovery one level below `workflows/*.ts`,
// the runtime Charts on the volume, what makes a Machine a Chart wrapper, the door's refusals for
// a Chart file, and the registry that re-admits every named Chart when an Assembly binds. The
// registry speaks to the host through two methods, so a recording fake stands in for the host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitUnder,
  chartFileRefusals,
  chartName,
  chartsDir,
  chartWrapperOf,
  discoverChartFiles,
  NamedChartError,
  NamedCharts,
  readChartFiles,
  readRuntimeCharts,
  removeRuntimeChart,
  splitChartName,
  writeRuntimeChart,
  type ChartHost,
  type NamedChart,
} from "../src/charts.ts";
import { chartHash, type ChartText } from "../src/chart.ts";
import { openBody } from "../src/open-body.ts";
import { jr2Setup } from "../src/setup.ts";
import { chartedSrc, machineOf, plainSrc, reviewLoop } from "./_assembly.ts";

/** Write `files` under a fresh temp directory. */
async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jr2-charts-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(root, rel, ".."), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  return root;
}

/** A host that records what the registry tells it. */
function fakeHost(): ChartHost & { charts: Map<string, unknown>; log: string[] } {
  const charts = new Map<string, unknown>();
  const log: string[] = [];
  return {
    charts,
    log,
    registerChart(def) {
      charts.set(def.name, def);
      log.push(`register ${def.name}`);
    },
    unregisterChart(wrapper, name) {
      charts.delete(chartName(wrapper, name));
      log.push(`unregister ${chartName(wrapper, name)}`);
    },
  } as ChartHost & { charts: Map<string, unknown>; log: string[] };
}

test("a Chart's Workflow name is <wrapper>/<name>, and a Machine's name splits to nothing", () => {
  assert.equal(chartName("task", "review-loop"), "task/review-loop");
  assert.deepEqual(splitChartName("task/review-loop"), { wrapper: "task", name: "review-loop" });
  assert.equal(splitChartName("task"), undefined);
});

test("discovery: Chart files one level below workflows/, and any other file there is named in a warning", async () => {
  const root = await tree({
    "workflows/charted.ts": "",
    "workflows/charted/loop.chart.json": "{}",
    "workflows/charted/sample.chart.json": "{}",
    "workflows/charted/notes.md": "",
    "workflows/charted/deeper/x.chart.json": "{}",
    "workflows/_lib/helper.ts": "",
    "workflows/loose.chart.json": "{}",
  });
  const warnings: string[] = [];
  const found = await discoverChartFiles(root, (line) => warnings.push(line));
  assert.deepEqual(
    found.map((f) => `${f.wrapper}/${f.name}`),
    ["charted/loop", "charted/sample"],
  );
  assert.equal(found[0]!.file, join(root, "workflows", "charted", "loop.chart.json"));
  assert.equal(warnings.length, 3, warnings.join("\n"));
  assert.match(warnings.join("\n"), /workflows\/charted\/notes\.md: ignored/);
  assert.match(warnings.join("\n"), /workflows\/charted\/deeper: ignored/);
  // A Chart file at the flat level is in the Assembly and registers nothing: it is named.
  assert.match(
    warnings.join("\n"),
    /workflows\/loose\.chart\.json: ignored — a Chart file sits in workflows\/<wrapper>/,
  );
  assert.ok(!warnings.some((w) => w.includes("_lib")), "a `_` directory is a helper directory, not a wrapper's");
  assert.deepEqual(await discoverChartFiles(await tree({})), [], "an Assembly with no workflows/ has none");
});

test("discovery: a docker context a Machine names beside its module is read by jr2, so it is not named in a warning", async () => {
  // ADR-0037/0049: `import.meta.resolve("./python")` in workflows/pytest.ts is workflows/python/,
  // which ADR-0070's discovery also reads as a wrapper's directory.
  const root = await tree({
    "workflows/pytest.ts": "",
    "workflows/python/Dockerfile": "FROM node:24-slim",
    "workflows/python/requirements.txt": "",
    "workflows/images/shell/Dockerfile": "FROM node:24-slim",
    "workflows/images/notes.md": "",
    "workflows/charted/notes.md": "",
  });
  const contexts = [join(root, "workflows", "python"), join(root, "workflows", "images", "shell")];
  const warnings: string[] = [];
  assert.deepEqual(await discoverChartFiles(root, (line) => warnings.push(line), contexts), []);
  // A folder that holds a context is read in part; its other files are still not a wrapper's.
  assert.deepEqual(warnings.sort(), [
    "workflows/charted/notes.md: ignored — a wrapper's directory holds Chart files (<name>.chart.json) and nothing else jr2 reads (ADR-0070)",
    "workflows/images/notes.md: ignored — a wrapper's directory holds Chart files (<name>.chart.json) and nothing else jr2 reads (ADR-0070)",
  ]);
  // With no contexts the same tree names the context's files: the case the walk of a reader hit.
  const named: string[] = [];
  await discoverChartFiles(root, (line) => named.push(line));
  assert.ok(
    named.some((w) => w.startsWith("workflows/python/Dockerfile: ignored")),
    named.join("\n"),
  );
});

test("a Chart file that is not JSON is read with its error, for the door to name", async () => {
  const root = await tree({ "workflows/charted/bad.chart.json": "{ nope" });
  const [file] = await readChartFiles(root, () => {});
  assert.equal(file!.path, "workflows/charted/bad.chart.json");
  assert.equal(file!.text, undefined);
  assert.match(file!.error!, /^not JSON/);
});

test("runtime Charts on the volume: written durably, read back with origin and hash, removed", async () => {
  const dir = await tree({});
  const text = (await reviewLoop()) as ChartText;
  const chart: NamedChart = { wrapper: "charted", name: "loop", text, hash: chartHash(text), origin: "runtime" };
  await writeRuntimeChart(dir, chart);
  assert.deepEqual(await readdir(join(chartsDir(dir), "charted")), ["loop.chart.json"], "no temp file is left");
  assert.deepEqual(await readRuntimeCharts(dir), [chart]);
  assert.equal(await removeRuntimeChart(dir, "charted", "loop"), true);
  assert.equal(await removeRuntimeChart(dir, "charted", "loop"), false);
  assert.deepEqual(await readRuntimeCharts(dir), []);
  assert.ok(!existsSync(join(chartsDir(dir), "charted")), "an emptied wrapper directory goes too");
});

test("a first write under a wrapper makes the new directories durable, and a load removes a crashed write's temp file", async () => {
  const dir = await tree({ ".jr2/charts/charted/loop.chart.json.tmp-0123abcd": "{ torn" });
  const charts = new NamedCharts({ dir, host: fakeHost() });
  await charts.load();
  assert.deepEqual(await readdir(join(chartsDir(dir), "charted")), [], "the temp file of a crashed write is gone");
  const fresh = await tree({});
  const text = (await reviewLoop()) as ChartText;
  await writeRuntimeChart(fresh, { wrapper: "w", name: "x", text, hash: chartHash(text), origin: "runtime" });
  assert.deepEqual(await readdir(join(chartsDir(fresh), "w")), ["x.chart.json"]);
});

test("a runtime Chart that is not JSON on the volume is read unrunnable, and kept", async () => {
  const dir = await tree({ ".jr2/charts/charted/torn.chart.json": "{ torn" });
  const [c] = await readRuntimeCharts(dir);
  assert.equal(c!.name, "torn");
  assert.match(c!.unrunnable!, /not JSON/);
  assert.ok(existsSync(join(chartsDir(dir), "charted", "torn.chart.json")));
});

test("a Chart wrapper is read from its Open body and its door's chartSchema fields", async () => {
  const w = chartWrapperOf(await machineOf(chartedSrc()));
  assert.ok(w);
  assert.equal(w.body, "body");
  assert.deepEqual(w.chartFields, ["chart"]);
  assert.deepEqual(w.inputKeys, ["task"], "the door's fields, less the Chart field and the placement");
  assert.deepEqual(Object.keys(w.bodies[0]!.lent.actors), ["coder"]);
  assert.deepEqual(Object.keys(w.bodies[0]!.lent.guards), ["underLimit"]);
  assert.deepEqual(chartWrapperOf(await machineOf(chartedSrc({ door: false })))?.chartFields, []);
  assert.equal(chartWrapperOf(await machineOf(plainSrc("plain"))), undefined);
});

test("the door's Chart-file refusals name the file: a non-wrapper, no Chart door, no wrapper, a bad name, a refusal", async () => {
  const text = await reviewLoop();
  const workflows = [
    { name: "charted", machine: await machineOf(chartedSrc()) },
    { name: "inner", machine: await machineOf(chartedSrc({ door: false })) },
    { name: "plain", machine: await machineOf(plainSrc("plain")) },
    { name: "dropped", machine: await machineOf(chartedSrc({ lendCoder: false })) },
  ];
  const file = (wrapper: string, name: string, t: unknown = text) => ({
    wrapper,
    name,
    path: `workflows/${wrapper}/${name}.chart.json`,
    text: t,
  });
  assert.deepEqual(chartFileRefusals([file("charted", "loop")], workflows), [], "the fixture Chart admits");
  const [plain] = chartFileRefusals([file("plain", "loop")], workflows);
  assert.match(plain!, /^workflows\/plain\/loop\.chart\.json: workflow "plain" is no Chart wrapper/);
  const [inner] = chartFileRefusals([file("inner", "loop")], workflows);
  assert.match(inner!, /^workflows\/inner\/loop\.chart\.json: workflow "inner" has no Chart door/);
  const [missing] = chartFileRefusals([file("gone", "loop")], workflows);
  assert.match(
    missing!,
    /^workflows\/gone\/loop\.chart\.json: no workflows\/gone\.ts registers the Chart wrapper "gone"/,
  );
  const [named] = chartFileRefusals([file("charted", "Loop")], workflows);
  assert.match(named!, /^workflows\/charted\/Loop\.chart\.json: "Loop" is not a Chart name/);
  const dropped = chartFileRefusals([file("dropped", "loop")], workflows);
  assert.ok(dropped.length >= 1);
  assert.ok(
    dropped.every((l) => l.startsWith("workflows/dropped/loop.chart.json: Chart refused: ")),
    dropped.join("\n"),
  );
  assert.match(dropped.join("\n"), /coder/, "the refusal names the slot the wrapper stopped lending");
});

test("the registry: a runtime Chart survives a reload, and a bind that drops a lent slot marks it unrunnable and keeps it", async () => {
  const dir = await tree({});
  const text = await reviewLoop();
  const host = fakeHost();
  const charts = new NamedCharts({ dir, host });
  charts.bind({ workflows: [{ name: "charted", machine: await machineOf(chartedSrc()) }], files: [], assembly: "a1" });
  const put = await charts.put("charted", "loop", text);
  assert.deepEqual(put, { created: true, name: "charted/loop", hash: chartHash(text as ChartText) });
  assert.equal((await charts.put("charted", "loop", text)).created, false, "a second PUT replaces");
  const def = host.charts.get("charted/loop") as { assembly?: string; wrapper?: unknown; chart?: { origin: string } };
  assert.equal(def.assembly, "a1");
  assert.deepEqual(def.wrapper, { body: "body", chartFields: ["chart"] });
  assert.equal(def.chart?.origin, "runtime");

  // A restart: a new registry reads the volume and admits at the first bind.
  const host2 = fakeHost();
  const again = new NamedCharts({ dir, host: host2 });
  await again.load();
  again.bind({ workflows: [{ name: "charted", machine: await machineOf(chartedSrc()) }], files: [] });
  assert.ok(host2.charts.has("charted/loop"));
  assert.deepEqual(again.counts(), { files: 0, runtime: 1, unrunnable: [] });

  // A publish whose wrapper stops lending `coder`.
  const unrunnable = again.bind({
    workflows: [{ name: "charted", machine: await machineOf(chartedSrc({ lendCoder: false })) }],
    files: [],
  });
  assert.equal(unrunnable.length, 1);
  assert.equal(unrunnable[0]!.name, "charted/loop");
  assert.match(unrunnable[0]!.reason, /^Chart refused: .*coder/);
  assert.ok(!host2.charts.has("charted/loop"), "an unrunnable Chart is no Workflow the host starts");
  assert.ok(existsSync(join(chartsDir(dir), "charted", "loop.chart.json")), "and it stays on the volume");

  // A publish with no wrapper at all.
  const [gone] = again.bind({ workflows: [], files: [] });
  assert.match(gone!.reason, /the Chart wrapper "charted" is not in the current Assembly/);
  // And the wrapper back: runnable again.
  assert.deepEqual(
    again.bind({ workflows: [{ name: "charted", machine: await machineOf(chartedSrc()) }], files: [] }),
    [],
  );
  assert.ok(host2.charts.has("charted/loop"));
});

test("the registry: a Chart file is registered with origin file, holds its name against PUT and DELETE, and shadows a runtime Chart", async () => {
  const dir = await tree({});
  const text = await reviewLoop();
  const host = fakeHost();
  const charts = new NamedCharts({ dir, host });
  const workflows = [{ name: "charted", machine: await machineOf(chartedSrc()) }];
  charts.bind({ workflows, files: [] });
  await charts.put("charted", "sample", text);
  const file = { wrapper: "charted", name: "sample", path: "workflows/charted/sample.chart.json", text };
  const [shadowed] = charts.bind({ workflows, files: [file] });
  assert.match(shadowed!.reason, /Chart file workflows\/charted\/sample\.chart\.json holds this name/);
  assert.equal((host.charts.get("charted/sample") as { chart: { origin: string } }).chart.origin, "file");
  assert.equal(charts.get("charted/sample")?.origin, "file");
  await assert.rejects(charts.put("charted", "sample", text), (e: NamedChartError) => e.status === 409);
  await assert.rejects(
    charts.remove("charted", "sample"),
    (e: NamedChartError) => e.status === 409 && /Instance's own/.test(e.message),
  );
  assert.deepEqual(charts.counts().files, 1);
  // The file leaves the Assembly: the runtime Chart runs again.
  assert.deepEqual(charts.bind({ workflows, files: [] }), []);
  assert.equal((host.charts.get("charted/sample") as { chart: { origin: string } }).chart.origin, "runtime");
});

test("the registry refuses a PUT by status: a bad name 400, no wrapper 404, no Chart door 409, a refused text 422", async () => {
  const charts = new NamedCharts({ dir: await tree({}), host: fakeHost() });
  charts.bind({
    workflows: [
      { name: "charted", machine: await machineOf(chartedSrc()) },
      { name: "inner", machine: await machineOf(chartedSrc({ door: false })) },
      { name: "plain", machine: await machineOf(plainSrc("plain")) },
    ],
    files: [],
  });
  const text = await reviewLoop();
  const status = (p: Promise<unknown>) =>
    p.then(
      () => 0,
      (e: NamedChartError) => e.status,
    );
  assert.equal(await status(charts.put("charted", "Bad_Name", text)), 400);
  assert.equal(await status(charts.put("nope", "loop", text)), 404);
  assert.equal(await status(charts.put("inner", "loop", text)), 409);
  assert.equal(await status(charts.put("plain", "loop", text)), 409);
  await assert.rejects(
    charts.put("charted", "loop", { ...text, initial: "nowhere" }),
    (e: NamedChartError) => e.status === 422 && e.body.error === "refused" && Array.isArray(e.body.report),
  );
  assert.equal(await status(charts.remove("charted", "absent")), 404);
});

test("the listing adds each unrunnable Chart inside its wrapper's entry, or on its own when the wrapper is gone", async () => {
  const dir = await tree({});
  const charts = new NamedCharts({ dir, host: fakeHost() });
  charts.bind({ workflows: [{ name: "charted", machine: await machineOf(chartedSrc()) }], files: [] });
  await charts.put("charted", "loop", await reviewLoop());
  charts.bind({
    workflows: [{ name: "charted", machine: await machineOf(chartedSrc({ lendCoder: false })) }],
    files: [],
  });
  const base = [{ name: "charted", origin: "machine" as const, wrapper: { body: "body", oneShot: true, charts: [] } }];
  const [entry] = charts.listing(base);
  assert.equal(entry!.wrapper!.charts.length, 1);
  assert.equal(entry!.wrapper!.charts[0]!.name, "loop");
  assert.match(entry!.wrapper!.charts[0]!.unrunnable!, /coder/);
  assert.equal(base[0]!.wrapper.charts.length, 0, "the host's listing is not changed in place");
  charts.bind({ workflows: [], files: [] });
  assert.deepEqual(
    charts.listing([]).map((w) => [w.name, w.origin, typeof w.unrunnable]),
    [["charted/loop", "runtime", "string"]],
  );
});

test("one openBody() value in two Machines: each Machine's Charts are admitted against its own parts", () => {
  const body = openBody({
    lends: { guards: ["underLimit"] },
    allows: { models: ["stub/model"], workspace: ["none"] },
    ceilings: { turns: 2, wallClock: "10m", transitions: 50, fanOut: 2, size: 65536 },
  });
  const wrapper = (id: string, guards: Record<string, unknown>) =>
    jr2Setup({ events: [], actors: { body }, guards: guards as never }).createMachine({
      on: { "agent.fault": {} },
      id,
      initial: "a",
      states: { a: { invoke: { src: "body", input: {} } } },
    });
  const fa = () => true;
  const fb = () => false;
  const a = wrapper("a", { underLimit: fa });
  // The last createMachine: the slot's one stamp is B's.
  const b = wrapper("b", { underLimit: fb });
  assert.equal(chartWrapperOf(a as never)!.bodies[0]!.lent.guards.underLimit, fa, "A's Charts borrow A's guard");
  assert.equal(chartWrapperOf(b as never)!.bodies[0]!.lent.guards.underLimit, fb);
});

test("a PUT whose write a publish overtakes is judged against the Assembly bound after the write", async () => {
  const text = await reviewLoop();
  const charted = await machineOf(chartedSrc());
  const dropped = await machineOf(chartedSrc({ lendCoder: false }));

  // (a) The wrapper leaves the Assembly while the PUT writes.
  const host = fakeHost();
  const charts = new NamedCharts({ dir: await tree({}), host });
  charts.bind({ workflows: [{ name: "charted", machine: charted }], files: [] });
  const put = charts.put("charted", "loop", text);
  charts.bind({ workflows: [], files: [] });
  const got = await put;
  assert.match(got.unrunnable ?? "", /the Chart wrapper "charted" is not in the current Assembly/);
  assert.ok(!host.charts.has("charted/loop"), "nothing registered under a wrapper that is gone");
  assert.deepEqual(
    charts.unrunnable().map((u) => u.name),
    ["charted/loop"],
    "kept and listed, with its reason",
  );

  // (b) The wrapper stops lending `coder` while the PUT writes.
  const host2 = fakeHost();
  const charts2 = new NamedCharts({ dir: await tree({}), host: host2 });
  charts2.bind({ workflows: [{ name: "charted", machine: charted }], files: [] });
  const put2 = charts2.put("charted", "loop", text);
  charts2.bind({ workflows: [{ name: "charted", machine: dropped }], files: [] });
  assert.match((await put2).unrunnable ?? "", /coder/);
  assert.ok(!host2.charts.has("charted/loop"), "never registered runnable under a wrapper that refuses it");
});

test("a DELETE sent while a PUT writes runs after it: no Chart is left registered with no file", async () => {
  const dir = await tree({});
  const host = fakeHost();
  const charts = new NamedCharts({ dir, host });
  charts.bind({ workflows: [{ name: "charted", machine: await machineOf(chartedSrc()) }], files: [] });
  const put = charts.put("charted", "loop", await reviewLoop());
  const removed = charts.remove("charted", "loop");
  await put;
  await removed;
  assert.ok(!host.charts.has("charted/loop"));
  assert.ok(!existsSync(join(chartsDir(dir), "charted", "loop.chart.json")));
  assert.equal(charts.get("charted/loop"), undefined);
});

test("two Open bodies: a named Chart is admitted when one body admits it, as the start door does", () => {
  const ceilings = { turns: 2, wallClock: "10m", transitions: 50, fanOut: 2, size: 65536 } as const;
  const lends = (guards: string[]) =>
    openBody({ lends: { guards }, allows: { models: ["stub/model"], workspace: ["none"] }, ceilings });
  const machine = jr2Setup({
    events: [],
    actors: { body: lends(["underLimit"]), review: lends([]) },
    guards: { underLimit: () => true } as never,
  }).createMachine({
    on: { "agent.fault": {} },
    id: "two",
    initial: "a",
    states: { a: { invoke: { src: "body", input: {} } } },
  });
  const w = chartWrapperOf(machine as never)!;
  const text = {
    initial: "a",
    states: { a: { always: { target: "b", guard: "underLimit" } }, b: { type: "final" } },
  };
  assert.equal(admitUnder(w, text).text.initial, "a", "`body` lends the guard, so the Chart admits");
  assert.throws(
    () => admitUnder(w, { ...text, states: { ...text.states, a: { always: { target: "b", guard: "nope" } } } }),
    (e: Error & { report?: string[] }) =>
      /body "body": /.test(e.report!.join("\n")) && /body "review": /.test(e.report!.join("\n")),
  );
});
