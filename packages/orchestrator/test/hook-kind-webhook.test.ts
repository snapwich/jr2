// `webhook()`: a kind from data, for a service that has no kind of its own (ADR-0078). It goes
// through `defineHookKind`, so it gets nothing that a kind from another package does not get.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { hookParts, hookRequest, schemaFor, signatureBytes, signedBytes } from "../src/hook-kinds/door.ts";
import { webhook } from "../src/hook-kinds/webhook.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const deploys = webhook({
  id: "deploys",
  events: {
    "deploy.finished": z.looseObject({ service: z.string(), result: z.enum(["ok", "failed"]) }),
  },
  verify: { mac: { header: "X-Deploys-Signature", prefix: "sha256=" } },
  key: { name: { header: "x-deploys-event" }, action: { json: "action" } },
  delivery: { header: "x-deploys-delivery" },
  onBehalfOf: { json: "actor.login" },
});

const body = JSON.stringify({ action: "finished", service: "api", result: "ok", actor: { login: "ada" }, n: 1 });

test("webhook: a mac kind over the raw body, with the header's prefix removed", () => {
  const sig = createHmac("sha256", "s3cret").update(body).digest("hex");
  const req = hookRequest(
    { "x-deploys-signature": `sha256=${sig}`, "x-deploys-event": "deploy", "x-deploys-delivery": "d-1" },
    enc(body),
  );
  assert.ok("mac" in deploys.verify);
  assert.equal(deploys.verify.mac.alg, "sha256");
  const signed = deploys.verify.mac.signed(req);
  assert.ok(!("unsigned" in signed));
  assert.equal(signed.at, undefined, "webhook() gives no signed timestamp");
  const mac = createHmac("sha256", "s3cret").update(signedBytes(signed)).digest();
  assert.equal(Buffer.compare(mac, signatureBytes(signed)!), 0);
  const unsigned = deploys.verify.mac.signed(hookRequest({ "x-deploys-signature": sig }, enc(body)));
  assert.deepEqual(unsigned, { unsigned: "no x-deploys-signature header" });
});

test("webhook: the key, the id and onBehalfOf come from headers and JSON paths", () => {
  const req = hookRequest({ "X-Deploys-Event": "deploy", "X-Deploys-Delivery": "d-1" }, enc(body));
  const d = deploys.read(req);
  assert.ok(!("handshake" in d));
  assert.deepEqual(
    { key: d.key, id: d.id, onBehalfOf: d.onBehalfOf, readBy: d.readBy },
    { key: "deploy.finished", id: "d-1", onBehalfOf: "ada", readBy: undefined },
  );
  assert.ok(schemaFor(deploys, d.key)!.safeParse(d.payload).success);
  assert.throws(() => deploys.read(hookRequest({ "x-deploys-event": "deploy" }, enc(body))), /delivery id/);
  assert.throws(() => deploys.read(hookRequest({ "x-deploys-delivery": "d" }, enc(body))), /event name/);
  assert.equal(deploys.answer, undefined, "the answer is the outcome JSON");
});

test("webhook: a token kind, a numeric id, base64 and a single-field key", () => {
  const alerts = webhook({
    id: "alerts",
    events: { fired: z.looseObject({ id: z.number() }) },
    verify: { token: { header: "X-Alert-Token" } },
    key: { json: "state" },
    delivery: { json: "id" },
  });
  assert.deepEqual(alerts.verify, { token: { header: "x-alert-token" } });
  const d = alerts.read(hookRequest({}, enc('{"state":"fired","id":42}')));
  assert.ok(!("handshake" in d));
  assert.equal(d.key, "fired");
  assert.equal(d.id, "42");
  assert.equal(d.onBehalfOf, undefined);
  assert.deepEqual(hookParts(alerts({ secret: { secret: "ALERTS" } })).credential, { secret: { secret: "ALERTS" } });

  const b64 = webhook({
    id: "b64",
    events: {},
    verify: { mac: { header: "x-sig", alg: "sha1", encoding: "base64" } },
    key: { json: "t" },
    delivery: { json: "i" },
  });
  assert.ok("mac" in b64.verify);
  assert.equal(b64.verify.mac.alg, "sha1");
  assert.deepEqual(b64.verify.mac.signed(hookRequest({ "x-sig": "Cv8=" }, enc("{}"))), {
    bytes: [enc("{}")],
    signature: { base64: "Cv8=" },
  });
});

test("webhook: the id of a kind from data is checked as any kind's id", () => {
  assert.throws(
    () =>
      webhook({
        id: "Deploys",
        events: {},
        verify: { token: { header: "x" } },
        key: { json: "t" },
        delivery: { json: "i" },
      }),
    /lowercase/,
  );
});
