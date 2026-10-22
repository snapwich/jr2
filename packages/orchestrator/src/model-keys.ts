// The known model keys (ADR-0059): every env var pi's catalog reads a provider's credential from,
// the catalog provider(s) that read it, and the one host those providers' calls go to by default.
//
// pi's data at the exact pin `@jr2/harness` holds, made into plain data by a script, because this
// package has no pi dependency and must not grow one: `jr2 up` reads this table host-side (R1, and
// the default `hosts` of a held secret), and the in-cluster Orchestrator never touches pi. The table
// is `model-keys.generated.ts`, and `just model-keys` writes it from pi-ai at each pi bump
// (`packages/harness/scripts/model-keys.ts`). It cannot drift silently: `@jr2/harness`'s
// `model-keys.test.ts` checks it against pi itself, env names per provider and every provider's
// default host, in the default gate. A pi bump that adds or moves a provider fails there first, the
// same canary role Harness conformance plays (ADR-0027).
//
// `host` is present only when every model of every provider that reads the name goes to ONE static
// host. It is absent when there is none: the base URL is a template (`{location}`, an account id),
// the providers disagree (MOONSHOT_API_KEY serves two regions), or the host is regional (Bedrock).
// A held secret with such a name must then say its `hosts` itself (§3.4 of the spec, R5).
//
// Two facts the data does not say. anthropic reads three names: AUTH_TOKEN goes as `Authorization:
// Bearer`, the other two as `x-api-key` (an `sk-ant-oat` value is an OAuth token, which a Stand-in
// never is). AWS_BEARER_TOKEN_BEDROCK is the bearer form of Bedrock auth, which pi reads through
// its credential chain; SigV4 credentials cannot be held at all — a signature is not a header a
// Stand-in can be swapped into — and `jr2 up` warns on them (`SIGNING_CREDENTIALS`).

import { MODEL_KEYS } from "./model-keys.generated.ts";

export { MODEL_KEYS };

/** One known model-key env name. */
export type ModelKey = {
  /** The catalog provider ids that read this name. */
  providers: readonly string[];
  /** The host (port 443) those providers' calls go to by default, when there is exactly one. */
  host?: string;
};

/** Every catalog provider id some known model key belongs to — the set `harness.catalog` may name. */
export const MODEL_KEY_PROVIDERS: ReadonlySet<string> = new Set(
  Object.values(MODEL_KEYS).flatMap((key) => key.providers),
);

/**
 * Credentials that sign a request instead of riding it in a header (ADR-0059). A Stand-in cannot be
 * swapped into a signature, so these cannot be held — `jr2 up` warns when `harness.env` sets one,
 * because the Agent can read it, and names a gateway as the way out.
 */
export const SIGNING_CREDENTIALS: readonly string[] = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
];
