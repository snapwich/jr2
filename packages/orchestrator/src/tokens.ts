// Bearer tokens (ADR-0013), because the Sandbox boundary is otherwise theater. The Harness
// container shares the pod's network namespace, so an Agent can reach the Orchestrator directly;
// a per-pod NetworkPolicy cannot distinguish its packets from the Custodian's. Only authentication
// closes this, and only the token bounds what a caller may DO (as opposed to where it may talk).
//
// Three principals. The asymmetry between the first two is the whole design; the third is a door
// key, not a seat:
//
//   Instance token  the human/CLI credential: the Caller `token/instance` (ADR-0078), with every
//                   scope, and the one credential of the routes no scope names. From the instance
//                   Secret (`JR2_INSTANCE_TOKEN`); minted per boot when absent, announced once on
//                   stdout (fixtures capture it). An Agent never has it — it never enters a Sandbox.
//                   The other Callers (named `jr2c_` tokens, JWTs) are below, under Callers:
//                   each acts within its scopes.
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
//                   five agent routes. The Harness process alone holds its secret Stand-in.
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
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { configMapDigest } from "./mount-digest.ts";
import { SCOPES, type AnswerGrant, type Scope, type Scopes } from "./config.ts";

// ---- Callers (ADR-0078) -----------------------------------------------------------------------
// A Caller acts on the Instance from outside its Machines: the CLI, a CI job, a bridge, a person in
// the Console. One seam makes it: an ORDERED list of authenticators. Each one takes the bearer and
// answers a Caller, "not mine", or "mine, and bad". The first that claims the bearer decides, so a
// bearer that one claims and finds bad is 401 and never falls through to the next. The Instance
// token is the first authenticator, the named `jr2c_` tokens the second, and the JWT issuers
// (callers.ts) the third. The principals inside the Orchestrator (the publish token, the control and fetch tokens)
// are outside the seam: no authenticator makes a Caller from one of them.

/** A request's Caller (ADR-0078): who acts, through which authenticator, and what it may do. */
export type Caller = {
  /** The authenticator that made the Caller: `token` (the Instance token or a named token), `jwt`
   * or `hook`. */
  via: "token" | "jwt" | "hook";
  /** The Caller's name for that authenticator: `instance`, a named token's name, a JWT's `sub`, a
   * Hook's name. */
  name: string;
  /** The name that jr2 shows, when it is not `name` (a JWT's `email`). */
  shown?: string;
  /** What the Caller may do. */
  may: Scopes;
  /** The Caller's claim about the party it acts for. jr2 records it and never checks it. */
  onBehalfOf?: string;
};

/** The header in which a Caller states the party it acts for (ADR-0078). A claim: jr2 records it
 * and shows it, and never checks it. */
export const ON_BEHALF_OF_HEADER = "jr2-on-behalf-of";

/** The longest `jr2-on-behalf-of` the guarded band takes: a user name, not a document. */
export const ON_BEHALF_OF_MAX = 256;

/** The prefix of a named Caller token's value (ADR-0078). It lets the seam say "not mine" with no
 * lookup, and lets a secret scanner find a value that leaked. */
export const CALLER_TOKEN_PREFIX = "jr2c_";

/** Every scope, for every Workflow: the Instance token's grant. */
const EVERY_SCOPE: Scopes = Object.fromEntries(SCOPES.map((s) => [s, "all"])) as Scopes;

/** The Instance token's Caller (ADR-0078): `token/instance`, with every scope for every Workflow. */
export function instanceCaller(): Caller {
  return { via: "token", name: "instance", may: { ...EVERY_SCOPE } };
}

/** Whether a Caller is the Instance token's. The config refuses a named token called `instance`,
 * so the pair names it alone. */
export function isInstanceCaller(caller: Caller): boolean {
  return caller.via === "token" && caller.name === "instance";
}

/** Whether a list item's Workflow name opens `workflow`. A wrapper's name opens each of its named
 * Charts (`plan` opens `plan/weekly`), because a named Chart runs its wrapper's Machine (ADR-0070). */
function nameOpens(name: string, workflow: string): boolean {
  if (name === workflow) return true;
  const cut = workflow.indexOf("/");
  return cut > 0 && name === workflow.slice(0, cut);
}

/** Whether `grant` opens `workflow`: for the `answer` scope, at least one Gate of it (ADR-0078). */
export function grantOpens(grant: AnswerGrant | undefined, workflow: string): boolean {
  if (grant === undefined) return false;
  if (grant === "all") return true;
  return grant.some((item) => nameOpens(typeof item === "string" ? item : item.workflow, workflow));
}

/** Whether an `answer` grant opens the Gate named `gate` (its invoke id, ADR-0011) of `workflow`:
 * a bare Workflow name opens each of its Gates, and a `{ workflow, gates }` item the Gates that it
 * names (ADR-0078). */
export function grantOpensGate(grant: AnswerGrant | undefined, workflow: string, gate: string): boolean {
  if (grant === undefined) return false;
  if (grant === "all") return true;
  return grant.some((item) =>
    typeof item === "string"
      ? nameOpens(item, workflow)
      : nameOpens(item.workflow, workflow) && item.gates.includes(gate),
  );
}

/** Whether a Caller has `scope` for `workflow`. For `answer`, that is at least one Gate of it:
 * {@link callerMayAnswer} asks for one Gate. */
export function callerMay(caller: Caller, scope: Scope, workflow: string): boolean {
  return grantOpens(caller.may[scope], workflow);
}

/** Whether a Caller may answer the Gate named `gate` (its invoke id) of a run of `workflow`
 * (ADR-0078). */
export function callerMayAnswer(caller: Caller, workflow: string, gate: string): boolean {
  return grantOpensGate(caller.may.answer, workflow, gate);
}

/** Whether a Caller has `scope` for at least one Workflow. */
export function callerHasScope(caller: Caller, scope: Scope): boolean {
  const grant = caller.may[scope];
  return grant !== undefined && (grant === "all" || grant.length > 0);
}

/** Whether `workflow` is in any scope of a Caller: what `GET /runs/resolve` answers for. */
export function callerMayAny(caller: Caller, workflow: string): boolean {
  return SCOPES.some((s) => callerMay(caller, s, workflow));
}

/** One authenticator's answer: a Caller; `{ refused }`, which is "mine, and bad" (401, and it never
 * falls through); or `undefined`, which is "not mine". */
export type CallerAnswer = Caller | { refused: string } | undefined;

/** One authenticator of the seam. An authenticator that must fetch (a JWT issuer's keys) answers
 * with a Promise. */
export type CallerAuthenticator = (bearer: string) => CallerAnswer | Promise<CallerAnswer>;

/** The Instance token's authenticator (ADR-0078). */
export function instanceTokenAuthenticator(instanceToken: string): CallerAuthenticator {
  return (bearer) => (constantTimeEqual(bearer, instanceToken) ? instanceCaller() : undefined);
}

/** A named token's entry as the Orchestrator holds it: its name, the sha-256 of its value, and its
 * scopes. Never the value (ADR-0078). */
export type NamedToken = { name: string; digest: string; may: Scopes };

/** The digest of a named token's value, as `jr2 up` gives it to the Orchestrator: sha-256, hex. */
export function callerTokenDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Make a named token's value: `jr2c_` and 32 random bytes in base64url (ADR-0078). */
export function mintCallerToken(): string {
  return CALLER_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * The named tokens' authenticator (ADR-0078). It claims every bearer with the `jr2c_` prefix, so a
 * value that no entry knows is 401 here, never a bearer for the next authenticator. `tokens` is read
 * on each request: a rotation or a new config applies with no restart.
 */
export function namedTokenAuthenticator(tokens: () => readonly NamedToken[]): CallerAuthenticator {
  return (bearer) => {
    if (!bearer.startsWith(CALLER_TOKEN_PREFIX)) return undefined;
    const digest = callerTokenDigest(bearer);
    // Each entry is compared, in constant time: the digest is not secret, but the loop does not
    // stop early, so the time does not say which entry is near.
    let found: NamedToken | undefined;
    for (const entry of tokens()) if (constantTimeEqual(digest, entry.digest)) found = entry;
    if (!found) return { refused: "no named Caller token has this value — it was rotated, or never made" };
    return { via: "token", name: found.name, may: found.may };
  };
}

/**
 * Join the named tokens that the config declares with the digests that `jr2 up` gave the
 * Orchestrator (ADR-0078). A declared name with no digest has no value yet, and a digest whose name
 * the config does not declare opens nothing.
 */
export function namedTokens(
  declared: Readonly<Record<string, { may: Scopes }>> | undefined,
  digests: Readonly<Record<string, string>>,
): NamedToken[] {
  return Object.entries(declared ?? {}).flatMap(([name, { may }]) => {
    const digest = digests[name];
    return typeof digest === "string" && digest !== "" ? [{ name, digest, may }] : [];
  });
}

/**
 * The digests of the named tokens, by name, from the file that `jr2 up` mounts into the
 * Orchestrator (`{ "<name>": "<sha-256 hex>" }`). The file is read again when it changes, so a
 * rotation needs no restart: the kubelet updates a mounted Secret on its own period, about a
 * minute, and until then the old value works (ADR-0078). `loaded` tells which content the process
 * holds, so `jr2 up` and `jr2 caller rotate` wait for it. An absent file reads as no digests. A file
 * that does not parse is logged, and the digests read last stay.
 */
export function watchCallerDigests(path: string, opts: { intervalMs?: number } = {}) {
  let digests: Record<string, string> = {};
  // The text that gave `digests`, so that `loaded` tells what the process holds now.
  let text: string | undefined;
  const read = () => {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      digests = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      );
      text = raw;
    } catch (err) {
      // Absent is the ordinary case for an Instance that declares no named token: no digest. A file
      // that does not parse keeps the digests read last, so a write seen half done stops no Caller.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        digests = {};
        text = undefined;
      } else console.error(`caller digests at ${path} not read: ${err instanceof Error ? err.message : err}`);
    }
  };
  read();
  // A poll of the file's stat, not `fs.watch`: the kubelet swaps a symlink above the file, which an
  // inotify watch on the old target never sees. `persistent: false` holds no process alive.
  const listener = () => read();
  watchFile(path, { interval: opts.intervalMs ?? 2000, persistent: false }, listener);
  return {
    /** The digests now. */
    current: (): Readonly<Record<string, string>> => digests,
    /**
     * The digest of the file content that gave the digests now, keyed by the file's name as a
     * mount's digest is (`configMapDigest`), so that `jr2 up` and `jr2 caller rotate` can wait
     * until a value they wrote works (ADR-0078). Undefined when no file was read.
     */
    loaded: (): string | undefined => (text === undefined ? undefined : configMapDigest({ [basename(path)]: text })),
    /** Read the file now (a test does not wait for the poll). */
    reload: read,
    stop: () => unwatchFile(path, listener),
  };
}

/** Who a request is, once its bearer token checks out. */
export type Principal =
  /** A Caller (ADR-0078): the Instance token, a named token, or a JWT. */
  | { kind: "caller"; caller: Caller }
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
export type Authenticator = (bearer: string | undefined, slot?: string) => Promise<Principal | undefined>;

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
 * The instance's authenticator: the principals inside the Orchestrator (the publish token, and any
 * Sandbox token this key signed), then the Caller seam (ADR-0078) in its order — the Instance
 * token, the named tokens, then `callers`. A token we did not mint resolves to nothing, and the
 * caller is refused — there is no anonymous principal, and no route decides for itself whether it
 * needs one.
 *
 * The principals come first because each is an exact value or a signed name: no Caller credential
 * has the form of one (a named token holds no `.`), so the order changes no answer, and no
 * authenticator of the seam ever sees a principal's token.
 */
export function createAuthenticator(opts: {
  instanceToken: string;
  signingKey: Buffer;
  /** The publish token (ADR-0069). Absent → no bearer resolves to the publisher. */
  publishToken?: string;
  /** The named tokens, read on each request (ADR-0078). Absent → none. */
  namedTokens?: () => readonly NamedToken[];
  /** More authenticators of the seam, after the named tokens: the JWT issuers (callers.ts). */
  callers?: readonly CallerAuthenticator[];
}): Authenticator {
  const seam: CallerAuthenticator[] = [
    instanceTokenAuthenticator(opts.instanceToken),
    ...(opts.namedTokens ? [namedTokenAuthenticator(opts.namedTokens)] : []),
    ...(opts.callers ?? []),
  ];
  const caller = async (bearer: string): Promise<Principal | undefined> => {
    for (const authenticate of seam) {
      const answer = await authenticate(bearer);
      if (answer === undefined) continue;
      // Claimed: the first claim decides, and a bad one never falls through.
      return "refused" in answer ? undefined : { kind: "caller", caller: answer };
    }
    return undefined;
  };
  return async (bearer, slot) => {
    if (!bearer) return undefined;
    if (opts.publishToken !== undefined && constantTimeEqual(bearer, opts.publishToken)) return { kind: "publisher" };
    const cut = bearer.lastIndexOf(".");
    if (cut <= 0) return caller(bearer);
    const name = bearer.slice(0, cut);
    if (!constantTimeEqual(bearer.slice(cut + 1), sign(opts.signingKey, name))) return caller(bearer);
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
  if (isInstancePrincipal(principal)) return true;
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
  if (isInstancePrincipal(principal)) return true;
  if (principal.kind !== "sandbox") return false;
  return principal.sandbox === sandbox;
}

/** Whether a principal is the Instance token's Caller: the operator, which the routes that no
 * scope names take alone (ADR-0014). A named token is never it, whatever its scopes. */
export function isInstancePrincipal(principal: Principal): boolean {
  return principal.kind === "caller" && isInstanceCaller(principal.caller);
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
