// The JWT issuers of the Caller seam, and the record of a Caller on a run (ADR-0078).
//
// The seam itself (its order, the Instance token, the named `jr2c_` tokens) is in tokens.ts. This
// file adds its third authenticator: a JWT from an identity provider that the config declares, which
// the Orchestrator checks against the provider's published keys. That fetch is the Orchestrator's
// one call out of the Instance, and it spends no secret (ADR-0068).
//
// It also holds what a run records of a Caller: the Caller without its scopes, because a run
// records who acted, not what that credential could do then.

import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { SCOPES, type JwtIssuer, type ScopeGrant, type Scopes } from "./config.ts";
import type { Caller, CallerAnswer, CallerAuthenticator } from "./tokens.ts";

// ---- What a run records ------------------------------------------------------------------------

/** A Caller as a run records it (ADR-0078): who acted, and the party it says it acted for. Never its
 * scopes. */
export type CallerRecord = {
  via: Caller["via"];
  name: string;
  /** The name that jr2 shows, when it is not `name` (a JWT's `email`). */
  shown?: string;
  /** The Caller's claim about the party it acts for. jr2 records it and never checks it, except for
   * a Hook, whose signature covers it. */
  onBehalfOf?: string;
};

/**
 * Who started a run (ADR-0078): a Caller on a guarded route; a run, through a local `dispatch`
 * (ADR-0071); or jr2 itself, for a standing run (ADR-0017), at `boot`, at a `publish`, at a
 * `hand-over`, or at a `resume`. A run that a foreign `dispatch` started records the Caller whose
 * credential the other Instance sent.
 */
export type RunStarter =
  | ({ kind: "caller" } & CallerRecord)
  | { kind: "run"; run: string; slot: string }
  | { kind: "jr2"; why: "boot" | "publish" | "hand-over" | "resume" };

/** One answer to a Gate of a run, and the Caller that gave it (ADR-0011, ADR-0078). `delivery` is
 * the Hook's delivery id when a Hook gave it: the run's `(delivery, gate)` pairs, so a restore never
 * gives one delivery twice to one Gate. */
export type GateAnswer = { gate: string; type: string; at: string; answeredBy: CallerRecord; delivery?: string };

/** How many Gate answers a run keeps, the last ones: a standing run's Gate can take an answer for
 * each delivery, and the run's blob is saved on each transition. */
export const GATE_ANSWERS_KEPT = 100;

/** The record of a Caller: the Caller without its scopes. */
export function callerRecord(caller: Caller): CallerRecord {
  return {
    via: caller.via,
    name: caller.name,
    ...(caller.shown !== undefined ? { shown: caller.shown } : {}),
    ...(caller.onBehalfOf !== undefined ? { onBehalfOf: caller.onBehalfOf } : {}),
  };
}

/** A Caller as a line names it: `token/ci`, then the name that jr2 shows and the party it acts for. */
export function callerText(caller: CallerRecord): string {
  return (
    `${caller.via}/${caller.name}` +
    (caller.shown !== undefined ? ` (${caller.shown})` : "") +
    (caller.onBehalfOf !== undefined ? ` on behalf of ${caller.onBehalfOf}` : "")
  );
}

// ---- The JWT authenticator ---------------------------------------------------------------------

/** The algorithms a JWT may be signed with: the asymmetric ones alone, because a published key
 * must not be able to sign. */
const ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

/** How far the issuer's clock and ours may differ, for `exp` and `nbf`. */
const CLOCK_TOLERANCE_S = 30;

/** How long the keys are kept before a JWT makes a fetch again. */
const KEYS_MAX_AGE_MS = 10 * 60_000;

/** The shortest time between two fetches of the keys, for a JWT whose key is not known; also how
 * long a failed fetch of the discovery document is kept before a JWT makes a fetch again. */
const KEYS_COOLDOWN_MS = 30_000;

/** How long one fetch of the discovery document or the keys may take. */
const FETCH_TIMEOUT_MS = 5_000;

/** The claims a {@link JwtIssuer} reads when its `claims` names no other. */
const DEFAULT_CLAIMS = { name: "sub", shown: "email", groups: "groups" } as const;

/** The fetch that the JWT authenticator uses: the global one, or a test's. */
export type JwksFetch = (url: string, init: { signal?: AbortSignal }) => Promise<Response>;

/** The options of {@link jwtAuthenticator}, for tests. */
export type JwtAuthenticatorOptions = {
  /** The fetch for the discovery document and the keys. Default: the global `fetch`. */
  fetch?: JwksFetch;
  /** The shortest time between two fetches of the keys, and of a discovery that failed. Default: 30 s. */
  cooldownMs?: number;
  /** The clock, in milliseconds, that measures the cooldown of a failed discovery. Default: `Date.now`. */
  now?: () => number;
};

type KeySet = ReturnType<typeof createRemoteJWKSet>;

/**
 * The JWT issuers' authenticator (ADR-0078). It claims a bearer that is a JWT whose `iss` claim is
 * the `issuer` of an entry in `issuers()`, which is read on each request, so a publish applies with
 * no restart. A claimed JWT that fails a check is "mine, and bad" (401). A JWT of an issuer that no
 * entry names is not claimed.
 */
export function jwtAuthenticator(
  issuers: () => readonly JwtIssuer[],
  opts: JwtAuthenticatorOptions = {},
): CallerAuthenticator {
  const doFetch: JwksFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const cooldownMs = opts.cooldownMs ?? KEYS_COOLDOWN_MS;
  const now = opts.now ?? Date.now;
  // The key sets, by the issuer and its keys' URL: an entry that a publish changes gets a new one.
  // `failedAt`: when its discovery failed. The failure is kept for the cooldown, so a flood of JWTs
  // that name an issuer whose discovery fails makes at most one fetch in each cooldown.
  const keySets = new Map<string, { keySet: Promise<KeySet>; failedAt?: number }>();
  const idOf = (entry: JwtIssuer): string => JSON.stringify([entry.issuer, entry.jwks ?? null]);

  const keySetOf = (entry: JwtIssuer): Promise<KeySet> => {
    const id = idOf(entry);
    const found = keySets.get(id);
    if (found && (found.failedAt === undefined || now() - found.failedAt < cooldownMs)) return found.keySet;
    const slot: { keySet: Promise<KeySet>; failedAt?: number } = {
      keySet: (async () => {
        const url = entry.jwks ?? (await discoverJwks(entry.issuer, doFetch));
        return createRemoteJWKSet(new URL(url), {
          cacheMaxAge: KEYS_MAX_AGE_MS,
          cooldownDuration: cooldownMs,
          timeoutDuration: FETCH_TIMEOUT_MS,
          [customFetch]: (u, init) => doFetch(u, { signal: init.signal }),
        });
      })(),
    };
    slot.keySet.catch(() => {
      slot.failedAt = now();
    });
    keySets.set(id, slot);
    return slot.keySet;
  };

  /** Drop the key sets of each issuer and keys' URL that the config no longer names: the cache
   * holds at most one entry for each entry of `issuers()`. */
  const prune = (current: readonly JwtIssuer[]): void => {
    if (keySets.size === 0) return;
    const named = new Set(current.map(idOf));
    for (const id of keySets.keys()) if (!named.has(id)) keySets.delete(id);
  };

  return async (bearer): Promise<CallerAnswer> => {
    if (bearer.split(".").length !== 3) return undefined;
    let unverified: JWTPayload;
    try {
      unverified = decodeJwt(bearer);
    } catch {
      return undefined;
    }
    const current = issuers();
    prune(current);
    const entry = current.find((i) => i.issuer === unverified.iss);
    if (!entry) return undefined;

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(bearer, await keySetOf(entry), {
        issuer: entry.issuer,
        audience: entry.audience,
        algorithms: ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: ["exp"],
      }));
    } catch (err) {
      return { refused: `a JWT of ${entry.issuer} did not verify: ${err instanceof Error ? err.message : err}` };
    }

    const claims = { ...DEFAULT_CLAIMS, ...entry.claims };
    const name = payload[claims.name];
    if (typeof name !== "string" || name === "") {
      return { refused: `a JWT of ${entry.issuer} has no "${claims.name}" claim, which names its Caller` };
    }
    const shown = payload[claims.shown];
    return {
      via: "jwt",
      name,
      ...(typeof shown === "string" && shown !== "" && shown !== name ? { shown } : {}),
      may: joinScopes(
        valuesOf(payload[claims.groups]).flatMap((v) => (Object.hasOwn(entry.groups, v) ? [entry.groups[v]!] : [])),
      ),
    };
  };
}

/** The `jwks_uri` of an issuer's OIDC discovery document. */
async function discoverJwks(issuer: string, doFetch: JwksFetch): Promise<string> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const doc = (await res.json()) as { jwks_uri?: unknown };
  if (typeof doc.jwks_uri !== "string") throw new Error(`${url} names no jwks_uri`);
  return doc.jwks_uri;
}

/** The values of a groups claim: a list of strings, or one string. */
function valuesOf(claim: unknown): string[] {
  if (typeof claim === "string") return [claim];
  if (Array.isArray(claim)) return claim.filter((v): v is string => typeof v === "string");
  return [];
}

/** The scopes of each grant, joined: a scope that one gives for every Workflow is for every
 * Workflow, and lists join. */
export function joinScopes(grants: readonly Scopes[]): Scopes {
  const out: Scopes = {};
  for (const scope of SCOPES) {
    let joined: ScopeGrant | undefined;
    for (const may of grants) {
      const grant = may[scope];
      if (grant === undefined) continue;
      if (grant === "all" || joined === "all") joined = "all";
      else joined = [...new Set([...(joined ?? []), ...grant])];
    }
    if (joined !== undefined) out[scope] = joined;
  }
  return out;
}
