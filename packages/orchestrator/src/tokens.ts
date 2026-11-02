// Bearer tokens (ADR-0013), because the Sandbox boundary is otherwise theater. The Harness
// container shares the pod's network namespace, so an Agent can reach the Orchestrator directly;
// a per-pod NetworkPolicy cannot distinguish its packets from the Custodian's. Only authentication
// closes this, and only the token bounds what a caller may DO (as opposed to where it may talk).
//
// Three principals. The asymmetry between the first two is the whole design; the third is a door
// key, not a seat:
//
//   Instance token  the human/CLI credential. Full trust: gates, run control, agent surfaces.
//                   From the instance Secret (`JR2_INSTANCE_TOKEN`); minted per boot when absent,
//                   announced once on stdout (fixtures capture it). An Agent never has it — it
//                   never enters a Sandbox.
//
//   Publish token   `jr2 up`'s credential for `PUT /assembly` alone (ADR-0069). A publish imports
//                   code into the process that holds the ServiceAccount, so it must cost what an
//                   image roll cost: cluster write access. From the instance Secret
//                   (`JR2_PUBLISH_TOKEN`), read by `jr2 up` through the kube API only. Every other
//                   route answers it 403: it is a known token, but not one that route accepts.
//
//   Sandbox token   the Custodian's credentials, two of them, each valid on its own routes alone
//                   (ADR-0076). Both are signed names of a POD hosting Turns — a Sandbox, or the
//                   Instance Harness's Service name (ADR-0031) — and both live in the Custodian
//                   container ALONE, which no Workspace code reaches (ADR-0059):
//     control token   `agent:<pod>.<sig>`. Delivers to `kind: "agent"` registrations whose pod is
//                   THIS one, and only for the slot the Harness states (`X-Jr2-Slot`), on the
//                   four agent routes. The Harness process alone holds its secret Stand-in.
//     fetch token     `<pod>.<sig>`. Asks for a fetch for THIS Sandbox (ADR-0053), on
//                   `POST /sandboxes/<pod>/fetch` alone. Its Stand-in is public: it can do
//                   nothing else.
//                   Neither is ever a Gate's (a compromised Agent must not approve its own review),
//                   and neither reaches another pod (`coding.ts`'s iids are derivable and feature
//                   ids are readable from the Work Source, so a merely run-scoped token would let
//                   one feature's coder inject a verdict into another feature's reviewer).
//
// And one bearer the other way (ADR-0058), which is no principal here because this server never
// checks it:
//
//   Harness bearer  what the Orchestrator presents to the Harness in one pod — admit, stream,
//                   abort, echo. Derived per placement (`harnessToken`); the Harness holds only
//                   its sha-256 (`harnessTokenDigest`), so it verifies and mints nothing.
//
// The Sandbox token is a SIGNED NAME, not a random string in a table: `<sandbox>.<hmac(key, name)>`,
// verified by recomputing. Three things fall out that a token table would have to work for — the
// Orchestrator holds no per-Sandbox state, `provision` stays idempotent (re-minting yields the same
// token, so a re-applied Secret is a no-op), and a token minted before a restart still verifies
// after one, which is exactly what ADR-0012's re-attach promises the still-running Custodian.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Who a request is, once its bearer token checks out. */
export type Principal =
  /** The instance's own operator: the CLI, a human, a webhook translator holding the token. */
  | { kind: "instance" }
  /** `jr2 up`, publishing an Assembly (ADR-0069). Only `PUT /assembly` accepts it: it is not an
   * Instance principal, so it reads no run and starts none. */
  | { kind: "publisher" }
  /** One Sandbox's fetch token (ADR-0053, ADR-0076): asks for a fetch for that Sandbox, and does
   * nothing else. */
  | { kind: "sandbox"; sandbox: string }
  /** One pod's control token (ADR-0076), with the slot the Harness stated for the conversation
   * (`X-Jr2-Slot`): speaks on the agent routes for that slot's registrations in that pod, and for no
   * other. */
  | { kind: "agent"; sandbox: string; slot: string };

/** The header the Harness states a control request's slot in (ADR-0076): the Agent's actor path
 * and agent name, its continued conversation's Instance ID without the run id. */
export const SLOT_HEADER = "x-jr2-slot";

/** Resolve a bearer token, and the slot a control request states, to a principal; undefined = not a
 * token we minted, or a control token with no slot (→ 401). */
export type Authenticator = (bearer: string | undefined, slot?: string) => Principal | undefined;

/** The fetch token for one Sandbox: its name, signed. Same name + key → same token, always. The
 * bare form of ADR-0013's Sandbox token; since ADR-0076 it opens the fetch route alone. */
export function sandboxToken(key: Buffer, sandbox: string): string {
  return `${sandbox}.${sign(key, sandbox)}`;
}

/** The domain of a control token's signed name (ADR-0076). No DNS label holds a `:`, so a control
 * token is never read as a fetch token, nor the reverse. */
const CONTROL_PREFIX = "agent:";

/**
 * The control token for one pod (ADR-0076): what the Custodian puts in place of the secret control
 * Stand-in on the agent routes. A signed name like the fetch token — same key, same deterministic
 * re-mint — in its own `agent:` domain. No slot is inside it: the Harness states the slot on each
 * request, and the Orchestrator checks it against the registration's.
 */
export function controlToken(key: Buffer, pod: string): string {
  const name = `${CONTROL_PREFIX}${pod}`;
  return `${name}.${sign(key, name)}`;
}

/**
 * The secret control Stand-in for one pod (ADR-0076, ADR-0059): the bearer the Harness process
 * alone holds, as a file under `/run/jr2/` that no confined child can read, and that the Custodian
 * swaps for {@link controlToken} on the agent routes. A 43-character base64url HMAC, so no
 * Workspace code can guess it. Its own `control-standin:` domain keeps it apart from every token.
 */
export function controlStandIn(key: Buffer, pod: string): string {
  return sign(key, `control-standin:${pod}`);
}

/**
 * The Harness bearer for one placement (ADR-0058): what the Orchestrator presents on every Harness
 * wire call — admit, stream, abort, echo — to the Harness in the pod `placement` names (a
 * Sandbox, or `jr2-instance-harness`). The same signed-name idea as the Sandbox token, turned the
 * other way: here the Orchestrator is the CALLER. Deterministic for the same reason — a restarted
 * Orchestrator re-derives the bearer a live Harness already checks against.
 *
 * Domain-separated from `sandboxToken` by the `harness:` prefix, which no DNS-label name can
 * produce, so no Sandbox token ever doubles as a Harness bearer or the reverse.
 */
export function harnessToken(key: Buffer, placement: string): string {
  return sign(key, `harness:${placement}`);
}

/**
 * What the Harness in `placement` holds to CHECK its bearer: the sha-256 of it, never the bearer
 * (ADR-0058). The Agent executes code in that container, and a digest inverts to nothing — so the
 * Harness can verify its own bearer and can mint none, for itself or for any other pod.
 */
export function harnessTokenDigest(key: Buffer, placement: string): string {
  return createHash("sha256").update(harnessToken(key, placement)).digest("base64url");
}

/**
 * The signing key of one Effector placement (ADR-0068): `HMAC(signing key, "effector:" + placement)`,
 * as the Harness bearer is derived (ADR-0058). The Orchestrator signs every request to that
 * Effector with it and verifies every answer; the Effector reads it from a file in its own mount,
 * which `jr2 up` writes (`instance` → the `jr2-instance-effector` Secret). Derived, not stored: a
 * restarted Orchestrator derives the key a live Effector already holds. The `effector:` prefix
 * keeps it apart from every Sandbox token and Harness bearer. The key's bytes are this string's.
 */
export function effectorKey(key: Buffer, placement: string): string {
  return sign(key, `effector:${placement}`);
}

/** Mint the per-boot Instance token (opaque and random — it names nothing, it just IS the trust).
 * The publish token is minted the same way when the Secret supplies none (ADR-0069). */
export function mintInstanceToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The instance's HMAC signing key, at `<dir>/.jr2/secret` (0600), created on first use.
 *
 * It MUST outlive the process: an Orchestrator restart leaves live Sandboxes running (ADR-0012 re-attach),
 * and their Custodians still hold tokens minted by the process that died. A fresh key would reject
 * every one of them — the Agent would silently lose its only route to its Machine.
 */
export async function loadSigningKey(dir: string): Promise<Buffer> {
  const path = join(dir, ".jr2", "secret");
  try {
    const existing = Buffer.from(await readFile(path, "utf8"), "base64");
    if (existing.length >= 32) return existing;
  } catch {
    // absent (or unreadable) → mint below
  }
  const key = randomBytes(32);
  await mkdir(join(dir, ".jr2"), { recursive: true });
  await writeFile(path, key.toString("base64"), { mode: 0o600 });
  await chmod(path, 0o600); // an existing file keeps its old mode through writeFile
  return key;
}

/**
 * The instance's authenticator: the Instance token, plus any Sandbox token this key signed.
 * A token we did not mint resolves to nothing, and the caller is refused — there is no anonymous
 * principal, and no route decides for itself whether it needs one.
 */
export function createAuthenticator(opts: {
  instanceToken: string;
  signingKey: Buffer;
  /** The publish token (ADR-0069). Absent → no bearer resolves to the publisher. */
  publishToken?: string;
}): Authenticator {
  return (bearer, slot) => {
    if (!bearer) return undefined;
    if (constantTimeEqual(bearer, opts.instanceToken)) return { kind: "instance" };
    if (opts.publishToken !== undefined && constantTimeEqual(bearer, opts.publishToken)) return { kind: "publisher" };
    const cut = bearer.lastIndexOf(".");
    if (cut <= 0) return undefined;
    const name = bearer.slice(0, cut);
    if (!constantTimeEqual(bearer.slice(cut + 1), sign(opts.signingKey, name))) return undefined;
    // A control token (ADR-0076), read BEFORE the bare form. A control request states its slot; one
    // that states none is refused like an unknown token, so no route ever sees a control principal
    // without a slot.
    if (name.startsWith(CONTROL_PREFIX)) {
      const pod = name.slice(CONTROL_PREFIX.length);
      if (!isPodName(pod) || !slot) return undefined;
      return { kind: "agent", sandbox: pod, slot };
    }
    // The bare fetch token, in its own domain alone: a name in any other domain (`harness:`,
    // `control-standin:`, `held-standin:` …) is not a Sandbox's, whatever key signed it.
    if (!isPodName(name)) return undefined;
    return { kind: "sandbox", sandbox: name };
  };
}

/** A pod's name as a token signs it: a DNS-1123 name, so it holds no `:` and no `/` — the marks of
 * every other signed domain (ADR-0076). */
function isPodName(name: string): boolean {
  return /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name);
}

/**
 * May this principal speak on this agent registration's routes — its surface, a pick, a delivery's
 * poll, a notice's acknowledgment? The Instance token may (it is the operator). A control token may
 * only when the registration records ITS pod — which is why an Agent registration carries `sandbox`
 * at all (ADR-0013) — AND the slot the Harness stated is the registration's (ADR-0076). The recorded
 * pod is the one hosting the Turn: a Workspace's Sandbox, or `jr2-instance-harness` for a Menu-only
 * registration (ADR-0031). An agent registration with NO pod at all is an explicit-`endpoint` run
 * (the stub Harness on the host, in no pod): no pod's token can claim it. A fetch token never may:
 * it opens the fetch route alone.
 *
 * The slot check finds a routing fault. It is not the boundary: only the Harness process holds the
 * control Stand-in, so only the Harness can state a slot at all (ADR-0076).
 */
export function mayDeliverToAgent(principal: Principal, registration: { sandbox?: string; slot?: string }): boolean {
  if (principal.kind === "instance") return true;
  if (principal.kind !== "agent") return false;
  return (
    registration.sandbox !== undefined &&
    registration.sandbox === principal.sandbox &&
    registration.slot !== undefined &&
    registration.slot === principal.slot
  );
}

/**
 * May this principal ask for a fetch on this Sandbox (ADR-0053)? A fetch token may ask for its
 * OWN pod and no other — the scope is the caches that pod mounts, and the route refuses a Repo it
 * does not. The Instance token may, on the same grounds it may deliver to any agent surface: it is
 * the operator. A control token may not: it opens the agent routes alone (ADR-0076). The publish
 * token may not: it opens the publish door and no other (ADR-0069).
 */
export function mayAskForSandbox(principal: Principal, sandbox: string): boolean {
  if (principal.kind === "instance") return true;
  if (principal.kind !== "sandbox") return false;
  return principal.sandbox === sandbox;
}

/** Whether a principal is an Agent's — a control token or a fetch token. A Gate refuses every one
 * (ADR-0013, ADR-0076): an Agent never reaches a Gate. */
export function isAgentPrincipal(principal: Principal): boolean {
  return principal.kind === "agent" || principal.kind === "sandbox";
}

/** An HMAC of `value` under the signing key, base64url (43 characters). Exported so every signed
 * name and Stand-in derives one way. */
export function sign(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

/** Compare without leaking the answer through timing. Unequal lengths are unequal, cheaply. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
