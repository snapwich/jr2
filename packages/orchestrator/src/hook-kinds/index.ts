// `@jr2/orchestrator/hooks`: the interface between the Hook's door (jr2) and a Hook kind (ADR-0078).
//
// A Hook kind is one outside service's protocol, as a plain value: data, and pure, synchronous
// functions. jr2's own kinds (`@jr2/orchestrator/hooks/github` and the others) use this interface and nothing
// more, so a kind from another package can do all that they do.
//
//   THE DOOR (jr2, the same for every kind)       THE KIND (one for each service)
//   POST /hooks/:name, 401, the hook log          what the service signed, and the signature
//   the repeat check (id AND digest)              the service's timestamp, if it is signed
//   the clock and the window (300 s)              the decoding of the body (JSON, form)
//   RUNS the verifier: `mac` in the Instance      the answer to a handshake
//     Effector, `token` and `ed25519` in the      the event key, the delivery id, `onBehalfOf`
//     Orchestrator                                a zod schema for each event key
//   RUNS the parse of the payload                 who reads the answer: the service or a person
//   the fan-out to Gates and Sources              the envelope of a text that a person reads
//   `reply`: the join, the skip rule, the         the limit on the text, and the hosts of a
//     door's own text, the cut to `maxText`         follow-up
//   the follow-up POST (Instance Effector `http`)
//
// The rules:
//   1. A kind never gets a credential. jr2 makes the kind's constructor (`defineHookKind`), so the
//      credential goes from the config to the door and never through code of the kind. For
//      `token`, the door removes the token's header before it calls the kind.
//   2. A kind is pure and synchronous: no I/O, no Promise, no clock. The door owns the time.
//   3. `jr2.config.ts` declares a kind by `import`, and `jr2 up` bundles it into the Assembly. jr2
//      finds no kind in a folder and loads none at run time.
//   4. A kind adds its id and its payloads to `HookKinds` (below), so the `hooks` of a Gate or a
//      Source are typed by kind id and event key (ADR-0011).
//   5. A kind gives a zod schema for each event key. The door parses each payload with it, after
//      the verifier and before the fan-out, and a handler's payload has the schema's output type.

import type { z } from "zod";
import { HOOK } from "./hook.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1. What the door gives a kind: the request, and nothing more.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One delivery, as the door got it. All of it is data. Header names are lowercase.
 *
 * For a kind with a `token` verifier, `headers` does not hold the token's header: the door removes
 * it before it calls the kind. For `mac` and `ed25519`, no part of the request is secret: a
 * signature cannot make another signature.
 */
export type HookRequest = {
  readonly headers: { readonly [name: string]: string | undefined };
  /** The raw body. A `mac` or `ed25519` signature covers these bytes. */
  readonly body: Uint8Array;
  /** The raw body as UTF-8. */
  readonly text: string;
};

/** A JSON value: what a kind puts in an answer. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

/**
 * The body as JSON. It throws when the body is not JSON. A throw from `read` is a 400, and the
 * hook log keeps the error.
 */
export function json(req: HookRequest): unknown {
  try {
    return JSON.parse(req.text) as unknown;
  } catch {
    throw new Error("the body is not JSON");
  }
}

/**
 * The body as `application/x-www-form-urlencoded` fields. When a field occurs more than one time,
 * the first value is the field's value.
 */
export function form(req: HookRequest): { readonly [field: string]: string | undefined } {
  const out: { [field: string]: string } = Object.create(null) as { [field: string]: string };
  for (const [name, value] of new URLSearchParams(req.text)) {
    if (!Object.hasOwn(out, name)) out[name] = value;
  }
  return Object.freeze(out);
}

/**
 * The value at a dotted path (`sender.login`, `actions.0.action_id`) of a decoded body, or
 * `undefined`. It reads own properties only.
 */
export function at(value: unknown, path: string): unknown {
  let here: unknown = value;
  for (const step of path.split(".")) {
    if (here === null || typeof here !== "object" || !Object.hasOwn(here, step)) return undefined;
    here = (here as { readonly [k: string]: unknown })[step];
  }
  return here;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2. The verifier: a closed set of three (ADR-0078). The kind says WHAT to check; the door checks.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the service signed, from one request.
 *
 * The door makes the checks. For `mac`, it first checks `at` against its clock, then sends the
 * bytes, the signature, the algorithm and the NAME of the Hook's secret to the Instance Effector,
 * which answers "match" or "no match" (ADR-0068). For `ed25519`, it checks `at`, then the
 * signature against the Hook's public key, in the Orchestrator.
 */
export type Signed = {
  /** The bytes that the service signed, in sequence. The door joins them. A string is UTF-8.
   * GitHub: `[req.body]`. Slack: `["v0:", timestamp, ":", req.body]`. */
  readonly bytes: readonly (string | Uint8Array)[];
  /** The signature, with no prefix (`sha256=`, `v0=`): the kind removes the prefix. */
  readonly signature: { readonly hex: string } | { readonly base64: string };
  /**
   * The service's time of the delivery, in seconds since the epoch. Give it ONLY when the
   * signature covers it (Slack, Discord). The door refuses a delivery whose `at` is more than
   * 300 s from its clock: 401. A kind cannot change the window.
   */
  readonly at?: number;
};

/** The request does not hold what the verifier needs. The door answers 401 and logs `unsigned`. */
export type Unsigned = { readonly unsigned: string };

/** The HMAC algorithms that a `mac` verifier can name. */
export type MacAlg = "sha256" | "sha1" | "sha512";

/** How the service signs. One of three. */
export type Verify =
  /** An HMAC that a shared secret makes. Only the Instance Effector holds the secret. */
  | {
      readonly mac: {
        readonly alg: MacAlg;
        readonly signed: (req: HookRequest) => Signed | Unsigned;
      };
    }
  /** An Ed25519 signature that the service's private key makes. The Hook's config holds the PUBLIC
   * key as a literal: it can check a signature and cannot make one. */
  | { readonly ed25519: { readonly signed: (req: HookRequest) => Signed | Unsigned } }
  /** A shared token in a header (GitLab). The door compares its sha-256 with the digest that
   * `jr2 up` gave it, then removes the header. The kind never reads the token. */
  | { readonly token: { readonly header: string } };

/**
 * A named secret: the value of `secret("NAME")` from `@jr2/orchestrator`. The config holds the
 * name only. The value is in the Instance Effector (`mac`), or its digest is in the Orchestrator
 * (`token`).
 */
export type HookSecret = { readonly secret: string };

/** What the Hook's config gives for each verifier. The kind never gets it. */
export type CredentialOf<V extends Verify> = V extends { readonly ed25519: unknown }
  ? { readonly publicKey: string }
  : { readonly secret: HookSecret };

/** The credential of a Hook, for each of the three verifiers. */
export type HookCredential = { readonly secret: HookSecret } | { readonly publicKey: string };

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3. What a kind reads from a verified request: a handshake, or a delivery.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An answer that the kind writes. Its status is always 200: the door owns every other status.
 * `body`: an object or an array is JSON, a string is `text/plain`, `null` is an empty body.
 * `then`: one POST that the door makes AFTER the answer, through the Instance Effector's `http`,
 * with no secret, one time (the `response_url` of a Slack click). Its url must start with one of
 * the kind's `posts`. A failed post is a line in the hook log.
 */
export type Answer = {
  readonly body: Json;
  readonly then?: { readonly post: `https://${string}`; readonly json: Json };
};

/** The service's handshake (Slack `url_verification`, Discord `PING`, GitHub `ping`). It comes
 * after the verifier and gets this answer. It reaches no handler, and the hook log keeps it as
 * `handshake`. */
export type Handshake = { readonly handshake: Answer };

/**
 * One delivery, which the door gives to the Gates and the Sources whose handlers hear its kind and
 * `key`. The kind's `events` gives the schema for each key. A key that `events` does not name is
 * still a delivery: the door does not parse it, and no handler can hear it, so it reaches nothing.
 */
export type Delivery = {
  /** The event key. GitHub: `pull_request_review.submitted`. */
  readonly key: string;
  /** The delivery id. The door's repeat check uses it AND the digest of the body. */
  readonly id: string;
  /** The decoded body. The signature covers it. The door parses it with the kind's schema for
   * `key` (see `events`), and a handler gets the schema's output. */
  readonly payload: unknown;
  /** The party that the service says acted. The signature covers it, so jr2 marks it checked. */
  readonly onBehalfOf?: string;
  /**
   * Who reads the answer. `"service"` (the default): the answer is the outcome JSON with the
   * status that ADR-0011 gives (429, 503). `"person"` (a chat command or a click): the door joins
   * the `reply` texts, cuts them to `maxText`, and calls the kind's `answer`. The status is 200.
   */
  readonly readBy?: "service" | "person";
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4. The kind.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The version of this interface. jr2 1.x calls each kind of `api: 1` as this module says. */
export type HookKindApi = 1;

/** The versions of the interface that this copy of `@jr2/orchestrator/hooks` knows. */
export const HOOK_KIND_APIS: readonly HookKindApi[] = Object.freeze([1]);

/**
 * The schema of each event key: `{ "pull_request_review.submitted": z.looseObject({ … }) }`.
 *
 * - The door parses the payload of a delivery with the schema of its key, after the verifier and
 *   before the fan-out. A failed parse reaches no handler: the hook log keeps a `payload-refused`
 *   line with zod's issues, and the answer names the kind and the key. The status is 200, because
 *   a second try fails in the same way.
 * - Use `z.looseObject` for each object. A loose object keeps the fields that it does not name, so
 *   a new field from the service breaks nothing. A named field that is missing, or that has the
 *   wrong type, fails the parse. Name only the fields that handlers need. A value that the service
 *   can extend (a review's `state`) is a string, not an enum.
 * - A key that ends in `.*` is the schema of each key with that prefix: `"block_actions.*"` types
 *   `block_actions.approve` and `block_actions.reject`. An exact key comes first, then the longest
 *   prefix.
 */
export type Events = { readonly [key: string]: z.ZodType };

/** A key of `events` as a handler's key: `"block_actions.*"` → `` `block_actions.${string}` ``. */
export type HandlerKey<K> = K extends `${infer P}.*` ? `${P}.${string}` : K;

/**
 * The schema's output with only its named fields. The output of a loose object also has
 * `[field: string]: unknown`. The fields that it does not name stay in the value, but this type
 * removes the index signature, so a handler cannot read a field that its schema does not name.
 */
export type Named<T> = T extends readonly unknown[]
  ? { readonly [I in keyof T]: Named<T[I]> }
  : T extends object
    ? { readonly [K in keyof T as string extends K ? never : K]: Named<T[K]> }
    : T;

/** The payload type of each handler key of `events`. */
export type Payloads<E extends Events> = {
  readonly [K in keyof E & string as HandlerKey<K>]: Named<z.output<E[K]>>;
};

/**
 * A Hook kind: one outside service's protocol.
 *
 * - `api`: the version of this interface that the kind was written for. Only `1` exists.
 * - `id`: the key of the `hooks` of a Gate or a Source. One id is one kind in an Assembly.
 *   Lowercase letters, digits and `-`, and it starts with a letter.
 * - `events`: a zod schema for each event key that a handler can hear ({@link Events}).
 * - `verify`: one of the three verifiers, and what the service signed.
 * - `read`: the verified request, as a handshake or a delivery. A throw is 400, and the hook log
 *   keeps the error.
 * - `answer`: the envelope of the text for a delivery with `readBy: "person"`. The door gives the
 *   joined text, already cut to `maxText`. The kind escapes it. A kind with no `answer` cannot give
 *   `readBy: "person"`: the type of `read` refuses it ({@link defineHookKind}).
 * - `maxText`: the service's limit on the length of the text (Discord: 2000).
 * - `posts`: the url prefixes of `Answer.then`. `jr2 up` adds them to the Instance Effector's fence
 *   for each Hook of this kind (ADR-0068). The door refuses a `then` to another url.
 */
export type HookKind<Id extends string = string, E extends Events = Events, V extends Verify = Verify> = {
  readonly api: HookKindApi;
  readonly id: Id;
  readonly events: E;
  readonly verify: V;
  readonly read: (req: HookRequest) => Handshake | Delivery;
  readonly answer?: (text: string, delivery: Delivery) => Answer;
  readonly maxText?: number;
  readonly posts?: readonly `https://${string}/`[];
};

/** The Workflows whose Gates a Hook may answer (ADR-0078). The default is `"all"`. A Hook never
 * starts a run. */
export type HookMay = { readonly answer: "all" | readonly string[] };

/** The parts of a Hook, which only the door reads. */
export type HookParts<K extends HookKind = HookKind> = {
  readonly kind: K;
  readonly credential: HookCredential;
  readonly may: HookMay;
};

/**
 * A Hook: a kind, a credential and `may`. It is the value of one entry of `hooks` in
 * `jr2.config.ts`, and the entry's key is its name, the last segment of `POST /hooks/:name`. Only
 * the door reads it.
 */
export type Hook<K extends HookKind = HookKind> = { readonly [HOOK]: HookParts<K> };

/** A kind is also the constructor of its Hooks: `github({ secret: secret("GH_HOOK"), may })`. */
export type HookKindOf<Id extends string, E extends Events, V extends Verify> = HookKind<Id, E, V> &
  ((hook: CredentialOf<V> & { readonly may?: HookMay }) => Hook<HookKind<Id, E, V>>);

/**
 * Define a kind. jr2 makes the constructor, so the credential goes from the config to the door and
 * never through code of the kind.
 *
 * It throws on an `api` that it does not know, an `id` that is not lowercase, an `events` entry
 * that is not a schema, a verifier that is not one of the three, a `posts` entry that is not an
 * `https://` url that ends in `/`, and a `maxText` that is not a positive integer. Two different
 * kinds with one `id` fail the typecheck (`HookKinds`) and `jr2 up`.
 *
 * Two overloads: a kind with `answer` can give `readBy: "person"`; a kind with no `answer` cannot.
 */
export function defineHookKind<const Id extends string, const E extends Events, const V extends Verify>(
  kind: HookKind<Id, E, V> & { readonly answer: NonNullable<HookKind["answer"]> },
): HookKindOf<Id, E, V>;
export function defineHookKind<const Id extends string, const E extends Events, const V extends Verify>(
  kind: Omit<HookKind<Id, E, V>, "read" | "answer" | "maxText" | "posts"> & {
    readonly read: (req: HookRequest) => Handshake | (Delivery & { readonly readBy?: "service" });
  },
): HookKindOf<Id, E, V>;
export function defineHookKind(kind: HookKind): HookKindOf<string, Events, Verify> {
  checkKind(kind);
  const make = (hook: unknown): Hook => {
    const parts: HookParts = Object.freeze({
      kind: made,
      credential: credentialOf(kind, hook),
      may: mayOf(kind.id, (hook as { readonly may?: unknown } | undefined)?.may),
    });
    return Object.freeze({ [HOOK]: parts });
  };
  const fields: HookKind = {
    api: kind.api,
    id: kind.id,
    events: Object.freeze({ ...kind.events }),
    verify: Object.freeze({ ...kind.verify }),
    read: kind.read,
    ...(kind.answer ? { answer: kind.answer } : {}),
    ...(kind.maxText !== undefined ? { maxText: kind.maxText } : {}),
    ...(kind.posts ? { posts: Object.freeze([...kind.posts]) } : {}),
  };
  const made = Object.freeze(Object.assign(make, fields)) as unknown as HookKindOf<string, Events, Verify>;
  return made;
}

/** The lowercase id of a kind. */
const KIND_ID = /^[a-z][a-z0-9-]*$/;

function checkKind(kind: HookKind): void {
  const id: unknown = kind.id;
  if (typeof id !== "string" || !KIND_ID.test(id)) {
    throw new Error(`a Hook kind's id is lowercase letters, digits and "-", and starts with a letter: ${String(id)}`);
  }
  if (!HOOK_KIND_APIS.includes(kind.api)) {
    throw new Error(`Hook kind ${id} states api ${String(kind.api)}; this @jr2/orchestrator/hooks knows api 1 only`);
  }
  if (kind.events === null || typeof kind.events !== "object") throw new Error(`Hook kind ${id} has no events`);
  for (const [key, schema] of Object.entries(kind.events)) {
    if (typeof (schema as { safeParse?: unknown } | null)?.safeParse !== "function") {
      throw new Error(`Hook kind ${id}: the event key ${key} has no zod schema`);
    }
  }
  const verifiers = ["mac", "ed25519", "token"].filter((v) => Object.hasOwn(kind.verify ?? {}, v));
  if (verifiers.length !== 1) {
    throw new Error(`Hook kind ${id}: verify is one of mac, ed25519 or token`);
  }
  const v = kind.verify as {
    mac?: { alg?: unknown; signed?: unknown };
    ed25519?: { signed?: unknown };
    token?: { header?: unknown };
  };
  if (v.mac && (!["sha256", "sha1", "sha512"].includes(v.mac.alg as string) || typeof v.mac.signed !== "function")) {
    throw new Error(`Hook kind ${id}: a mac verifier has an alg (sha256, sha1, sha512) and a signed function`);
  }
  if (v.ed25519 && typeof v.ed25519.signed !== "function") {
    throw new Error(`Hook kind ${id}: an ed25519 verifier has a signed function`);
  }
  if (
    v.token &&
    (typeof v.token.header !== "string" || v.token.header !== v.token.header.toLowerCase() || v.token.header === "")
  ) {
    throw new Error(`Hook kind ${id}: a token verifier names its header in lowercase`);
  }
  if (typeof kind.read !== "function") throw new Error(`Hook kind ${id} has no read function`);
  if (kind.answer !== undefined && typeof kind.answer !== "function") {
    throw new Error(`Hook kind ${id}: answer is a function`);
  }
  if (kind.maxText !== undefined && !(Number.isInteger(kind.maxText) && kind.maxText > 0)) {
    throw new Error(`Hook kind ${id}: maxText is a positive integer`);
  }
  for (const post of kind.posts ?? []) {
    let url: URL | undefined;
    try {
      url = new URL(post);
    } catch {
      url = undefined;
    }
    if (!url || url.protocol !== "https:" || !post.endsWith("/") || url.href !== post) {
      throw new Error(`Hook kind ${id}: a posts entry is an https:// url that ends in "/": ${post}`);
    }
  }
}

/** The public key of an Ed25519 verifier: 32 bytes in hex, as Discord shows it. */
const PUBLIC_KEY = /^[0-9a-f]{64}$/i;

function credentialOf(kind: HookKind, hook: unknown): HookCredential {
  const h = (hook ?? {}) as { readonly secret?: unknown; readonly publicKey?: unknown };
  if ("ed25519" in kind.verify) {
    if (typeof h.publicKey !== "string" || !PUBLIC_KEY.test(h.publicKey)) {
      throw new Error(`a ${kind.id} Hook takes publicKey: the Ed25519 public key in hex (64 characters)`);
    }
    return Object.freeze({ publicKey: h.publicKey.toLowerCase() });
  }
  const s = h.secret as { readonly secret?: unknown } | undefined;
  if (typeof s?.secret !== "string" || s.secret === "") {
    throw new Error(`a ${kind.id} Hook takes secret: a named secret, secret("NAME")`);
  }
  return Object.freeze({ secret: s as HookSecret });
}

function mayOf(id: string, may: unknown): HookMay {
  if (may === undefined) return Object.freeze({ answer: "all" });
  const answer = (may as { readonly answer?: unknown } | null)?.answer;
  if (answer === "all") return Object.freeze({ answer });
  if (Array.isArray(answer) && answer.every((w) => typeof w === "string" && w !== "")) {
    return Object.freeze({ answer: Object.freeze([...(answer as string[])]) });
  }
  throw new Error(`a ${id} Hook's may.answer is "all" or a list of Workflow names`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 5. The registry of TYPES: kind id → kind. Each kind module adds itself:
//      declare module "./index.ts" { interface HookKinds { github: typeof github } }
//    There is no registry at run time. Two kinds that give one id with different types do not
//    compile ("Subsequent property declarations must have the same type").
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Each kind module adds its id and its kind here by declaration merging. */
// biome-ignore lint: an interface for declaration merging.
export interface HookKinds {}

/** The payload map of a kind: handler key → the output of its schema. */
export type EventsOf<K> = K extends HookKind<string, infer E, Verify> ? Payloads<E> : never;

/** A kind's `events` keys with `*`, which take no handler: the door matches a key exactly (ADR-0011). */
export type NoWildcardKeys<K> =
  K extends HookKind<string, infer E, Verify>
    ? { readonly [Key in keyof E & string as Key extends `${string}*${string}` ? Key : never]?: never }
    : never;

/** The payload of one handler key of a kind in `HookKinds`: `PayloadOf<"github", "issue_comment.created">`.
 * A forge part types its handlers with it. */
export type PayloadOf<Id extends keyof HookKinds, Key extends keyof EventsOf<HookKinds[Id]>> = EventsOf<
  HookKinds[Id]
>[Key];

/**
 * Handlers by kind id, then by event key. An entry of `HookKinds` whose key is not its kind's `id`
 * is left out, so no handler is keyed by a name that the door never matches. `In` is what the Gate
 * or the Source gives a handler beside `payload`; `Out` is what the handler gives. A key that the
 * kind's payloads do not name is an excess property: it does not compile. A key that holds `*`
 * does not compile ({@link NoWildcardKeys}).
 */
export type KindHooks<In, Out> = {
  readonly [Id in keyof HookKinds as HookKinds[Id] extends { readonly id: Id } ? Id : never]?: {
    readonly [Key in keyof EventsOf<HookKinds[Id]>]?: (
      d: In & { readonly payload: EventsOf<HookKinds[Id]>[Key] },
    ) => Out;
  } & NoWildcardKeys<HookKinds[Id]>;
};
