import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, createActor, fromCallback } from "xstate";
import { serializeSnapshot, hydrateSnapshot } from "../src/durability.ts";
import { SqliteSnapshotStore } from "../src/snapshot-store.ts";

// A live, non-serializable handle: a class instance whose method JSON cannot represent.
class LiveFlue {
  cancelled = false;
  cancel() {
    this.cancelled = true;
  }
}

// A tiny machine whose context holds a live handle and which invokes a child actor with a
// serializable input that ALSO carries a live reference + a prompt to be re-attached on restore.
function buildMachine() {
  const childLogic = fromCallback(() => {});
  return setup({ actors: { child: childLogic } }).createMachine({
    context: { flue: new LiveFlue(), runId: "run-1", count: 7 },
    initial: "running",
    states: {
      running: {
        invoke: {
          id: "agent",
          src: "child",
          input: { prompt: "do the thing", flue: new LiveFlue(), attachOffset: -1 },
        },
      },
    },
  });
}

test("serialize strips live handles, sqlite round-trips, hydrate re-injects + re-attaches", async () => {
  const actor = createActor(buildMachine()).start();
  const live = actor.getPersistedSnapshot() as any;

  // Sanity: the raw persisted snapshot is NOT JSON-safe (context holds a class instance with a
  // method; structuredClone of a class instance loses the method, JSON drops it) — the live
  // child input still carries a non-data reference.
  assert.ok(live.context.flue instanceof LiveFlue);
  assert.equal(live.children.agent.snapshot.input.prompt, "do the thing");

  const serialized = serializeSnapshot(live, {
    stripContext: (ctx) => ({ ...ctx, flue: null }),
    stripChildInput: (input) => ({ ...input, flue: null }),
  }) as any;

  // The handle is stripped from BOTH the context and the child's persisted input.
  assert.equal(serialized.context.flue, null);
  assert.equal(serialized.children.agent.snapshot.input.flue, null);
  // Other serializable data survives untouched.
  assert.equal(serialized.context.count, 7);
  assert.equal(serialized.children.agent.snapshot.input.prompt, "do the thing");
  // The whole thing is now JSON-safe.
  assert.doesNotThrow(() => JSON.stringify(serialized));

  // Round-trip through the sqlite store.
  const store = new SqliteSnapshotStore(":memory:");
  await store.init();
  await store.save("run-1", serialized, "live");

  const loaded = await store.load("run-1");
  assert.ok(loaded);
  assert.equal(loaded.runId, "run-1");
  assert.equal(loaded.status, "live");
  // JSON round-trip drops `undefined`-valued keys, so compare against the normalized form.
  assert.deepEqual(loaded.snapshot, JSON.parse(JSON.stringify(serialized)));
  assert.equal(await store.load("missing"), null);

  // Hydrate: re-inject the live handle into context, and rewrite the child input so the run
  // RE-ATTACHES its stream (drop prompt, set attachOffset) instead of re-POSTing.
  const reinjected = new LiveFlue();
  const hydrated = hydrateSnapshot(loaded.snapshot, {
    injectContext: (ctx) => ({ ...ctx, flue: reinjected }),
    rewriteChildInput: (input) => {
      const { prompt: _prompt, ...rest } = input;
      return { ...rest, flue: reinjected, attachOffset: 42 };
    },
  }) as any;

  // Handle is back in context.
  assert.equal(hydrated.context.flue, reinjected);
  assert.ok(hydrated.context.flue instanceof LiveFlue);
  // Child input was rewritten for re-attach: prompt gone, attachOffset advanced, handle injected.
  assert.equal("prompt" in hydrated.children.agent.snapshot.input, false);
  assert.equal(hydrated.children.agent.snapshot.input.attachOffset, 42);
  assert.equal(hydrated.children.agent.snapshot.input.flue, reinjected);

  // The hydrated snapshot is consumable by createActor(machine, { snapshot }).
  const resumed = createActor(buildMachine(), { snapshot: hydrated }).start();
  assert.equal(resumed.getSnapshot().context.count, 7);
  assert.equal(resumed.getSnapshot().context.flue, reinjected);

  resumed.stop();
  actor.stop();

  // markLost flips status + records reason without throwing.
  await store.markLost("run-1", "sandbox CR absent");
  const lost = await store.load("run-1");
  assert.ok(lost);
  assert.equal(lost.status, "lost");
  assert.equal(lost.reason, "sandbox CR absent");

  await store.close();
});
