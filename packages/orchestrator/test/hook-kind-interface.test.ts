// The interface of a Hook kind (ADR-0078): the helpers a kind reads a body with, what
// `defineHookKind` refuses, and the constructor that jr2 makes, so the credential goes to the
// door and never through the kind's code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { at, defineHookKind, form, json, type HookRequest } from "../src/hook-kinds/index.ts";
import { hookParts, hookRequest, isHook } from "../src/hook-kinds/door.ts";

const body = (text: string): HookRequest => hookRequest({}, new TextEncoder().encode(text));

const E = { "thing.done": z.looseObject({ id: z.string() }) };
const read = (req: HookRequest) => ({ key: "thing.done", id: req.headers["x-id"] ?? "1", payload: json(req) });
const base = { api: 1 as const, id: "things", events: E, verify: { token: { header: "x-token" } }, read };

test("json decodes the body, and a body that is not JSON throws", () => {
  assert.deepEqual(json(body('{"a":[1,2]}')), { a: [1, 2] });
  assert.throws(() => json(body("a=1")), /not JSON/);
});

test("form decodes a urlencoded body, and the first value of a field wins", () => {
  const f = form(body("command=%2Fjr2&text=fix+it&text=again"));
  assert.equal(f.command, "/jr2");
  assert.equal(f.text, "fix it");
  assert.equal(f.missing, undefined);
  assert.equal(form(body("__proto__=x")).__proto__, "x", "a field named __proto__ is a field, not the prototype");
});

test("at reads a dotted path of own properties, and gives undefined for a path that is not there", () => {
  const v = { sender: { login: "ada" }, list: [{ id: 7 }] };
  assert.equal(at(v, "sender.login"), "ada");
  assert.equal(at(v, "list.0.id"), 7);
  assert.equal(at(v, "sender.name"), undefined);
  assert.equal(at(v, "sender.login.length"), undefined, "a string has no own property length to walk");
  assert.equal(at(v, "constructor"), undefined, "an inherited property is not read");
  assert.equal(at(null, "a"), undefined);
});

test("the kind is also its Hook's constructor, and the Hook keeps the credential for the door", () => {
  const things = defineHookKind(base);
  assert.equal(things.id, "things");
  assert.equal(things.api, 1);
  assert.ok(Object.isFrozen(things));
  const hook = things({ secret: { secret: "THINGS_TOKEN" } });
  assert.ok(isHook(hook));
  const parts = hookParts(hook);
  assert.equal(parts.kind, things);
  assert.deepEqual(parts.credential, { secret: { secret: "THINGS_TOKEN" } });
  assert.deepEqual(parts.may, { answer: "all" }, "a Hook may answer each Workflow by default");
  assert.deepEqual(hookParts(things({ secret: { secret: "T" }, may: { answer: ["triage"] } })).may, {
    answer: ["triage"],
  });
  assert.ok(!isHook(things), "a kind is not a Hook");
  assert.throws(() => hookParts({} as never), /not a Hook/);
});

test("the kind's own functions never get the credential: read gets the request alone", () => {
  const seen: unknown[][] = [];
  const spy = defineHookKind({
    ...base,
    read: (...args: [HookRequest]) => {
      seen.push(args);
      return read(args[0]);
    },
  });
  const hook = spy({ secret: { secret: "S" } });
  hookParts(hook).kind.read(body('{"x":1}'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.length, 1, "one argument: the request");
  assert.ok(!JSON.stringify(seen[0]).includes('"S"'));
});

test("a constructor refuses a credential of the wrong form", () => {
  const things = defineHookKind(base);
  assert.throws(() => things({} as never), /named secret/);
  assert.throws(() => things({ secret: "THINGS" } as never), /named secret/);
  assert.throws(() => things({ secret: { secret: "S" }, may: { answer: "some" } } as never), /may.answer/);
  assert.throws(() => things({ secret: { secret: "S" }, may: { answer: [""] } }), /may.answer/);
  const signed = defineHookKind({
    ...base,
    id: "signed",
    verify: { ed25519: { signed: () => ({ unsigned: "no" }) } },
  });
  assert.throws(() => signed({ publicKey: "abc" }), /64 characters/);
  assert.equal(
    (hookParts(signed({ publicKey: "AB".repeat(32) })).credential as { publicKey: string }).publicKey,
    "ab".repeat(32),
  );
});

test("defineHookKind refuses a kind that the door cannot call", () => {
  assert.throws(() => defineHookKind({ ...base, api: 2 as never }), /api 1 only/);
  assert.throws(() => defineHookKind({ ...base, id: "GitHub" }), /lowercase/);
  assert.throws(() => defineHookKind({ ...base, id: "1st" }), /lowercase/);
  assert.throws(() => defineHookKind({ ...base, id: "a/b" }), /lowercase/);
  assert.throws(() => defineHookKind({ ...base, events: { k: { id: "string" } } as never }), /zod schema/);
  assert.throws(() => defineHookKind({ ...base, verify: {} as never }), /one of mac, ed25519 or token/);
  assert.throws(
    () =>
      defineHookKind({
        ...base,
        verify: { token: { header: "x" }, mac: { alg: "sha256", signed: () => ({ unsigned: "" }) } } as never,
      }),
    /one of mac, ed25519 or token/,
  );
  assert.throws(
    () => defineHookKind({ ...base, verify: { mac: { alg: "md5", signed: () => ({ unsigned: "" }) } } as never }),
    /alg/,
  );
  assert.throws(() => defineHookKind({ ...base, verify: { token: { header: "X-Token" } } }), /lowercase/);
  const person = { ...base, answer: (t: string) => ({ body: t }) };
  assert.throws(() => defineHookKind({ ...person, maxText: 0 }), /maxText/);
  assert.throws(() => defineHookKind({ ...person, maxText: 1.5 }), /maxText/);
  assert.throws(() => defineHookKind({ ...person, posts: ["http://hooks.example.com/" as never] }), /https/);
  assert.throws(() => defineHookKind({ ...person, posts: ["https://hooks.example.com/r" as never] }), /ends in/);
  assert.equal(defineHookKind({ ...person, maxText: 10, posts: ["https://hooks.example.com/"] }).maxText, 10);
});
