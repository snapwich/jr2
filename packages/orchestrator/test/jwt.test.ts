// The JWT authenticator of the Caller seam, against an in-process issuer made with `jose`
// (ADR-0078): a good token, a wrong issuer or audience, an expired token, a key that rotated, and a
// token with no scope. The issuer's keys come through an injected fetch, so no socket opens.

import { test } from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { jwtAuthenticator, joinScopes, type JwksFetch } from "../src/callers.ts";
import type { JwtIssuer } from "../src/config.ts";
import { createAuthenticator, mintInstanceToken, type Caller, type CallerAuthenticator } from "../src/tokens.ts";
import { RunHost } from "../src/run-host.ts";
import { createApp } from "../src/http.ts";
import { gatedDef, mkStore } from "./_fixtures.ts";

const ISSUER = "https://dex.example.com";

/** An issuer: its signing keys, the JWKS it publishes now, and a fetch that serves both documents. */
async function issuer() {
  type Key = { kid: string; privateKey: CryptoKey; jwk: JWK };
  const make = async (kid: string): Promise<Key> => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" } };
  };
  let published: Key[] = [await make("k1")];
  const fetched: string[] = [];
  const fetch: JwksFetch = async (url) => {
    fetched.push(url);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/keys` });
    }
    if (url === `${ISSUER}/keys`) return Response.json({ keys: published.map((k) => k.jwk) });
    return new Response("not found", { status: 404 });
  };
  const sign = async (
    claims: JWTPayload,
    opts: { key?: Key; iss?: string; aud?: string; exp?: string | number } = {},
  ): Promise<string> => {
    const key = opts.key ?? published[0]!;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: key.kid })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? "jr2")
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(key.privateKey);
  };
  return {
    fetch,
    fetched,
    sign,
    /** Publish a new key in place of the old ones, as a provider rotates. */
    rotate: async (): Promise<Key> => {
      const next = await make(`k${published.length + 1}`);
      published = [next];
      return next;
    },
  };
}

const ENTRY: JwtIssuer = {
  issuer: ISSUER,
  audience: "jr2",
  groups: {
    "jr2-ops": { start: "all", answer: "all", cancel: "all", read: "all" },
    "jr2-triage": { answer: ["gated"], read: ["gated"] },
  },
};

test("a good JWT is the Caller jwt/<sub>, shown by its email, with the scopes of its groups joined", async () => {
  const idp = await issuer();
  const authenticate = jwtAuthenticator(() => [ENTRY], { fetch: idp.fetch });
  const token = await idp.sign({ sub: "u-1", email: "ann@example.com", groups: ["jr2-triage", "other"] });
  assert.deepEqual(await authenticate(token), {
    via: "jwt",
    name: "u-1",
    shown: "ann@example.com",
    may: { answer: ["gated"], read: ["gated"] },
  });
  // The keys came from the issuer's discovery document, and are kept for the next JWT.
  assert.deepEqual(idp.fetched, [`${ISSUER}/.well-known/openid-configuration`, `${ISSUER}/keys`]);
  await authenticate(await idp.sign({ sub: "u-2", groups: ["jr2-ops"] }));
  assert.equal(idp.fetched.length, 2, "no second fetch for a known key");
});

test("the claims are configurable, and a groups claim that is one string is one value", async () => {
  const idp = await issuer();
  const entry: JwtIssuer = {
    ...ENTRY,
    jwks: `${ISSUER}/keys`,
    claims: { name: "oid", shown: "preferred_username", groups: "roles" },
  };
  const authenticate = jwtAuthenticator(() => [entry], { fetch: idp.fetch });
  const caller = await authenticate(
    await idp.sign({ sub: "s", oid: "o-7", preferred_username: "ann", roles: "jr2-ops" }),
  );
  assert.deepEqual(caller, {
    via: "jwt",
    name: "o-7",
    shown: "ann",
    may: { start: "all", answer: "all", cancel: "all", read: "all" },
  });
  assert.deepEqual(idp.fetched, [`${ISSUER}/keys`], "a configured jwks needs no discovery");
});

test("a wrong audience, an expired JWT, a bad signature or no name claim is claimed and refused", async () => {
  const idp = await issuer();
  const other = await issuer();
  const authenticate = jwtAuthenticator(() => [ENTRY], { fetch: idp.fetch });
  const refused = async (token: string, why: RegExp) => {
    const answer = await authenticate(token);
    assert.ok(answer && "refused" in answer, `claimed and refused: ${JSON.stringify(answer)}`);
    assert.match(answer.refused, why);
  };
  await refused(await idp.sign({ sub: "u" }, { aud: "another-app" }), /aud/);
  await refused(await idp.sign({ sub: "u" }, { exp: Math.floor(Date.now() / 1000) - 120 }), /exp/);
  // Signed by another key with a kid the issuer publishes: the signature fails.
  await refused(await other.sign({ sub: "u" }), /signature/);
  await refused(await idp.sign({ email: "no-sub@example.com" }), /has no "sub" claim/);
});

test("a JWT of an issuer that no entry names, and a bearer that is no JWT, are not claimed", async () => {
  const idp = await issuer();
  const authenticate = jwtAuthenticator(() => [ENTRY], { fetch: idp.fetch });
  assert.equal(await authenticate(await idp.sign({ sub: "u" }, { iss: "https://evil.example.com" })), undefined);
  assert.equal(await authenticate("jr2c_abc"), undefined);
  assert.equal(await authenticate("a.b.c"), undefined);
  assert.equal(idp.fetched.length, 0, "nothing was fetched for a bearer that no entry claims");
});

test("a key that the issuer rotated: a JWT with the new key is fetched for once, with no restart", async () => {
  const idp = await issuer();
  const authenticate = jwtAuthenticator(() => [ENTRY], { fetch: idp.fetch, cooldownMs: 0 });
  assert.equal(((await authenticate(await idp.sign({ sub: "u", groups: ["jr2-ops"] }))) as Caller).name, "u");
  const next = await idp.rotate();
  const before = idp.fetched.length;
  const caller = await authenticate(await idp.sign({ sub: "v", groups: ["jr2-ops"] }, { key: next }));
  assert.equal((caller as Caller).name, "v");
  assert.equal(idp.fetched.length, before + 1, "one fetch of the keys for the unknown kid");
});

test("a failed discovery is kept for the cooldown: a flood of JWTs makes one fetch, and the next fetch comes after it", async () => {
  const idp = await issuer();
  let down = true;
  const discovery = `${ISSUER}/.well-known/openid-configuration`;
  const fetch: JwksFetch = async (url, init) =>
    down && url === discovery ? (idp.fetched.push(url), new Response("down", { status: 503 })) : idp.fetch(url, init);
  // The test's clock moves only when the test moves it, so the load of a full test run cannot move
  // a check out of the cooldown or keep it in.
  let clock = 0;
  const authenticate = jwtAuthenticator(() => [ENTRY], { fetch, cooldownMs: 100, now: () => clock });
  const token = await idp.sign({ sub: "u", groups: ["jr2-ops"] });
  const answers = await Promise.all(Array.from({ length: 20 }, () => authenticate(token)));
  for (const answer of answers) assert.match((answer as { refused: string }).refused, /answered 503/);
  assert.match(((await authenticate(token)) as { refused: string }).refused, /answered 503/);
  assert.deepEqual(idp.fetched, [discovery], "one fetch for every JWT in the cooldown");
  down = false;
  assert.ok("refused" in ((await authenticate(token)) as object), "still in the cooldown: no fetch");
  assert.equal(idp.fetched.length, 1);
  clock = 99;
  assert.ok("refused" in ((await authenticate(token)) as object), "at the cooldown's last moment: no fetch");
  assert.equal(idp.fetched.length, 1);
  clock = 100;
  assert.equal(((await authenticate(token)) as Caller).name, "u", "after the cooldown, the discovery is fetched again");
  assert.deepEqual(idp.fetched, [discovery, discovery, `${ISSUER}/keys`]);
});

test("the key sets are kept only for the issuers that the config names now", async () => {
  const idp = await issuer();
  let entries: JwtIssuer[] = [ENTRY];
  const authenticate = jwtAuthenticator(() => entries, { fetch: idp.fetch });
  const token = await idp.sign({ sub: "u", groups: ["jr2-ops"] });
  assert.equal(((await authenticate(token)) as Caller).name, "u");
  assert.equal(idp.fetched.length, 2, "discovery and keys");
  await authenticate(token);
  assert.equal(idp.fetched.length, 2, "kept while the config names the issuer");
  // A publish drops the issuer: its JWT is not claimed, and its key set goes.
  entries = [];
  assert.equal(await authenticate(token), undefined);
  // Named again, it is a new entry: its discovery and keys are fetched again.
  entries = [ENTRY];
  assert.equal(((await authenticate(token)) as Caller).name, "u");
  assert.equal(idp.fetched.length, 4, "the dropped key set was not kept");
  // A changed `jwks` is another entry: the old one goes, and only the new one is fetched.
  entries = [{ ...ENTRY, jwks: `${ISSUER}/keys` }];
  assert.equal(((await authenticate(token)) as Caller).name, "u");
  assert.deepEqual(idp.fetched.slice(4), [`${ISSUER}/keys`]);
  entries = [ENTRY];
  await authenticate(token);
  assert.equal(idp.fetched.length, 7, "the first entry was dropped when the config changed");
});

test("in the seam: a refused JWT is 401 and never falls through; one with no scope is 403 on a scoped route", async () => {
  const idp = await issuer();
  const later: CallerAuthenticator = () => ({ via: "token", name: "fallthrough", may: { read: "all" } });
  const auth = createAuthenticator({
    instanceToken: mintInstanceToken(),
    signingKey: Buffer.alloc(32, 3),
    callers: [jwtAuthenticator(() => [ENTRY], { fetch: idp.fetch }), later],
  });
  const host = new RunHost({ store: await mkStore() });
  host.register(gatedDef());
  const app = createApp(host, auth);
  const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

  const expired = await idp.sign({ sub: "u", groups: ["jr2-ops"] }, { exp: Math.floor(Date.now() / 1000) - 120 });
  assert.equal(await auth(expired), undefined, "claimed and bad: no later authenticator sees it");
  assert.equal((await app.request("/runs", as(expired))).status, 401);

  const none = await idp.sign({ sub: "nobody", email: "n@example.com", groups: ["strangers"] });
  const runs = await app.request("/runs", as(none));
  assert.equal(runs.status, 403, "no scope is never read-only");
  // `whoami` answers it, so a person can see why each other route refuses.
  const who = await app.request("/whoami", as(none));
  assert.equal(who.status, 200);
  assert.deepEqual(await who.json(), { via: "jwt", name: "nobody", shown: "n@example.com", may: {} });

  const ops = await idp.sign({ sub: "op", groups: ["jr2-ops"] });
  const started = await app.request("/workflows/gated/runs", {
    method: "POST",
    headers: { authorization: `Bearer ${ops}`, "content-type": "application/json", "jr2-on-behalf-of": "pager" },
    body: "{}",
  });
  assert.equal(started.status, 201);
  const { runId } = (await started.json()) as { runId: string };
  assert.deepEqual(host.status(runId)?.startedBy, { kind: "caller", via: "jwt", name: "op", onBehalfOf: "pager" });
});

test("joinScopes: a scope for every Workflow wins, and lists join without repeats", () => {
  assert.deepEqual(joinScopes([{ read: ["a"], start: ["a"] }, { read: ["b", "a"], start: "all" }, { cancel: ["c"] }]), {
    start: "all",
    cancel: ["c"],
    read: ["a", "b"],
  });
  assert.deepEqual(joinScopes([]), {});
});
