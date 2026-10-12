// The Effector's wire, from the Orchestrator's side (ADR-0068): the request it encodes, the
// answers it decodes, the signatures on both, and the client that speaks it.
//
// The types are written by hand, here and in Go (`effector/internal/wire`). Here each zod shape is
// the one definition, and each type is inferred from it.
// The golden fixtures in `effector/testdata/wire/` keep the two equal: these tests encode each
// request fixture's shape and decode each answer; the Go tests do the reverse. An answer that does
// not decode strictly is a jr2 defect, never an outcome.
//
// No bearer: every request is signed with the placement's key (`effectorKey`), and every answer
// must carry the Effector's signature over its status, the request's method, path and nonce, and
// its body — an answer bound to this request. An unsigned or mis-signed answer is not the Effector's.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { z } from "zod";

// --- The request (POST /effects/<id>) ------------------------------------------------------------
//
// Each zod shape is the one definition of its part of the wire; each type is inferred from it.

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export const HttpMethodShape = z.enum(HTTP_METHODS);
export type HttpMethod = z.infer<typeof HttpMethodShape>;

/** One part of a string the Effector builds: literal text, or a secret it holds, by name. A
 * secret's value is never on the wire. */
export const TextPartShape = z.union([z.strictObject({ text: z.string() }), z.strictObject({ secret: z.string() })]);
export type TextPart = z.infer<typeof TextPartShape>;

export const WireAuthShape = z.union([
  z.strictObject({ bearer: z.strictObject({ secret: z.string() }) }),
  z.strictObject({ basic: z.strictObject({ user: z.array(TextPartShape), password: z.array(TextPartShape) }) }),
  z.strictObject({ text: z.array(TextPartShape) }),
]);
export type WireAuth = z.infer<typeof WireAuthShape>;

/** A Worktree file (a file-body `http`, ADR-0067): the Worktree, relative to the work
 * root, and the file, relative to the Worktree. The Sandbox Effector opens both beneath, with no
 * symlink, and refuses a FIFO and a file with more than one link — output, with nothing sent. */
export const FileRefShape = z.strictObject({
  worktree: z.string(),
  path: z.string(),
  contentType: z.string().optional(),
});
export type FileRef = z.infer<typeof FileRefShape>;

export const WireBodyShape = z.union([
  z.strictObject({ json: z.unknown() }),
  z.strictObject({ text: z.string() }),
  z.strictObject({ file: FileRefShape }),
]);
export type WireBody = z.infer<typeof WireBodyShape>;

/** The headers the Effector sets itself, which a definition may not: they frame or route the
 * request. A `proxy-*` name is one too. The Go side's `framing` is the same list; the reject
 * fixtures hold one start per name, which each side refuses. */
export const FRAMING_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
]);
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;

/** A header an Effect may set: a lowercase name that does not frame or route the request. */
export const isEffectHeader = (name: string): boolean =>
  HEADER_NAME.test(name) && !FRAMING_HEADERS.has(name) && !name.startsWith("proxy-");

/** An `http` start; its body may be a Worktree file (ADR-0067), which only a Sandbox Effector serves. */
export const HttpStartShape = z.strictObject({
  kind: z.literal("http"),
  method: HttpMethodShape,
  url: z.array(TextPartShape),
  path: z.array(z.string()).optional(),
  headers: z.record(z.string().refine(isEffectHeader), z.array(TextPartShape)).optional(),
  auth: WireAuthShape.optional(),
  body: WireBodyShape.optional(),
  timeoutMs: z.number().int(),
  maxBody: z.number().int(),
});
export type HttpStartRequest = z.infer<typeof HttpStartShape>;

/** Where one Repo Slot's repositories are in a Sandbox pod (ADR-0004, ADR-0051): the Agent's
 * common git dir and Worktree, relative to `/work`, and the node cache's key under `/repos`. */
export const RepoRefShape = z.strictObject({ gitDir: z.string(), worktree: z.string(), cache: z.string() });
export type RepoRef = z.infer<typeof RepoRefShape>;

/** One push's published commit and the Agent's commit it was made from: the ledger's pair, with
 * that push's own `squashed` — what its published commit is, which a later push that maps the same
 * commit names (ADR-0067). */
export const PairShape = z.strictObject({
  published: z.string(),
  source: z.string(),
  squashed: z.enum(["signed", "unsigned"]).optional(),
});
export type Pair = z.infer<typeof PairShape>;

/** A `push` start: the Workspace's branch to the Repo Slot's Binding, with the push credential of
 * the `git.credentials` entry the url falls under — the Effector's config holds the entries, and
 * matches the url as the fence does (`credential` names one by its `match` instead). `pin` is the
 * commit; absent, the Effector reads the Agent's branch tip and its answer carries it (`pinned`). */
export const PushStartShape = z.strictObject({
  kind: z.literal("push"),
  push: z.strictObject({
    repo: RepoRefShape,
    url: z.string(),
    branch: z.string(),
    credential: z.string().optional(),
    pin: z.string().optional(),
    sign: z.boolean().optional(),
    squash: z.string().optional(),
    force: z.boolean().optional(),
    last: PairShape.optional(),
  }),
  timeoutMs: z.number().int(),
});
export type PushStartRequest = z.infer<typeof PushStartShape>;

/** One variable of a credentialed command's env: a secret's value, or (`path`) its file's path. */
export const EnvRefShape = z.strictObject({ secret: z.string(), path: z.boolean().optional() });
export type EnvRef = z.infer<typeof EnvRefShape>;

/** A credentialed `command` start: argv against the pinned commit, with only the env named. */
export const CommandStartShape = z.strictObject({
  kind: z.literal("command"),
  command: z.strictObject({
    repo: RepoRefShape,
    branch: z.string(),
    pin: z.string().optional(),
    argv: z.array(z.string()).min(1),
    env: z.record(z.string(), EnvRefShape),
    tail: z.number().int(),
  }),
  timeoutMs: z.number().int(),
});
export type CommandStartRequest = z.infer<typeof CommandStartShape>;

/** Every start: the http kinds, a push, a credentialed command. */
export const StartRequestShape = z.union([HttpStartShape, PushStartShape, CommandStartShape]);
export type StartRequest = z.infer<typeof StartRequestShape>;

/** The most bytes of a start's body the Effector reads (its `maxRequestBody`). A longer body
 * cannot be verified, so the Effector refuses it as unsigned; the Orchestrator never sends one. */
export const MAX_START_BYTES = 4 << 20;

// --- The answers ---------------------------------------------------------------------------------

/** The `response` outcome: a status came back. The body is there when it is text, bounded and
 * scrubbed; a body that is not text is its size and content type only. */
export const HttpResponseShape = z.strictObject({
  outcome: z.literal("response"),
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  body: z.string().optional(),
  truncated: z.boolean().optional(),
});
export type HttpResponse = z.infer<typeof HttpResponseShape>;

/**
 * An `http` Effect's output. Every outcome is output (ADR-0067): `response`; `unreachable` (nothing
 * was sent); `refused` (the Effector refused it and sent nothing — a path segment that is `.`, `..`
 * or empty, a host no Effect placed there names); `unknown` (it may have been sent, and no answer
 * came — or jr2 cannot tell, after a restart or a state exit).
 */
export const HttpOutputShape = z.union([
  HttpResponseShape,
  z.strictObject({ outcome: z.enum(["unreachable", "refused", "unknown"]), reason: z.string() }),
]);
export type HttpOutput = z.infer<typeof HttpOutputShape>;

/**
 * A `push` Effect's output (ADR-0067). `pushed`: the published commit, its source (the Agent's
 * commit), what the remote held before, how the new commits were found after a signed push
 * (`ancestry | pair | cherry | force`), `unchanged` when the remote held it already, `squashed`
 * when the published commit is one squashed commit (`signed | unsigned`; absent for signed
 * copies; what the published commit is, an earlier push's included, never only this push's
 * options), and — when the published commit is not the Agent's own — the published commits as a
 * bundle for the sync. `rejected`: a stage and git's words. `diverged`: the
 * published commit is not in the Agent's history and nothing paired it; nothing was pushed.
 */
export const PushOutputShape = z.union([
  z.strictObject({
    outcome: z.literal("pushed"),
    published: z.string(),
    source: z.string(),
    previous: z.string().optional(),
    via: z.string().optional(),
    unchanged: z.boolean().optional(),
    squashed: z.enum(["signed", "unsigned"]).optional(),
    bundle: z.string().optional(),
  }),
  z.strictObject({
    outcome: z.literal("rejected"),
    stage: z.string(),
    reason: z.string(),
    detail: z.string().optional(),
  }),
  z.strictObject({ outcome: z.literal("diverged"), reason: z.string(), published: z.string(), source: z.string() }),
  z.strictObject({ outcome: z.literal("unknown"), reason: z.string() }),
]);
export type PushWireOutput = z.infer<typeof PushOutputShape>;

/** A credentialed command's output, as the command kind's (ADR-0067), and `dirty` when the
 * Worktree held uncommitted edits it did not see. */
export const CommandOutputShape = z.union([
  z.strictObject({
    outcome: z.literal("exited"),
    code: z.number().int(),
    tail: z.string(),
    dirty: z.boolean().optional(),
  }),
  z.strictObject({ outcome: z.literal("timeout"), tail: z.string(), dirty: z.boolean().optional() }),
  z.strictObject({ outcome: z.literal("killed"), signal: z.string(), tail: z.string(), dirty: z.boolean().optional() }),
  z.strictObject({ outcome: z.literal("unknown"), reason: z.string() }),
]);
export type CommandWireOutput = z.infer<typeof CommandOutputShape>;

/** The replica that holds an Effect, and where to poll it. */
export const ReplicaShape = z.strictObject({ name: z.string(), address: z.string() });
export type Replica = z.infer<typeof ReplicaShape>;

/** Every answer of `POST` and `GET /effects/<id>`. */
export const EffectStateShape = z.strictObject({
  effect: z.string(),
  replica: ReplicaShape,
  state: z.enum(["running", "settled", "unknown"]),
  /** The commit a push or a credentialed command runs against, read when it started: the
   * Orchestrator writes it to the ledger's intent row. */
  pinned: z.string().optional(),
  output: z.union([HttpOutputShape, PushOutputShape, CommandOutputShape]).optional(),
});
export type EffectState = z.infer<typeof EffectStateShape>;

/** A refusal's body: the reason, and the replica when it names one. */
export const RefusalShape = z.strictObject({ error: z.string(), replica: ReplicaShape.optional() });

// --- Signatures ----------------------------------------------------------------------------------

export const HEADER_TIME = "x-jr2-time";
export const HEADER_NONCE = "x-jr2-nonce";
export const HEADER_SIGNATURE = "x-jr2-signature";

const digest = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");
const mac = (key: Buffer | string, parts: string[]): string =>
  createHmac("sha256", key).update(parts.join("\n"), "utf8").digest("base64url");

/** A request's signature: over its method, the address it is sent to (the replica's `host:port`),
 * its path, time, nonce and the sha-256 of its body. */
export function requestMac(
  key: Buffer | string,
  method: string,
  address: string,
  path: string,
  time: string,
  nonce: string,
  body: string,
): string {
  return mac(key, ["jr2-effector-request", method, address, path, time, nonce, digest(body)]);
}

/** An answer's signature: over its status, the request's method, path and nonce, and its body. */
export function responseMac(
  key: Buffer | string,
  status: number,
  method: string,
  path: string,
  nonce: string,
  body: string,
): string {
  return mac(key, ["jr2-effector-response", String(status), method, path, nonce, digest(body)]);
}

// --- The transport -------------------------------------------------------------------------------

/** One raw exchange with one replica. */
export type RawAnswer = { status: number; headers: Record<string, string>; body: string };

/**
 * How the client reaches a placement's replicas — the seam the unit tests inject (ADR-0010): the
 * real one dials the headless Service's addresses; a test's answers in-process.
 */
export interface EffectorTransport {
  /** Every replica's address now (`host:port`). */
  replicas(signal?: AbortSignal): Promise<string[]>;
  /** One request to one replica. Rejects on a transport failure; a status is an answer. */
  send(
    address: string,
    method: "POST" | "GET",
    path: string,
    headers: Record<string, string>,
    body: string,
    signal?: AbortSignal,
  ): Promise<RawAnswer>;
}

/** The request certainly never reached a replica (no address, the connection was refused, the name
 * did not resolve), or the replica that got it refused to start it because it is stopping: sending
 * it again starts it at most once. */
export class EffectorNotSent extends Error {}

/** The Effector refused the request as malformed (400): a jr2 or config defect, never retried. */
export class EffectorRefused extends Error {}

/** An answer that is not the Effector's: unsigned, or signed with another key. No retry changes the
 * key it is checked with, so the Effect that gets one settles `unknown` (ADR-0068). */
export class EffectorForged extends Error {}

/** An answer the placement's key verifies that is not the wire's shape: a jr2 defect, never an
 * outcome, never retried. */
export class EffectorMalformed extends Error {}

/** The Effector's wire, as an Effect drives it. */
export interface EffectorPort {
  /** POST: start the Effect on some replica, or attach to it. Rejects with `EffectorNotSent` only
   * when no replica can have started it; any other rejection may follow a start. */
  start(id: string, req: StartRequest, signal: AbortSignal): Promise<EffectState>;
  /** GET on the replica that holds it: settled, still running after the hold, or `unknown`. */
  poll(replica: Replica, id: string, signal: AbortSignal): Promise<EffectState>;
  /** Ask every replica: the state of the one that holds it, or undefined when every replica
   * answered that it holds no such Effect. Rejects when a replica could not answer. */
  find(id: string, signal: AbortSignal): Promise<EffectState | undefined>;
}

/** The signed client over a transport. `key` is the placement's (`effectorKey`). */
export function createEffectorClient(opts: {
  key: Buffer | string;
  transport: EffectorTransport;
  now?: () => number;
}): EffectorPort {
  const { key, transport } = opts;
  const now = opts.now ?? Date.now;

  const exchange = async (
    address: string,
    method: "POST" | "GET",
    id: string,
    body: string,
    signal: AbortSignal,
  ): Promise<RawAnswer> => {
    const path = `/effects/${encodeURIComponent(id)}`;
    const time = String(now());
    const nonce = randomBytes(16).toString("hex");
    const headers = {
      "content-type": "application/json",
      [HEADER_TIME]: time,
      [HEADER_NONCE]: nonce,
      // Signed for the replica it is sent to: another replica, or this one after a restart, refuses
      // it sent again (ADR-0068).
      [HEADER_SIGNATURE]: requestMac(key, method, address, path, time, nonce, body),
    };
    const answer = await transport.send(address, method, path, headers, body, signal);
    const signature = answer.headers[HEADER_SIGNATURE] ?? "";
    const want = responseMac(key, answer.status, method, path, nonce, answer.body);
    if (!sameString(signature, want)) {
      throw new EffectorForged(
        `the answer to ${method} ${path} from ${address} (${answer.status}) does not carry the Effector's signature`,
      );
    }
    return answer;
  };
  const state = (answer: RawAnswer, what: string): EffectState => {
    const parsed = EffectStateShape.safeParse(parseJson(answer.body));
    if (!parsed.success) throw new EffectorMalformed(`the Effector's answer to ${what} is not the wire's shape`);
    return parsed.data;
  };
  const refusal = (answer: RawAnswer): string => {
    const parsed = RefusalShape.safeParse(parseJson(answer.body));
    return parsed.success ? parsed.data.error : `status ${answer.status}`;
  };

  const ask = async (address: string, id: string, signal: AbortSignal): Promise<EffectState> => {
    const answer = await exchange(address, "GET", id, "", signal);
    if (answer.status === 200 || answer.status === 404) return state(answer, "a poll");
    throw new Error(`the Effector at ${address} answered a poll with ${answer.status}: ${refusal(answer)}`);
  };

  return {
    start: async (id, req, signal) => {
      const body = JSON.stringify(req);
      const addresses = shuffle(await transport.replicas(signal).catch(notSent));
      if (addresses.length === 0) throw new EffectorNotSent("no Effector replica is serving");
      let last: unknown;
      for (const address of addresses) {
        let answer: RawAnswer;
        try {
          answer = await exchange(address, "POST", id, body, signal);
        } catch (err) {
          // A replica that was never reached is the one failure the next replica may follow.
          if (err instanceof EffectorNotSent || (!signal.aborted && neverReached(err))) {
            last = err;
            continue;
          }
          throw err;
        }
        if (answer.status === 202 || answer.status === 200) return state(answer, "a start");
        if (answer.status === 503) {
          // A stopping replica started nothing: another may take it.
          last = new EffectorNotSent(`the Effector replica at ${address} is stopping`);
          continue;
        }
        if (answer.status === 400) throw new EffectorRefused(`the Effector refused the request: ${refusal(answer)}`);
        throw new Error(`the Effector answered a start with ${answer.status}: ${refusal(answer)}`);
      }
      throw last instanceof EffectorNotSent
        ? last
        : new EffectorNotSent(`no Effector replica took it: ${(last as Error | undefined)?.message ?? "none"}`);
    },
    poll: (replica, id, signal) => ask(replica.address, id, signal),
    find: async (id, signal) => {
      const addresses = await transport.replicas(signal);
      const states = await Promise.all(addresses.map((address) => ask(address, id, signal)));
      return states.find((s) => s.state !== "unknown");
    },
  };
}

/** A transport rejection that certainly never reached the replica becomes `EffectorNotSent`. */
function notSent(err: unknown): never {
  throw new EffectorNotSent(`the Effector's replicas could not be listed: ${(err as Error)?.message ?? err}`, {
    cause: err,
  });
}

/** Errnos that mean no connection was ever made (the same reading as the Harness client's). */
const NEVER_REACHED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

export function neverReached(err: unknown, depth = 0): boolean {
  if (depth > 4 || typeof err !== "object" || err === null) return false;
  const { code, syscall, cause, errors } = err as {
    code?: unknown;
    syscall?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (syscall === "connect" || syscall === "getaddrinfo") return true;
  if (typeof code === "string" && (code === "UND_ERR_CONNECT_TIMEOUT" || NEVER_REACHED_CODES.has(code))) return true;
  if (Array.isArray(errors) && errors.some((nested) => neverReached(nested, depth + 1))) return true;
  return neverReached(cause, depth + 1);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The real transport: the placement's headless Service, `host:port`. Its replicas are the
 * addresses its name resolves to — every pod, a stopping one included, because the Service
 * publishes addresses that are not ready (a stopping replica still answers for the Effects
 * it finishes). A request goes to one pod's address over plain HTTP: the signature, not TLS, is
 * what an answer is trusted by.
 */
export function nodeEffectorTransport(service: string, fetchImpl: typeof fetch = fetch): EffectorTransport {
  const cut = service.lastIndexOf(":");
  const host = service.slice(0, cut);
  const port = service.slice(cut + 1);
  return {
    // `lookup` (getaddrinfo), not `resolve4`: it reads the pod's resolv.conf search list, so the
    // namespace-relative name resolves as every other in-cluster address the Orchestrator dials.
    replicas: async () => (await lookup(host, { all: true, family: 4 })).map((a) => `${a.address}:${port}`),
    send: async (address, method, path, headers, body, signal) => {
      const res = await fetchImpl(`http://${address}${path}`, {
        method,
        headers,
        ...(method === "POST" ? { body } : {}),
        ...(signal ? { signal } : {}),
      });
      const text = await res.text();
      const out: Record<string, string> = {};
      res.headers.forEach((value, name) => {
        out[name.toLowerCase()] = value;
      });
      return { status: res.status, headers: out, body: text };
    },
  };
}
