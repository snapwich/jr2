// A pick's and an MCP tool's arguments, checked as the model wrote them (ADR-0027,
// `strict-arguments.ts`): what pi-ai would convert is refused in pi-ai's words.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { strictArguments } from "../src/strict-arguments.ts";

const schema = {
  type: "object",
  properties: {
    count: { type: "integer" },
    label: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    ratio: { type: "number" },
    "a/b": { type: "object", properties: { "c~d": { type: "boolean" } } },
  },
  required: ["count"],
};

test("arguments that fit come back as they are, and pi's validation leaves them so", () => {
  const check = strictArguments("t", schema);
  const args = { count: 3, label: "x", tags: ["one"], ratio: 0.5 };
  assert.equal(check(args), args);
  const tool = { name: "t", description: "", parameters: schema } as never;
  assert.deepEqual(
    validateToolArguments(tool, { type: "toolCall", id: "1", name: "t", arguments: args } as never),
    args,
  );
});

test("each value that pi would convert is refused, in pi-ai's own text", () => {
  const check = strictArguments("mcp__jr2__t", schema);
  for (const [args, line] of [
    [{ count: 3.5 }, "  - count: expected integer, got number"],
    [{ count: "3" }, "  - count: expected integer, got string"],
    [{ count: 1, label: null }, "  - label: expected string, got null"],
    [{ count: 1, tags: "one" }, "  - tags: expected array, got string"],
    [{ count: 1, ratio: "0.5" }, "  - ratio: expected number, got string"],
    [{ count: 1, "a/b": { "c~d": "true" } }, "  - a/b.c~d: expected boolean, got string"],
  ] as const) {
    assert.throws(
      () => check(args),
      (err: Error) => {
        assert.ok(err.message.startsWith(`Validation failed for tool "mcp__jr2__t":\n${line}\n`), err.message);
        assert.ok(err.message.endsWith(`\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`), err.message);
        return true;
      },
      JSON.stringify(args),
    );
  }
});

test("empty arguments that pi refuses too go on to pi, which says the parse error of malformed text first", () => {
  // pi-ai makes argument text that does not parse into `{}` with `argumentsError`, and
  // `prepareArguments` sees only the `{}`. pi's validation says that error, with the text.
  const check = strictArguments("mcp__jr2__t", schema);
  const empty = {};
  assert.equal(check(empty), empty);
  const tool = { name: "mcp__jr2__t", description: "", parameters: schema } as never;
  const call = (extra: object) => ({ type: "toolCall", id: "1", name: "mcp__jr2__t", arguments: empty, ...extra });
  assert.throws(
    () =>
      validateToolArguments(
        tool,
        call({ argumentsError: 'Unexpected end\n\nReceived arguments:\n{"count":' }) as never,
      ),
    (err: Error) =>
      err.message === 'Invalid arguments for tool "mcp__jr2__t": Unexpected end\n\nReceived arguments:\n{"count":',
  );
  // Empty text, which parses to `{}` with no error: pi names the missing field.
  assert.throws(
    () => validateToolArguments(tool, call({}) as never),
    (err: Error) => err.message.startsWith('Validation failed for tool "mcp__jr2__t":\n  - count: missing\n'),
  );
});

test("empty arguments that fit pass, and a value that is no plain {} is checked", () => {
  const none = strictArguments("t", { type: "object", properties: { a: { type: "string" } } });
  const empty = {};
  assert.equal(none(empty), empty);
  // An object that is not a plain `{}` is checked as any other value.
  assert.throws(() => strictArguments("t", schema)([]), /Validation failed/);
});

test("the refusal matches pi-ai's for a value that pi refuses too", () => {
  // A value no coercion fixes: pi-ai's text and jr2's are the same bytes.
  const args = { count: { n: 1 } };
  const tool = { name: "t", description: "", parameters: schema } as never;
  let pi = "";
  try {
    validateToolArguments(tool, { type: "toolCall", id: "1", name: "t", arguments: args } as never);
  } catch (err) {
    pi = (err as Error).message;
  }
  assert.throws(
    () => strictArguments("t", schema)(args),
    (err: Error) => err.message === pi && pi !== "",
  );
});

test("a $ref that names nothing rejects only a value at its place, as pi-ai's does", () => {
  const check = strictArguments("t", {
    type: "object",
    properties: { a: { type: "string" }, b: { $ref: "#/$defs/missing" } },
  });
  assert.deepEqual(check({ a: "x" }), { a: "x" });
  assert.throws(() => check({ b: 1 }), /unresolved reference/);
});
