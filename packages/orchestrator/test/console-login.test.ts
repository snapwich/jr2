// The Console's login, the pure half (console/login.ts): OIDC, the code flow with PKCE, as a public
// client (ADR-0032, ADR-0078). The redirect, the code exchange and sessionStorage are the
// bootstrap's (main.ts), and the `@console @dex` scenario drives them against a real issuer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  authorizeUrl,
  base64url,
  credentialOf,
  loginReturn,
  loginScopes,
  pkceChallenge,
  randomValue,
  redirectUri,
  tokenRequestBody,
} from "../console/login.ts";

test("the S256 challenge is RFC 7636's: base64url of the verifier's sha-256, with no padding", async () => {
  // Node's own hash is the oracle: the browser's `crypto.subtle` must give the same text.
  const verifier = randomValue();
  assert.equal(await pkceChallenge(verifier), createHash("sha256").update(verifier).digest("base64url"));
  assert.equal(base64url(new Uint8Array([251, 255])), "-_8");
});

test("a verifier and a state are 32 random bytes: 43 base64url characters, different each time", () => {
  const a = randomValue();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, randomValue());
});

test("the scopes: openid always, then profile, email and groups where the issuer lists them", () => {
  assert.equal(loginScopes(undefined), "openid profile email groups", "an issuer that lists none gets all four");
  assert.equal(loginScopes(["openid", "email", "offline_access"]), "openid email");
  assert.equal(loginScopes([]), "openid");
});

test("the authorization request is the code flow with an S256 challenge, back to the Console's root", () => {
  const url = new URL(
    authorizeUrl({
      endpoint: "https://dex.example.com/dex/auth?connector_id=mock",
      clientId: "jr2-console",
      redirectUri: redirectUri("https://jr2.example.com"),
      scope: "openid email",
      state: "s1",
      challenge: "c1",
    }),
  );
  assert.equal(url.origin + url.pathname, "https://dex.example.com/dex/auth");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    connector_id: "mock",
    response_type: "code",
    client_id: "jr2-console",
    redirect_uri: "https://jr2.example.com/",
    scope: "openid email",
    state: "s1",
    code_challenge: "c1",
    code_challenge_method: "S256",
  });
});

test("a return carries a code and its state, or the issuer's error; an ordinary load carries neither", () => {
  assert.deepEqual(loginReturn("?code=abc&state=s1"), { code: "abc", state: "s1" });
  assert.deepEqual(loginReturn("?error=access_denied&error_description=no&state=s1"), {
    error: "access_denied: no",
    state: "s1",
  });
  assert.deepEqual(loginReturn("?error=access_denied"), { error: "access_denied", state: null });
  assert.equal(loginReturn(""), null);
  assert.equal(loginReturn("?code=abc"), null, "a code with no state is no return of ours");
});

test("the token request sends the verifier and no client secret, and the credential is the ID token", () => {
  const body = new URLSearchParams(
    tokenRequestBody({ code: "abc", redirectUri: "https://jr2.example.com/", clientId: "jr2-console", verifier: "v" }),
  );
  assert.deepEqual(Object.fromEntries(body), {
    grant_type: "authorization_code",
    code: "abc",
    redirect_uri: "https://jr2.example.com/",
    client_id: "jr2-console",
    code_verifier: "v",
  });
  assert.equal(credentialOf({ access_token: "a", id_token: "i" }), "i");
  assert.equal(credentialOf({ access_token: "a" }), null);
  assert.equal(credentialOf(null), null);
});
