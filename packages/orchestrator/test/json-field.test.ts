// The start form's JSON fields (ADR-0033, ADR-0070): an object or array property goes as JSON of
// its type, so a Chart wrapper's one-shot door (`chart`, an object) can be started from the Console.

import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonField } from "../console/json-field.ts";

test("an object property's text is sent as the object, never as a string", () => {
  assert.deepEqual(jsonField("chart", { type: "object" }, ' { "initial": "a" } '), { initial: "a" });
  assert.deepEqual(jsonField("tags", { type: "array" }, '["x"]'), ["x"]);
});

test("an empty JSON field is absent; text of the wrong type or not JSON names the field", () => {
  assert.equal(jsonField("chart", { type: "object" }, "  "), undefined);
  assert.throws(() => jsonField("chart", { type: "object" }, "{"), /^Error: chart: not valid JSON$/);
  assert.throws(() => jsonField("chart", { type: "object" }, "[1]"), /chart: must be a JSON object/);
  assert.throws(() => jsonField("chart", { type: "object" }, '"{}"'), /chart: must be a JSON object/);
  assert.throws(() => jsonField("tags", { type: "array" }, "{}"), /tags: must be a JSON array/);
});
