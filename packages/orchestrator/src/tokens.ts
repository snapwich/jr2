// Bearer tokens (ADR-0013), because the Sandbox boundary is otherwise theater. The Harness
// container shares the pod's network namespace, so an Agent can reach the Orchestrator directly;
// a per-pod NetworkPolicy cannot distinguish its packets from the Adapter's. Only authentication
// closes this, and only the token bounds what a caller may DO (as opposed to where it may talk).
//
// Two principals, and the asymmetry between them is the whole design:
//
//   Instance token  the human/CLI credential. Full trust: gates, run control, agent surfaces.
//                   From the instance Secret (`J2_INSTANCE_TOKEN`); minted per boot when absent,
//                   announced once on stdout (fixtures capture it). An Agent never has it — it
//                   never enters a Sandbox.
//
//   Sandbox token   the Adapter's credential. Authorizes exactly: deliver to `kind: "agent"`
//                   registrations whose Sandbox is THIS one. Never a Gate (a compromised Agent
//                   must not approve its own review), never another Sandbox (`coding.ts`'s iids
//                   are derivable and feature ids are readable from the Work Source, so a merely
//                   run-scoped token would let one feature's coder inject a verdict into another
//                   feature's reviewer). Delivered as a Secret via the CR's `envFrom` into the
//                   Adapter container ALONE, which is the one place the Agent cannot read.
//                   The signed name is a POD hosting Turns, not a Sandbox CR per se: the Instance
//                   Harness's Adapter bears one signed for that placement's Service name
//                   (ADR-0031), scoping it to the Menu-only registrations placed there.
//
// The Sandbox token is a SIGNED NAME, not a random string in a table: `<sandbox>.<hmac(key, name)>`,
// verified by recomputing. Three things fall out that a token table would have to work for — the
// Orchestrator holds no per-Sandbox state, `provision` stays idempotent (re-minting yields the same
// token, so a re-applied Secret is a no-op), and a token minted before a restart still verifies
// after one, which is exactly what ADR-0012's re-attach promises the still-running Adapter.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Who a request is, once its bearer token checks out. */
export type Principal =
  /** The instance's own operator: the CLI, a human, a webhook translator holding the token. */
  | { kind: "instance" }
  /** One Sandbox's Adapter, speaking for the Agent in that pod — and for no one else. */
  | { kind: "sandbox"; sandbox: string };

/** Resolve a bearer token to a principal; undefined = not a token we minted (→ 401). */
export type Authenticator = (bearer: string | undefined) => Principal | undefined;

/** The Sandbox token for one Sandbox: its name, signed. Same name + key → same token, always. */
export function sandboxToken(key: Buffer, sandbox: string): string {
  return `${sandbox}.${sign(key, sandbox)}`;
}

/** Mint the per-boot Instance token (opaque and random — it names nothing, it just IS the trust). */
export function mintInstanceToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The instance's HMAC signing key, at `<dir>/.j2/secret` (0600), created on first use.
 *
 * It MUST outlive the process: an Orchestrator restart leaves live Sandboxes running (ADR-0012 re-attach),
 * and their Adapters still hold tokens minted by the process that died. A fresh key would reject
 * every one of them — the Agent would silently lose its only route to its Machine.
 */
export async function loadSigningKey(dir: string): Promise<Buffer> {
  const path = join(dir, ".j2", "secret");
  try {
    const existing = Buffer.from(await readFile(path, "utf8"), "base64");
    if (existing.length >= 32) return existing;
  } catch {
    // absent (or unreadable) → mint below
  }
  const key = randomBytes(32);
  await mkdir(join(dir, ".j2"), { recursive: true });
  await writeFile(path, key.toString("base64"), { mode: 0o600 });
  await chmod(path, 0o600); // an existing file keeps its old mode through writeFile
  return key;
}

/**
 * The instance's authenticator: the Instance token, plus any Sandbox token this key signed.
 * A token we did not mint resolves to nothing, and the caller is refused — there is no anonymous
 * principal, and no route decides for itself whether it needs one.
 */
export function createAuthenticator(opts: { instanceToken: string; signingKey: Buffer }): Authenticator {
  return (bearer) => {
    if (!bearer) return undefined;
    if (constantTimeEqual(bearer, opts.instanceToken)) return { kind: "instance" };
    const cut = bearer.lastIndexOf(".");
    if (cut <= 0) return undefined;
    const sandbox = bearer.slice(0, cut);
    if (!constantTimeEqual(bearer.slice(cut + 1), sign(opts.signingKey, sandbox))) return undefined;
    return { kind: "sandbox", sandbox };
  };
}

/**
 * May this principal deliver to this agent registration? The Instance token may (it is the
 * operator). A Sandbox token may only when the registration records ITS name — which is why
 * an Agent registration carries `sandbox` at all (ADR-0013). The recorded name is the pod hosting the Turn:
 * a Workspace's Sandbox, or `j2-instance-harness` for a Menu-only registration (ADR-0031). An
 * agent registration with NO name at all is an explicit-`endpoint` run (the stub Harness on the
 * host, in no pod): no Sandbox token can claim it.
 */
export function mayDeliverToAgent(principal: Principal, registrationSandbox: string | undefined): boolean {
  if (principal.kind === "instance") return true;
  return registrationSandbox !== undefined && registrationSandbox === principal.sandbox;
}

function sign(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

/** Compare without leaking the answer through timing. Unequal lengths are unequal, cheaply. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
