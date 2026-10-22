// The route table is the app (ADR-0072). `HTTP_ROUTES` is the source of the HTTP API Reference, so
// it must say exactly what `createApp` registers: a route the table does not list is a route the
// Reference hides, and a row with no route is one it invents. Both directions fail here, and each
// row's band (ADR-0014) is checked on the wire with a Sandbox token addressed to its own Sandbox:
// a row cannot say `instanceOnly` above a route that token can reach, nor `authenticated` above
// one that refuses it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
// The kit's specifier, not the root: the table is not on the Authoring surface (ADR-0015), and the
// Reference generator reads it from here.
import { HTTP_ROUTES, type HttpRoute } from "../src/internal.ts";
import { createAuthenticator, mintInstanceToken, sandboxToken } from "../src/tokens.ts";
import { mkStore } from "./_fixtures.ts";

const KEY = Buffer.alloc(32, 7);

/** An app with an authenticator, so the bands are live. No workflow is registered: a band
 * answers before any lookup, which is the point of it being middleware. */
async function mkApp() {
  const host = new RunHost({ store: await mkStore() });
  return createApp(host, createAuthenticator({ instanceToken: mintInstanceToken(), signingKey: KEY }));
}

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

test("every registered route has a row, and every row has a registered route", async () => {
  const app = await mkApp();
  // Hono lists a middleware and its handler as two entries for one route: one key each.
  const registered = new Set(app.routes.map(key));
  const table = HTTP_ROUTES.map(key);

  assert.equal(new Set(table).size, table.length, "a route has two rows");
  assert.deepEqual(
    [...registered].filter((k) => !table.includes(k)),
    [],
    "registered, but not in HTTP_ROUTES",
  );
  assert.deepEqual(
    table.filter((k) => !registered.has(k)),
    [],
    "in HTTP_ROUTES, but not registered",
  );
});

test("every row names its decisions, and each one is an ADR that exists", async () => {
  const adrs = new Set((await readdir(new URL("../../../docs/adr/", import.meta.url))).map((f) => f.slice(0, 4)));
  for (const row of HTTP_ROUTES) {
    assert.ok(row.adrs.length > 0, `${key(row)}: names no ADR`);
    for (const adr of row.adrs) {
      // The command table's form too, so one generator reads both.
      assert.match(adr, /^\d{4}$/, `${key(row)}: write an ADR as its bare number, as "0014"`);
      assert.ok(adrs.has(adr), `${key(row)}: no ADR-${adr} in docs/adr/`);
    }
  }
});

/** The Sandbox the test's Sandbox token is minted for. */
const SANDBOX = "ws-1";

/** A concrete address for a row: each `:param{regex}` becomes a value it admits, and each plain
 * `:param` the token's own Sandbox name. So a per-Sandbox scope check (`mayAskForSandbox`) lets the
 * token through, and a 403 can come only from the band. */
function addressOf(row: HttpRoute): string {
  return row.path.replace(/:(\w+)(\{[^}]*\})?/g, (_, _name: string, pattern?: string) =>
    pattern ? "main.ts" : SANDBOX,
  );
}

/** Ask once, and drop the body: an open SSE feed never ends on its own. */
async function statusOf(app: Awaited<ReturnType<typeof mkApp>>, row: HttpRoute, token?: string) {
  const res = await app.request(addressOf(row), {
    method: row.method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(row.method === "POST" || row.method === "PUT" ? { body: "{}" } : {}),
  });
  await res.body?.cancel();
  return res.status;
}

test("each row's band is the band the route enforces", async () => {
  const app = await mkApp();
  const sandbox = sandboxToken(KEY, SANDBOX);
  for (const row of HTTP_ROUTES) {
    const noToken = await statusOf(app, row);
    if (row.band === "open") {
      assert.notEqual(noToken, 401, `${key(row)} is open, but refuses a caller with no token`);
      continue;
    }
    assert.equal(noToken, 401, `${key(row)} is ${row.band}, but takes a caller with no token`);
    const withSandbox = await statusOf(app, row, sandbox);
    if (row.band === "instanceOnly" || row.band === "publishOnly") {
      assert.equal(withSandbox, 403, `${key(row)} is ${row.band}, but takes a Sandbox token`);
    } else {
      assert.ok(
        withSandbox !== 401 && withSandbox !== 403,
        `${key(row)} is authenticated, but refuses a Sandbox token (${withSandbox})`,
      );
    }
  }
});
