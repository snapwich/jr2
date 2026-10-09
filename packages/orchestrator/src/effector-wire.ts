// The Effector's wire, from the Orchestrator's side (ADR-0068): the request it encodes, the
// answers it decodes, the signatures on both, and the client that speaks it.
//
// The types are written by hand, here (zod is the source) and in Go (`effector/internal/wire`).
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

/** One part of a string the Effector builds: literal text, or a secret it holds, by name. A
 * secret's value is never on the wire. */
export type TextPart = { text: string } | { secret: string };

export type WireAuth =
  | { bearer: { secret: string } }
  | { basic: { user: TextPart[]; password: TextPart[] } }
  | { text: TextPart[] };

export type WireBody = { json: unknown } | { text: string };

export type StartRequest = {
  kind: "http";
  method: HttpMethod;
  url: TextPart[];
  path?: string[];
  headers?: Record<string, TextPart[]>;
  auth?: WireAuth;
  body?: WireBody;
  timeoutMs: number;
  maxBody: number;
};

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

// --- The answers ---------------------------------------------------------------------------------

/** The `response` outcome: a status came back. The body is there when it is text, bounded and
 * scrubbed; a body that is not text is its size and content type only. */
export type HttpResponse = {
  outcome: "response";
  status: number;
  headers: Record<string, string>;
  contentType: string;
  size: number;
  body?: string;
  truncated?: boolean;
};

/**
 * An `http` Effect's output. Every outcome is output (ADR-0067): `response`; `unreachable` (nothing
 * was sent); `refused` (the Effector refused it and sent nothing — a path segment that is `.`, `..`
 * or empty, a host no Effect placed there names); `unknown` (it may have been sent, and no answer
 * came — or jr2 cannot tell, after a restart or a state exit).
 */
export type HttpOutput = HttpResponse | { outcome: "unreachable" | "refused" | "unknown"; reason: string };

/** The replica that holds an Effect, and where to poll it (B2.4). */
export type Replica = { name: string; address: string };

/** Every answer of `POST` and `GET /effects/<id>`. */
export type EffectState = {
  effect: string;
  replica: Replica;
  state: "running" | "settled" | "unknown";
  output?: HttpOutput;
};

const ReplicaShape = z.strictObject({ name: z.string(), address: z.string() });
const HttpOutputShape = z.union([
  z.strictObject({
    outcome: z.literal("response"),
    status: z.number().int(),
    headers: z.record(z.string(), z.string()),
    contentType: z.string(),
    size: z.number().int().nonnegative(),
    body: z.string().optional(),
    truncated: z.boolean().optional(),
  }),
  z.strictObject({ outcome: z.enum(["unreachable", "refused", "unknown"]), reason: z.string() }),
]);
export const EffectStateShape = z.strictObject({
  effect: z.string(),
  replica: ReplicaShape,
  state: z.enum(["running", "settled", "unknown"]),
  output: HttpOutputShape.optional(),
});
export const RefusalShape = z.strictObject({ error: z.string(), replica: ReplicaShape.optional() });

// --- Signatures ----------------------------------------------------------------------------------

export const HEADER_TIME = "x-jr2-time";
export const HEADER_NONCE = "x-jr2-nonce";
export const HEADER_SIGNATURE = "x-jr2-signature";

const digest = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");
const mac = (key: Buffer | string, parts: string[]): string =>
  createHmac("sha256", key).update(parts.join("\n"), "utf8").digest("base64url");

/** A request's signature: over its method, path, time, nonce and the sha-256 of its body. */
export function requestMac(
  key: Buffer | string,
  method: string,
  path: string,
  time: string,
  nonce: string,
  body: string,
): string {
  return mac(key, ["jr2-effector-request", method, path, time, nonce, digest(body)]);
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

/** An answer that is not the Effector's: unsigned, mis-signed, or not the wire's shape. */
export class EffectorForged extends Error {}

/** The Effector's wire, as an Effect drives it. */
export interface EffectorPort {
  /** POST: start the Effect on some replica, or attach to it. Rejects with `EffectorNotSent` only
   * when no replica can have started it; any other rejection may follow a start. */
  start(id: string, req: StartRequest, signal: AbortSignal): Promise<EffectState>;
  /** GET on the replica that holds it: settled, still running after the hold, or `unknown`. */
  poll(replica: Replica, id: string, signal: AbortSignal): Promise<EffectState>;
  /** Ask every replica (B2.4): the state of the one that holds it, or undefined when every replica
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
      [HEADER_SIGNATURE]: requestMac(key, method, path, time, nonce, body),
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
    if (!parsed.success) throw new EffectorForged(`the Effector's answer to ${what} is not the wire's shape`);
    return parsed.data as EffectState;
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
          // A stopping replica started nothing (B2.4): another may take it.
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
 * publishes addresses that are not ready (B2.4: a stopping replica still answers for the Effects
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
