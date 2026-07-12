// Visualizer HTTP surface: the Machine-structure route delegates to `RunHost.machine`, and the
// `/viz/*` routes serve the page's shipped assets — including the vendored elkjs bundle resolved
// through this package's own dep edge (the length assertion pins that resolution under pnpm).

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { codingDef, mkStore } from "./_fixtures.ts";
import type { MachineDoc } from "../src/machine-doc.ts";

async function mkApp() {
  const host = new RunHost({ store: await mkStore() });
  host.register(codingDef(new Map()));
  return createApp(host);
}

test("GET /workflows/:name/machine serves the registered Machine's structure", async () => {
  const app = await mkApp();
  const res = await app.request("/workflows/coding/machine");
  assert.equal(res.status, 200);
  const doc = (await res.json()) as MachineDoc;
  assert.equal(doc.workflow, "coding");
  assert.equal(doc.root.id, doc.id);
  assert.ok(doc.root.states.length > 0, "top-level states present");
  assert.ok(doc.transitions.length > 0, "transitions present");
});

test("GET /workflows/:name/machine on an unknown workflow is a 404", async () => {
  const app = await mkApp();
  const res = await app.request("/workflows/nope/machine");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'no workflow "nope"' });
});

test("GET /viz/:name serves the page shell for any name", async () => {
  const app = await mkApp();
  for (const path of ["/viz/coding", "/viz/not-a-workflow"]) {
    const res = await app.request(path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /machine-svg/);
  }
});

test("GET /viz/assets/* serves the page's script, styles, and the vendored elkjs bundle", async () => {
  const app = await mkApp();

  const js = await app.request("/viz/assets/main.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(await js.text(), /workflows\/.*machine/);

  const css = await app.request("/viz/assets/style.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);

  const elk = await app.request("/viz/assets/elk.js");
  assert.equal(elk.status, 200);
  assert.match(elk.headers.get("content-type") ?? "", /text\/javascript/);
  assert.ok((await elk.text()).length > 100_000, "the bundled layout engine, not a stub");
});
