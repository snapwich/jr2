// The slot data of the pinned Envoy's validation (`support/custodian-slots.ts`) is a copy of the
// data of the renderer's unit tests (`packages/orchestrator/test/_custodian-slots.ts`): the CLI's
// `rootDir` keeps a static import of the other package's test file out. This test keeps the two
// copies equal, so that the unit tests and the validation cover the same inputs (ADR-0084).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as here from "./support/custodian-slots.ts";

test("the slot data of the Custodian's validation is the same as the renderer's unit tests use", async () => {
  // A computed path, so that typecheck does not take the other package's test file into this one.
  const path = ["..", "..", "orchestrator", "test", "_custodian-slots.ts"].join("/");
  const there = (await import(new URL(path, import.meta.url).href)) as typeof here;
  assert.deepEqual(here.RANGES, there.RANGES);
  assert.deepEqual(here.SANDBOX_MANIFEST, there.SANDBOX_MANIFEST);
  assert.deepEqual(here.INSTANCE_MANIFEST, there.INSTANCE_MANIFEST);
  assert.deepEqual(here.THREE_SLOTS, there.THREE_SLOTS);
  assert.deepEqual(here.manySlots(3, 4, 2), there.manySlots(3, 4, 2));
  assert.deepEqual(
    here.rule("a.test", 8080, "below", false, "entry"),
    there.rule("a.test", 8080, "below", false, "entry"),
  );
});
