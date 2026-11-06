// The run listing (ADR-0009): `GET /runs` reads its query (`status`, `workflow`, `since`, `cursor`,
// `limit`), lists the live runs from the registry and the ended runs from the store's listing
// columns in one order, newest start first, a page at a time, and each item is a summary. A drifted
// run is listed with its reason (ADR-0030). Socket-free: the route through `app.request`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { SqliteSnapshotStore } from "../src/snapshot-store.ts";
import { decodeCursor, encodeCursor, parseRunListQuery, RUNS_PAGE_MAX, type RunSummary } from "../src/run-list.ts";
import { checkRuns, retainMs } from "../src/config.ts";
import { gatedDef, mkStore, tick } from "./_fixtures.ts";
import { createMachine } from "xstate";
import { grantOpens } from "../src/tokens.ts";

const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const HOUR = 3_600_000;

// --- the query --------------------------------------------------------------------------------

test("the query: live by default; ended, all, and a comma list of statuses", () => {
  assert.deepEqual(parseRunListQuery({}, NOW), { live: true, limit: 50 });
  const ended = parseRunListQuery({ status: "ended" }, NOW);
  assert.ok(!("error" in ended) && !ended.live && ended.ended?.includes("drifted") && ended.ended.includes("done"));
  const all = parseRunListQuery({ status: "all" }, NOW);
  assert.ok(!("error" in all) && all.live && all.ended?.includes("cancelled"));
  assert.deepEqual(parseRunListQuery({ status: "done,drifted" }, NOW), {
    live: false,
    ended: ["done", "drifted"],
    limit: 50,
  });
  assert.deepEqual(parseRunListQuery({ status: "active,failed", workflow: "ping" }, NOW), {
    live: true,
    ended: ["failed"],
    workflow: "ping",
    limit: 50,
  });
});

test("the query refuses a status, a since, a cursor and a limit that it cannot read", () => {
  const bad = (q: Record<string, string>) => {
    const parsed = parseRunListQuery(q, NOW);
    return "error" in parsed ? parsed.error : "";
  };
  assert.match(bad({ status: "parked" }), /status "parked" is not one jr2 lists — use live, ended, all/);
  assert.match(
    bad({ since: "yesterday" }),
    /since "yesterday" is not a duration \(such as 2h or 7d\) or an ISO-8601 time/,
  );
  for (const since of ["7", "5", "July 1"]) {
    assert.match(
      bad({ since }),
      new RegExp(`since "${since}" is not a duration`),
      `${since} is refused, not read as a date`,
    );
  }
  assert.match(bad({ cursor: "nope" }), /cursor is not one that GET \/runs gave/);
  assert.match(bad({ limit: "0" }), /limit is a whole number from 1 to 500/);
  assert.match(bad({ limit: String(RUNS_PAGE_MAX + 1) }), /limit/);
  assert.match(bad({ limit: "2.5" }), /limit/);
});

test("since is a duration back from now, or an ISO-8601 time", () => {
  const back = parseRunListQuery({ since: "2h" }, NOW);
  assert.ok(!("error" in back));
  assert.equal(back.since, new Date(NOW - 2 * HOUR).toISOString());
  const week = parseRunListQuery({ since: "1w" }, NOW);
  assert.ok(!("error" in week));
  assert.equal(week.since, new Date(NOW - 7 * 24 * HOUR).toISOString());
  const at = parseRunListQuery({ since: "2026-11-01" }, NOW);
  assert.ok(!("error" in at));
  assert.equal(at.since, "2026-11-01T00:00:00.000Z");
  const far = parseRunListQuery({ since: "2000000000d" }, NOW);
  assert.ok(!("error" in far), "a duration longer than the clock is not a 500");
  assert.equal(far.since, "1970-01-01T00:00:00.000Z", "it lists every run");
});

test("a cursor reads back to the run it was made after, and nothing else reads as one", () => {
  const run = { startedAt: "2026-11-05T10:00:00.000Z", runId: "r-1" };
  assert.deepEqual(decodeCursor(encodeCursor(run)), run);
  assert.equal(decodeCursor(Buffer.from("[1,2]").toString("base64url")), undefined);
  assert.equal(decodeCursor(Buffer.from('["not a time","r"]').toString("base64url")), undefined);
});

// --- runs.retain --------------------------------------------------------------------------------

test("runs.retain: 30 days by default, at least 1h, and no upper limit (ADR-0065)", () => {
  assert.equal(retainMs(undefined), 30 * 24 * HOUR);
  assert.equal(retainMs({ retain: "36h" }), 36 * HOUR);
  assert.equal(retainMs({ retain: "90m" }), 90 * 60_000);
  assert.equal(retainMs({ retain: "520w" }), 520 * 7 * 24 * HOUR, "ten years is allowed");
  checkRuns({ retain: "1h", volume: "5Gi" }, "jr2.config.ts");
  checkRuns({}, "jr2.config.ts");
  assert.throws(() => checkRuns({ retain: "59m" }, "jr2.config.ts"), {
    message:
      'jr2.config.ts at runs.retain: "59m" is shorter than 1h — jr2 keeps an ended run for at least 1h (ADR-0065)',
  });
  assert.throws(() => checkRuns({ retain: "30 days" }, "f"), /at runs\.retain: "30 days" is not a duration/);
  assert.throws(() => checkRuns({ retain: "3600s" }, "f"), /is not a duration — a number and m, h, d or w/);
  assert.throws(() => checkRuns({ retain: 30 }, "f"), /at runs\.retain: 30 is not a duration/);
  assert.throws(() => checkRuns({ volume: "5GB" }, "f"), /at runs\.volume: "5GB" is not a storage quantity/);
  assert.throws(() => checkRuns({ volume: "0Gi" }, "f"), /at runs\.volume/);
  assert.throws(
    () => checkRuns({ volume: "5" }, "f"),
    /at runs\.volume: "5" is not a storage quantity — a number and a unit/,
  );
  assert.throws(() => checkRuns({ keep: "30d" }, "f"), /at runs\.keep: not a field/);
  assert.throws(() => checkRuns("30d", "f"), /at runs: expected an object/);
});

// --- the store's listing ------------------------------------------------------------------------

/** A blob as the host writes it, with the fields the listing reads. */
const blob = (workflow: string, startedAt: string, extra: Record<string, unknown> = {}) => ({
  workflow,
  instanceId: `i-${workflow}`,
  startedAt,
  snapshot: { status: "done", value: "end", context: {} },
  ...extra,
});

const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

test("the store lists ended runs newest first, off its columns, with each filter", async () => {
  const store = await mkStore();
  await store.save("a", blob("ping", at(5)), "done");
  await store.save("b", blob("ping", at(4), { failure: { reason: "no reviewer" } }), "failed");
  await store.save(
    "c",
    blob("plan/weekly", at(3), { assembly: "h1", startedBy: { kind: "jr2", why: "boot" } }),
    "done",
  );
  await store.save("d", blob("other", at(2), { fault: "boom" }), "error");
  await store.save("e", blob("ping", at(1)), "live");
  await store.save("f", blob("ping", at(6)), "live");
  await store.markDrifted("f", "its Machine's shape changed");
  await store.markLost("g", "no row before"); // no snapshot: not listed

  const ids = async (q: Parameters<typeof store.ended>[0]) => (await store.ended(q)).map((r) => r.runId);
  assert.deepEqual(await ids({ limit: 10 }), ["d", "c", "b", "a", "f"], "the live row is not ended");
  assert.deepEqual(await ids({ statuses: ["failed", "drifted"], limit: 10 }), ["b", "f"]);
  assert.deepEqual(await ids({ workflow: "ping", limit: 10 }), ["b", "a", "f"]);
  assert.deepEqual(await ids({ workflows: ["plan", "other"], limit: 10 }), ["d", "c"], "a grant opens its Charts");
  assert.deepEqual(await ids({ workflows: [], limit: 10 }), []);
  assert.deepEqual(await ids({ since: at(3.5), limit: 10 }), ["d", "c"]);
  assert.deepEqual(await ids({ after: { startedAt: at(3), runId: "c" }, limit: 2 }), ["b", "a"]);

  const rows = await store.ended({ limit: 10 });
  const byId = new Map(rows.map((r) => [r.runId, r]));
  assert.equal(byId.get("b")?.reason, "no reviewer", "a failed run's reason is its Failure's");
  assert.equal(byId.get("d")?.reason, "boom", "an errored run's reason is its fault");
  assert.equal(byId.get("f")?.reason, "its Machine's shape changed", "a drifted run's reason is the store's");
  assert.equal(byId.get("f")?.status, "drifted");
  assert.deepEqual(
    { assembly: byId.get("c")?.assembly, startedBy: byId.get("c")?.startedBy, startedAt: byId.get("c")?.startedAt },
    { assembly: "h1", startedBy: { kind: "jr2", why: "boot" }, startedAt: at(3) },
  );
  assert.ok(byId.get("a")!.endedAt >= byId.get("a")!.startedAt, "endedAt is the terminal write");
});

test("the store's grant filter is the rule of `callerMay`, on wrapper, Chart and other names (ADR-0078)", async () => {
  const store = await mkStore();
  const names = ["plan", "plan/weekly", "plan/x/y", "planner", "planner/weekly", "other", "other/plan", "/plan"];
  for (const [i, workflow] of names.entries()) {
    await store.save(`r${i}`, blob(workflow, at(i + 1)), "done");
  }
  for (const grant of [["plan"], ["plan/weekly"], ["planner", "other"], ["/plan"], ["plan", "other/plan"]]) {
    const listed = (await store.ended({ workflows: grant, limit: 50 })).map((r) => r.workflow).sort();
    const opened = names.filter((w) => grantOpens(grant, w)).sort();
    assert.deepEqual(listed, opened, `grant ${JSON.stringify(grant)}`);
  }
});

test("a volume an older store wrote gains the listing columns, filled from each blob", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-list-"));
  const path = join(dir, "state.db");
  try {
    // The table as it was before the listing columns.
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE machine_snapshots (run_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'live',
      snapshot TEXT, reason TEXT, updated_at TEXT, dispatch_effect TEXT, dispatch_workflow TEXT)`);
    const { startedAt: _drop, ...noStart } = blob("ping", at(9));
    old
      .prepare(`INSERT INTO machine_snapshots (run_id, status, snapshot, updated_at) VALUES (?, 'done', ?, ?)`)
      .run("old-run", JSON.stringify(noStart), at(8));
    old.close();

    const store = new SqliteSnapshotStore(path);
    await store.init();
    const [row] = await store.ended({ limit: 10 });
    assert.deepEqual(
      [row?.runId, row?.workflow, row?.startedAt],
      ["old-run", "ping", at(8)],
      "no start: its last write",
    );
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a row that an older image writes after the columns exist is listed on the next boot (ADR-0069)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jr2-list-"));
  const path = join(dir, "state.db");
  try {
    const store = new SqliteSnapshotStore(path);
    await store.init();
    await store.save("kept", blob("ping", at(5)), "live");
    await store.close();

    // An older image in the Kit bump window: it writes the columns it knows, and no others.
    const old = new DatabaseSync(path);
    old
      .prepare(`INSERT INTO machine_snapshots (run_id, status, snapshot, updated_at) VALUES (?, 'done', ?, ?)`)
      .run("rolled-back", JSON.stringify(blob("ping", at(4))), at(3));
    old
      .prepare(`UPDATE machine_snapshots SET status = 'failed', snapshot = ?, updated_at = ? WHERE run_id = ?`)
      .run(JSON.stringify(blob("ping", at(5), { failure: { reason: "tests failed" } })), at(2), "kept");
    old.close();

    const again = new SqliteSnapshotStore(path);
    await again.init();
    const rows = await again.ended({ limit: 10 });
    assert.deepEqual(
      rows.map((r) => [r.runId, r.status, r.startedAt, r.reason]),
      [
        ["rolled-back", "done", at(4), undefined],
        ["kept", "failed", at(5), "tests failed"],
      ],
      "the new row is listed, and the updated row's summary is current",
    );
    // A boot after that has nothing to fill: a drift mark keeps the columns current.
    await again.markDrifted("rolled-back", "assembly gone");
    await again.close();
    const third = new SqliteSnapshotStore(path);
    await third.init();
    const [drifted] = await third.ended({ statuses: ["drifted"], limit: 10 });
    assert.deepEqual([drifted?.runId, drifted?.reason], ["rolled-back", "assembly gone"]);
    await third.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- the route ------------------------------------------------------------------------------------

const loop = createMachine({ id: "loop", initial: "working", states: { working: {} } });

/** A host whose clock moves one minute each read, so each run has its own start. */
async function mkListing() {
  const store = await mkStore();
  let clock = NOW - 24 * HOUR;
  const host = new RunHost({ store, now: () => (clock += 60_000) });
  host.register(gatedDef());
  host.register({ name: "loop", machine: loop, provide: () => ({}) });
  const app = createApp(host);
  const page = async (qs = "") => {
    const res = await app.request(`/runs${qs}`);
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as { runs: RunSummary[]; next?: string };
  };
  return { host, store, app, page };
}

test("GET /runs lists live runs by default, each a summary with its open Gates", async () => {
  const { host, page } = await mkListing();
  const gated = await host.start("gated", {}, { startedBy: { kind: "jr2", why: "boot" } });
  const idle = await host.start("loop");
  await tick();
  const { runs, next } = await page();
  assert.equal(next, undefined);
  assert.deepEqual(
    runs.map((r) => r.runId),
    [idle.runId, gated.runId],
    "newest start first",
  );
  const [loopRun, gatedRun] = runs;
  assert.deepEqual(Object.keys(gatedRun!).sort(), [
    "openGates",
    "runId",
    "startedAt",
    "startedBy",
    "status",
    "workflow",
  ]);
  assert.equal(gatedRun!.openGates, 1);
  assert.equal(gatedRun!.status, "active");
  assert.equal(loopRun!.openGates, 0);
  assert.ok(!("context" in gatedRun!), "a summary carries no context");
});

test("GET /runs?status= lists the history; ended and live join in one order", async () => {
  const { host, page } = await mkListing();
  const first = await host.start("loop");
  const second = await host.start("gated");
  const third = await host.start("loop");
  await host.cancel(second.runId);
  await tick();

  assert.deepEqual(
    (await page()).runs.map((r) => r.runId),
    [third.runId, first.runId],
  );
  const ended = (await page("?status=ended")).runs;
  assert.deepEqual(
    ended.map((r) => [r.runId, r.status, r.openGates]),
    [[second.runId, "cancelled", 0]],
  );
  assert.ok(ended[0]!.endedAt, "an ended run has its end");
  assert.deepEqual(
    (await page("?status=all")).runs.map((r) => r.runId),
    [third.runId, second.runId, first.runId],
  );
  assert.deepEqual(
    (await page("?status=all&workflow=gated")).runs.map((r) => r.runId),
    [second.runId],
  );
  assert.deepEqual((await page("?status=done")).runs, []);
});

test("GET /runs pages with a cursor across the live and the ended runs", async () => {
  const { host, page } = await mkListing();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.unshift((await host.start("loop")).runId);
  await host.cancel(ids[1]!);
  await host.cancel(ids[3]!);
  await tick();

  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const p = await page(`?status=all&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    seen.push(...p.runs.map((r) => r.runId));
    cursor = p.next;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, ids, "every run once, newest first");
  assert.equal(pages, 3);
});

test("GET /runs?since= lists only the runs that started since then", async () => {
  const { host, page } = await mkListing();
  await host.start("loop");
  const later = await host.start("loop");
  const startedAt = (await page()).runs.find((r) => r.runId === later.runId)!.startedAt;
  assert.deepEqual(
    (await page(`?since=${encodeURIComponent(startedAt)}`)).runs.map((r) => r.runId),
    [later.runId],
  );
});

test("GET /runs lists a drifted run with its reason (ADR-0030)", async () => {
  const { store, page } = await mkListing();
  await store.save("drift-1", blob("gated", at(30), { machine: "old" }), "live");
  await store.markDrifted("drift-1", "its Machine's shape changed since the run started");
  const [run] = (await page("?status=drifted")).runs;
  assert.deepEqual(
    [run?.runId, run?.status, run?.reason],
    ["drift-1", "drifted", "its Machine's shape changed since the run started"],
  );
});

test("GET /runs lists a live row that waits for its restore, with the hosted runs (ADR-0069)", async () => {
  const { host, store, page } = await mkListing();
  const hosted = await host.start("loop");
  // A row the registry does not hold: a boot deferred its restore, or the restore failed.
  await store.save("waits-1", blob("gated", at(30)), "live");
  const live = (await page()).runs;
  assert.deepEqual(
    live.map((r) => [r.runId, r.status, r.reason]),
    [
      [hosted.runId, "active", undefined],
      ["waits-1", "active", "waiting for restore"],
    ],
  );
  assert.equal(live[1]!.endedAt, undefined);
  assert.deepEqual(
    (await page("?status=all&workflow=gated")).runs.map((r) => r.runId),
    ["waits-1"],
  );
  assert.deepEqual((await page("?status=ended")).runs, [], "it is not an ended run");
  const first = await page("?limit=1");
  assert.deepEqual(
    first.runs.map((r) => r.runId),
    [hosted.runId],
  );
  assert.deepEqual(
    (await page(`?limit=1&cursor=${first.next}`)).runs.map((r) => r.runId),
    ["waits-1"],
  );
});

test("GET /runs refuses a query that it cannot read: 400, with the reason", async () => {
  const { app } = await mkListing();
  const res = await app.request("/runs?status=parked");
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /status "parked"/);
});
