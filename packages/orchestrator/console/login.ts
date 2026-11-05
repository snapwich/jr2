// The Console's login (ADR-0032, ADR-0078): OIDC, the authorization code flow with PKCE, as a public
// client. The login adds no authenticator — it is a way for a person to get a JWT, which the page
// then sends as it sends a typed token. The JWT authenticator checks it like any other.
//
// What the page needs before the login is open (`GET /console/config`): each issuer that offers a
// login and its client id. Both are public values: a public client has no secret, and the issuer's
// URL is in every JWT that it signs.
//
// This file is the pure half — no fetch, no storage, no location — so `node:test` checks it. The
// bootstrap (main.ts) holds the rest: the redirect, the code exchange and sessionStorage. One `.ts`
// for both consumers (ADR-0034), as store.ts.

/** One issuer the Console offers a login against, as `GET /console/config` gives it. */
export type LoginIssuer = { issuer: string; clientId: string };

/** The answer of `GET /console/config`. */
export type ConsoleConfig = { login: LoginIssuer[] };

/** What the page keeps in sessionStorage between the redirect to the issuer and the return. */
export type PendingLogin = {
  issuer: string;
  clientId: string;
  state: string;
  verifier: string;
  tokenEndpoint: string;
  /** The page address to go back to after the return (the return itself always lands on `/`). */
  returnTo: string;
};

/** The scopes a login asks for, when the issuer supports each: `openid` always, then the claims the
 *  JWT authenticator reads by default (`email` for the name jr2 shows, `groups` for the scopes).
 *  An issuer that lists its scopes (`scopes_supported`) gets only those it lists, because some
 *  providers refuse a request with a scope they do not know. */
export function loginScopes(supported: readonly string[] | undefined): string {
  const wanted = ["openid", "profile", "email", "groups"];
  return wanted.filter((s) => s === "openid" || !supported || supported.includes(s)).join(" ");
}

/** The one return address of a login: the Console's root. One address, so an issuer needs one
 *  redirect URI registered for its client, whatever page the person logged in from. */
export function redirectUri(origin: string): string {
  return `${origin}/`;
}

/** The issuer's authorization request: the code flow with an S256 PKCE challenge. */
export function authorizeUrl(opts: {
  endpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(opts.endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** What a return from the issuer carries in the address: a code with its state, an error with the
 *  issuer's description, or nothing (an ordinary page load). */
export type LoginReturn = { code: string; state: string } | { error: string; state: string | null } | null;

export function loginReturn(search: string): LoginReturn {
  const params = new URLSearchParams(search);
  const state = params.get("state");
  const error = params.get("error");
  if (error) {
    const description = params.get("error_description");
    return { error: description ? `${error}: ${description}` : error, state };
  }
  const code = params.get("code");
  if (code && state) return { code, state };
  return null;
}

/** The body of the token request that exchanges the code (form-encoded, no client secret). */
export function tokenRequestBody(opts: {
  code: string;
  redirectUri: string;
  clientId: string;
  verifier: string;
}): string {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  }).toString();
}

/** The credential out of the token answer: the ID token. Its audience is the client id, which is
 *  the `audience` that the JWT authenticator checks; an access token's audience and form differ
 *  from one provider to the next. */
export function credentialOf(answer: unknown): string | null {
  const idToken = (answer as { id_token?: unknown } | null)?.id_token;
  return typeof idToken === "string" && idToken.length > 0 ? idToken : null;
}

/** base64url with no padding, as PKCE and `state` use it. */
export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A random value for a PKCE verifier or a `state`: 32 bytes, 43 characters. */
export function randomValue(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The S256 challenge of a verifier (RFC 7636): base64url(sha-256(verifier)). `crypto.subtle` is
 *  only in a secure context, so a login needs the Console on https or on localhost. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
