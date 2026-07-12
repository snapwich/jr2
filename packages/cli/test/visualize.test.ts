// `j2 visualize` — the attach path against a socket-free app (`io.fetch` + `J2_URL`), per the
// output discipline: stdout carries the one `{ url, workflow }` JSON line, stderr the activity.
// The ephemeral-boot path owns signals and blocks forever, so it is exercised e2e (like `dev`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.ts";
import type { Io } from "../src/output.ts";
import { mkHarness } from "./_fixtures.ts";

function mkIo(over: Partial<Io>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { stdout: (s) => out.push(s), stderr: (s) => err.push(s), env: {}, cwd: "/", ...over };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

async function mkVizIo() {
  const { app } = await mkHarness();
  return mkIo({
    env: { J2_URL: "http://test" },
    fetch: (url, init) => Promise.resolve(app.request(url, init)),
  });
}

test("visualize attaches and prints the page URL as the one stdout result", async () => {
  const { io, out, err } = await mkVizIo();
  assert.equal(await main(["visualize", "feed", "--no-open"], io), 0);
  const printed = JSON.parse(out().trim()) as { url: string; workflow: string };
  assert.equal(printed.workflow, "feed");
  assert.equal(printed.url, "http://test/viz/feed");
  assert.match(err(), /visualizing "feed"/);
});

test("visualize on an unknown workflow → exit 1 with the available list", async () => {
  const { io, out, err } = await mkVizIo();
  assert.equal(await main(["visualize", "nope", "--no-open"], io), 1);
  assert.equal(out(), "", "no stdout result on failure");
  assert.match(err(), /no workflow "nope" — available: feed, loop/);
});

test("visualize without a workflow → usage, exit 2", async () => {
  const { io, err } = await mkVizIo();
  assert.equal(await main(["visualize"], io), 2);
  assert.match(err(), /usage: j2 visualize <workflow>/);
});

test("visualize with an explicit address that doesn't answer → hard error, exit 1", async () => {
  const { io, err } = mkIo({
    env: { J2_URL: "http://test" },
    fetch: () => Promise.reject(new Error("connect ECONNREFUSED")),
  });
  assert.equal(await main(["visualize", "feed", "--no-open"], io), 1);
  assert.match(err(), /error:/);
});
