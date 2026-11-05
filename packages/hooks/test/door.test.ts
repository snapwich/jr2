// What the door reads from a Hook and a kind (`@jr2/hooks/door`): the request it gives a kind, the
// schema of an event key, the signed bytes, and one kind for each id (ADR-0078, ADR-0011).

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineHookKind, json } from "@jr2/hooks";
import { hookRequest, kindsById, schemaFor, signatureBytes, signedBytes } from "@jr2/hooks/door";
import { github } from "@jr2/hooks/github";

test("the request has lowercase header names, joins a repeated header, and removes the stripped one", () => {
  const req = hookRequest(
    { "X-Gitlab-Token": "secret-value", "Content-Type": "application/json", accept: ["a", "b"], gone: undefined },
    new TextEncoder().encode('{"ok":true}'),
    "X-GITLAB-TOKEN",
  );
  assert.equal(req.headers["content-type"], "application/json");
  assert.equal(req.headers.accept, "a, b");
  assert.equal(req.headers["x-gitlab-token"], undefined, "the door removes the token before the kind runs");
  assert.ok(!("gone" in req.headers));
  assert.equal(req.text, '{"ok":true}');
  assert.ok(Object.isFrozen(req) && Object.isFrozen(req.headers));

  const fromHeaders = hookRequest(new Headers({ "X-A": "1" }), new Uint8Array());
  assert.equal(fromHeaders.headers["x-a"], "1");
});

test("the request's body is a copy: a change to the door's buffer does not reach the kind", () => {
  const buf = new TextEncoder().encode("abc");
  const req = hookRequest({}, buf);
  buf[0] = 0x7a;
  assert.equal(new TextDecoder().decode(req.body), "abc");
});

const family = defineHookKind({
  api: 1,
  id: "family",
  events: {
    "block_actions.*": z.looseObject({ a: z.string() }),
    "block_actions.approve.*": z.looseObject({ b: z.string() }),
    "block_actions.reject": z.looseObject({ c: z.string() }),
  },
  verify: { token: { header: "x-token" } },
  read: (req) => ({ key: "k", id: "1", payload: json(req) }),
});

test("an exact key comes first, then the longest prefix.* key, and an unnamed key has no schema", () => {
  assert.equal(schemaFor(family, "block_actions.reject"), family.events["block_actions.reject"]);
  assert.equal(schemaFor(family, "block_actions.retry"), family.events["block_actions.*"]);
  assert.equal(schemaFor(family, "block_actions.approve.now"), family.events["block_actions.approve.*"]);
  assert.equal(schemaFor(family, "block_actions"), undefined, "a prefix.* key needs something after the dot");
  assert.equal(schemaFor(family, "block_actions."), undefined);
  assert.equal(schemaFor(family, "event_callback.app_mention"), undefined);
  assert.equal(schemaFor(github, "toString"), undefined, "an inherited name is no key");
});

test("the signed bytes are the parts joined, and a string part is UTF-8", () => {
  const out = signedBytes({ bytes: ["v0:", "12", ":", new Uint8Array([0xc3, 0xa9])], signature: { hex: "00" } });
  assert.deepEqual([...out], [...new TextEncoder().encode("v0:12:"), 0xc3, 0xa9]);
});

test("the signature decodes from hex or base64, and a malformed one gives undefined", () => {
  assert.deepEqual([...signatureBytes({ bytes: [], signature: { hex: "0aFF" } })!], [10, 255]);
  assert.deepEqual([...signatureBytes({ bytes: [], signature: { base64: "Cv8=" } })!], [10, 255]);
  assert.equal(signatureBytes({ bytes: [], signature: { hex: "0g" } }), undefined);
  assert.equal(signatureBytes({ bytes: [], signature: { hex: "abc" } }), undefined);
  assert.equal(signatureBytes({ bytes: [], signature: { hex: "" } }), undefined);
  assert.equal(signatureBytes({ bytes: [], signature: { base64: "Cv8" } }), undefined);
});

test("one id is one kind: one kind twice is one entry, two kinds with one id throw", () => {
  const map = kindsById([github, github, family]);
  assert.deepEqual([...map.keys()], ["github", "family"]);
  const other = defineHookKind({
    api: 1,
    id: "github",
    events: {},
    verify: { token: { header: "x-token" } },
    read: (req) => ({ key: "k", id: "1", payload: json(req) }),
  });
  assert.throws(() => kindsById([github, other]), /two different Hook kinds have the id github/);
  assert.throws(() => kindsById([{ ...family, api: 2 } as never]), /api 1 only/);
});
