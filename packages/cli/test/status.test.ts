// `jr2 status` with no run named (ADR-0069): one line per Assembly a live run holds, the current
// one first and so marked. A run holds the Assembly it started under, so a publish that reshapes a
// Workflow leaves the previous Assembly on the volume while a run still holds it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderInstanceStatus } from "../src/commands/status.ts";

const lines = (out: string): string[] => out.split("\n").filter((l) => l.startsWith("assembly:"));

test("the held Assemblies print one line each, the current one first and marked", () => {
  const out = renderInstanceStatus({
    assembly: {
      kitVersion: "0.3.0",
      current: { hash: "bbbbbbbbbbbb", kitVersion: "0.3.0", workflows: ["ping"] },
      // Listed out of order on purpose: the current line comes first whatever the server sends.
      held: [
        { hash: "aaaaaaaaaaaa", kitVersion: "0.3.0", runs: ["r1"] },
        { hash: "bbbbbbbbbbbb", kitVersion: "0.3.0", runs: [] },
        { hash: "cccccccccccc", kitVersion: "0.3.0", runs: ["r2", "r3"] },
      ],
    },
    dataPlane: false,
    repos: [],
  });
  assert.deepEqual(lines(out), [
    "assembly: bbbbbbbbbbbb (kit v0.3.0, current), 0 live runs hold it",
    "assembly: aaaaaaaaaaaa (kit v0.3.0), 1 live run holds it",
    "assembly: cccccccccccc (kit v0.3.0), 2 live runs hold it",
  ]);
});

test("the current Assembly prints even when no run holds it and `held` omits it", () => {
  const out = renderInstanceStatus({
    assembly: {
      kitVersion: "0.3.0",
      current: { hash: "bbbbbbbbbbbb", kitVersion: "0.3.0", workflows: ["ping"] },
      held: [],
    },
    dataPlane: true,
    repos: [],
  });
  assert.deepEqual(lines(out), ["assembly: bbbbbbbbbbbb (kit v0.3.0, current), 0 live runs hold it"]);
});

test("with no current Assembly, the held ones still print after the `none` line", () => {
  // A boot with no current Assembly restores nothing; the Assemblies its waiting runs hold are still listed.
  const out = renderInstanceStatus({
    assembly: {
      kitVersion: "0.3.0",
      current: null,
      held: [{ hash: "aaaaaaaaaaaa", kitVersion: "0.3.0", runs: ["r1"] }],
    },
    dataPlane: true,
    repos: [],
  });
  assert.deepEqual(lines(out), [
    "assembly: none — `jr2 up` publishes",
    "assembly: aaaaaaaaaaaa (kit v0.3.0), 1 live run holds it",
  ]);
});

test("an Assembly answer that cannot be read is one line naming the reason", () => {
  const out = renderInstanceStatus({
    assembly: { error: "GET /assembly answered HTTP 500" },
    dataPlane: true,
    repos: [],
  });
  assert.deepEqual(lines(out), ["assembly: unknown — GET /assembly answered HTTP 500"]);
});
