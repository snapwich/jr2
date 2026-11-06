// The Hook's door (ADR-0011, ADR-0078): `POST /hooks/:name`, one stable address for each Hook that
// the current Assembly's `jr2.config.ts` declares. A Hook is a door for one outside service: it
// checks that a delivery comes from the service, and decides nothing. Only a Gate's handler makes an
// event of a delivery.
//
// The order of the door, each step before the next:
//
//   1. The Hook. No current Assembly is 503: no config says which Hooks exist. A name that the
//      config does not declare is 404.
//   2. The body's size. A body above `HOOK_BODY_MAX` (2 MiB) is 413, and the door reads no more
//      of it than the limit. The hook log keeps a `too-large` line, which claims no delivery id.
//      This is the one route with no bearer token that takes a body, and a `mac` check sends the
//      body to the Instance Effector, whose wire takes no more than 4 MiB of base64.
//   3. The verifier, one of three, a closed set. `token`: the sha-256 of the header's value against
//      the digest that `jr2 up` gave, then the header is removed, so no code of the kind reads it.
//      `ed25519`: the signature against the public key in the config. `mac`: the door builds the
//      bytes that the kind names, and the Instance Effector, which holds the secret, answers "match"
//      or "no match" (ADR-0068). A signed timestamp more than 300 s from the door's clock fails the
//      verifier. Each failure is 401, and nothing else happens: nothing is logged.
//   4. The kind reads the request: a handshake, which gets the kind's answer, or a delivery. A
//      request that the kind cannot read is 400.
//   5. The parse, with the kind's schema for the event key. A payload that fails it reaches no
//      handler, and the answer is 200, because a second try fails the same way. The parse comes
//      before the repeat check, so a payload that the parse refused is parsed again when it comes
//      again.
//   6. The repeat check: a delivery whose id OR body digest this Hook's log holds is `seen`, and
//      nothing is delivered.
//   7. The fan-in (`RunHost.deliverHook`) to the open Gates of the Workflows that the Hook may
//      answer, and to the Sources of their Pools (ADR-0017). The answer is the outcome: 503 when a
//      standing Pool that hears the kind and key has no live run and is not paused, or when the
//      delivery followed its hand-overs 3 times and it handed over again, 429 when every Source's
//      verdict is `hold-full`, and then the delivery does not claim its id.
//   8. The answer. A kind whose answer no person reads (a forge, a Slack event) gets the outcome
//      JSON with the status of the rules. A chat command or click (the kind's `readBy: "person"`)
//      gets 200 and the kind's envelope around one text: the `reply` of each target, joined
//      (`joinReplies`), else the door's own text (`doorText`), with the cause of a 429 or a 503
//      after it, cut to the kind's `maxText`. A follow-up that the envelope gives (the reply to a
//      Slack click) goes out after the answer, to a url under the kind's `posts` only.
//
// The hook log (snapshot-store.ts) keeps a line for each step after the verifier, and for a body
// that is too large, for `runs.retain`, with the status that the rules give.

import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature } from "node:crypto";
import type { Hook, HookKind, HookParts, HookRequest, Json, Signed, Unsigned } from "./hook-kinds/index.ts";
import { hookParts, hookRequest, schemaFor, signatureBytes, signedBytes } from "./hook-kinds/door.ts";
import { randomBytes } from "node:crypto";
import type { Answer, Delivery } from "./hook-kinds/index.ts";
import type { CallerRecord } from "./callers.ts";
import { createEffectorClient, type EffectState, type EffectorTransport, type HookMac } from "./effector-wire.ts";
import type { HookFanIn, HookReply, RunHost } from "./run-host.ts";
import type { HookLogLine, SnapshotStore } from "./snapshot-store.ts";
import { callerMay, ON_BEHALF_OF_MAX } from "./tokens.ts";

/** How far a signed timestamp may be from the door's clock, in seconds: jr2's, the same for every
 * kind, and no config changes it (ADR-0078). */
export const HOOK_WINDOW_S = 300;

/** The largest body that the door reads, in bytes (ADR-0011). Above it the answer is 413, before
 * the verifier. A `mac` check sends the body to the Instance Effector as base64, and its wire takes
 * at most 4 MiB, so the limit keeps a correctly signed delivery from a false 503. */
export const HOOK_BODY_MAX = 2 * 1024 * 1024;

/**
 * The body of a delivery: its bytes, or a reader that gives at most `max` bytes, and `undefined`
 * when the body is longer. The door reads it after the Hook is known, so a request to no Hook
 * reads no body.
 */
export type HookBody = Uint8Array | ((max: number) => Promise<Uint8Array | undefined>);

/** How many lines of a Hook's log `GET /hooks/:name` gives by default, and at most. */
export const HOOK_LOG_DEFAULT = 50;
export const HOOK_LOG_MAX = 1000;

/**
 * The answer to one delivery (ADR-0011): `delivery` is its id, `seen` says it was a repeat,
 * `delivered` the Gates that took it, `refused` the Gates that did not and why, `ignored` how many
 * open Gates of its kind and key gave nothing, and `sources` each Source's verdict (ADR-0017).
 * `payloadRefused` names the kind and the event key of a payload that the parse refused, with zod's
 * issues.
 */
export type HookOutcome = {
  delivery: string;
  seen: boolean;
  delivered: HookFanIn["delivered"];
  refused: HookFanIn["refused"];
  ignored: number;
  sources: HookFanIn["sources"];
  payloadRefused?: { kind: string; key: string; issues: unknown[] };
};

/** What the door answers: a status and a body. A string body is `text/plain`, `null` is empty.
 * `after`: the follow-up, which the server starts after it sent the answer (ADR-0011). It never
 * rejects: a failed post is a line in the hook log. */
export type HookAnswer = { status: number; body: Json; after?: () => Promise<void> };

/** The follow-up post of a kind's answer (ADR-0011, ADR-0068): one POST of `json` to `url`, with no
 * secret, one try, through the Instance Effector's `http` call. It rejects with the reason when the
 * post did not get a 2xx answer. */
export type HookPost = (req: { url: string; json: Json }) => Promise<void>;

export type HookDoorOptions = {
  host: RunHost;
  store: SnapshotStore;
  /** The Hooks of the current Assembly's config, by name; `undefined` while there is no current
   * Assembly. Read on each delivery, so a publish changes them. */
  hooks: () => Readonly<Record<string, Hook>> | undefined;
  /** The digests of the `token` Hooks' secrets, by secret name (`jr2-hook-digests`). */
  digests: () => Readonly<Record<string, string>>;
  /** The `mac` check through the Instance Effector. Absent: no Instance Effector, so a `mac` Hook
   * answers 503. */
  mac?: HookMac;
  /** The follow-up post through the Instance Effector. Absent: no Instance Effector, so a
   * follow-up fails, and the hook log says so. */
  post?: HookPost;
  /** The door's clock, in milliseconds. A test sets it. */
  now?: () => number;
};

/** The door's two acts: a delivery, and the log of a Hook. */
export type HookDoor = {
  deliver: (name: string, headers: Headers, body: HookBody) => Promise<HookAnswer>;
  log: (name: string, limit: number) => { hook: string; declared: boolean; lines: HookLogLine[] };
};

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a.toLowerCase());
  const right = Buffer.from(b.toLowerCase());
  return left.length === right.length && timingSafeEqual(left, right);
}

const refusal = (status: number, error: string): HookAnswer => ({ status, body: { error } });

/** Build the door over the run host and the store. */
export function hookDoor(opts: HookDoorOptions): HookDoor {
  const now = opts.now ?? Date.now;

  /** The verifier's answer: the request that the kind reads, or the door's refusal. */
  const verify = async (
    name: string,
    parts: HookParts,
    headers: Headers,
    body: Uint8Array,
  ): Promise<HookRequest | HookAnswer> => {
    const v = parts.kind.verify;
    if ("token" in v) {
      const sent = headers.get(v.token.header);
      const secret = "secret" in parts.credential ? parts.credential.secret.secret : undefined;
      const digest = secret === undefined ? undefined : opts.digests()[secret];
      if (digest === undefined) {
        // A fault of the deploy, not of the service: say it where the operator reads.
        console.error(`hook ${name}: no digest for its secret "${secret}" — \`jr2 up\` places it (ADR-0078)`);
      }
      if (sent === null || digest === undefined || !sameHex(sha256(sent), digest)) {
        return refusal(401, "the delivery does not carry the Hook's token");
      }
      return hookRequest(headers, body, v.token.header);
    }
    const req = hookRequest(headers, body);
    const signedOf = "mac" in v ? v.mac.signed : v.ed25519.signed;
    let signed: Signed | Unsigned;
    try {
      signed = signedOf(req);
    } catch (err) {
      signed = { unsigned: err instanceof Error ? err.message : String(err) };
    }
    if ("unsigned" in signed) return refusal(401, `the delivery is not signed: ${signed.unsigned}`);
    if (signed.at !== undefined) {
      const off = Math.abs(now() / 1000 - signed.at);
      if (!Number.isFinite(off) || off > HOOK_WINDOW_S) {
        return refusal(401, `the delivery's signed time is more than ${HOOK_WINDOW_S} s from the door's clock`);
      }
    }
    const signature = signatureBytes(signed);
    if (signature === undefined) return refusal(401, "the delivery's signature is not well formed");
    const bytes = signedBytes(signed);
    if ("ed25519" in v) {
      if (!("publicKey" in parts.credential)) return refusal(401, "the Hook has no public key");
      let ok = false;
      try {
        const key = createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(parts.credential.publicKey, "hex").toString("base64url") },
          format: "jwk",
        });
        ok = verifySignature(null, bytes, key, signature);
      } catch {
        ok = false;
      }
      return ok ? req : refusal(401, "the delivery's signature does not match");
    }
    // `mac`: only the Instance Effector holds the secret (ADR-0068).
    if (!opts.mac) {
      console.error(`hook ${name}: a mac Hook needs the Instance Effector, and this Orchestrator has none`);
      return refusal(503, "the Hook's signature cannot be checked now: no Instance Effector (ADR-0068)");
    }
    const secret = "secret" in parts.credential ? parts.credential.secret.secret : "";
    let match: boolean;
    try {
      match = await opts.mac({ secret, alg: v.mac.alg, bytes, signature });
    } catch (err) {
      console.error(`hook ${name}: the mac check failed: ${err instanceof Error ? err.message : String(err)}`);
      return refusal(503, "the Hook's signature cannot be checked now: the Instance Effector did not answer");
    }
    return match ? req : refusal(401, "the delivery's signature does not match");
  };

  const write = (line: Omit<HookLogLine, "at">, claimed?: number): void => {
    try {
      opts.store.writeHookLine({ ...line, at: new Date(now()).toISOString() }, claimed);
    } catch (err) {
      console.error(`hook ${line.hook}: the hook log was not written: ${err instanceof Error ? err.message : err}`);
    }
  };

  const deliver = async (name: string, headers: Headers, source: HookBody): Promise<HookAnswer> => {
    const hooks = opts.hooks();
    if (hooks === undefined) {
      return refusal(503, "the Orchestrator has no current Assembly, so no Hook is declared now — ask again");
    }
    const hook = Object.hasOwn(hooks, name) ? hooks[name] : undefined;
    if (hook === undefined) return refusal(404, `no Hook named "${name}" in the current Assembly's config`);
    const parts = hookParts(hook);
    const kind: HookKind = parts.kind;

    const body = typeof source === "function" ? await source(HOOK_BODY_MAX) : source;
    if (body === undefined || body.byteLength > HOOK_BODY_MAX) {
      // Before the verifier, so no delivery id is known and none is claimed: a service that sends
      // the same body again gets the same answer.
      write({ hook: name, kind: "too-large", status: 413, detail: { limit: HOOK_BODY_MAX } });
      return refusal(413, `the delivery's body is larger than ${HOOK_BODY_MAX} bytes, the most the door reads`);
    }

    const verified = await verify(name, parts, headers, body);
    if ("status" in verified) return verified;

    let read: ReturnType<HookKind["read"]>;
    try {
      read = kind.read(verified);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      write({ hook: name, kind: "unreadable", status: 400, digest: sha256(body), detail: { error } });
      return refusal(400, `the ${kind.id} kind cannot read the delivery: ${error}`);
    }
    if ("handshake" in read) {
      write({ hook: name, kind: "handshake", status: 200 });
      return { status: 200, body: read.handshake.body };
    }
    const id = typeof read.id === "string" ? read.id : "";
    const key = typeof read.key === "string" ? read.key : "";
    const digest = sha256(body);
    if (id === "" || key === "") {
      const error = "the kind gave no delivery id or no event key";
      write({ hook: name, kind: "unreadable", status: 400, digest, detail: { error } });
      return refusal(400, `the ${kind.id} kind cannot read the delivery: ${error}`);
    }
    const empty = { delivered: [], refused: [], ignored: 0, sources: [] };
    // Who reads the answer (ADR-0011): a person for a chat command or click, else the service. Only
    // a kind with an envelope can say "person".
    const delivery: Delivery = read;
    const person = delivery.readBy === "person" && typeof kind.answer === "function";
    /** The answer to a delivery that the door read: the outcome for a service, the envelope for a
     * person. The hook log keeps `status`, the status of the rules, in both cases. */
    const answerOf = (outcome: HookOutcome, status: number, replies?: HookReply[], waiting?: string[]): HookAnswer => {
      if (!person) return { status, body: outcome as unknown as Json };
      const text = cutText(chatText(outcome, { status, replies: replies ?? [], waiting: waiting ?? [] }), kind.maxText);
      let envelope: Answer;
      try {
        envelope = kind.answer!(text, delivery);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`hook ${name}: the ${kind.id} kind's answer threw: ${error}`);
        return { status: 200, body: text };
      }
      const then = envelope.then;
      if (then === undefined) return { status: 200, body: envelope.body };
      const fail = (error: string): void =>
        write({ hook: name, kind: "follow-up", status: 0, delivery: id, key, detail: { post: then.post, error } });
      // The door posts only under a host that the kind declares (ADR-0078): the Effector's fence
      // holds those hosts alone, and a kind that gives another url gets no post.
      if (!(kind.posts ?? []).some((prefix) => then.post.startsWith(prefix))) {
        fail(`the ${kind.id} kind gave a follow-up to a url outside its posts (${(kind.posts ?? []).join(", ")})`);
        return { status: 200, body: envelope.body };
      }
      const post = opts.post;
      const after = async (): Promise<void> => {
        if (!post) return fail("no Instance Effector, so the door cannot post a follow-up (ADR-0068)");
        try {
          await post({ url: then.post, json: then.json });
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      };
      return { status: 200, body: envelope.body, after };
    };

    // The parse before the repeat check (ADR-0011): a refused payload never claims its id.
    const schema = schemaFor(kind, key);
    let payload: unknown = read.payload;
    if (schema) {
      const parsed = schema.safeParse(read.payload);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message }));
        const outcome: HookOutcome = {
          delivery: id,
          seen: false,
          ...empty,
          payloadRefused: { kind: kind.id, key, issues },
        };
        write({ hook: name, kind: "payload-refused", status: 200, delivery: id, digest, key, detail: outcome });
        return answerOf(outcome, 200);
      }
      payload = parsed.data;
    }

    const claimed = opts.store.claimHookDelivery(name, id, digest);
    if (claimed === undefined) {
      const outcome: HookOutcome = { delivery: id, seen: true, ...empty };
      write({ hook: name, kind: "seen", status: 200, delivery: id, digest, key, detail: outcome });
      return answerOf(outcome, 200);
    }

    // The Hook as a Caller (ADR-0078): `answer` alone, and `onBehalfOf` from the signed payload.
    const onBehalfOf =
      typeof read.onBehalfOf === "string" && read.onBehalfOf !== ""
        ? read.onBehalfOf.slice(0, ON_BEHALF_OF_MAX)
        : undefined;
    const caller: CallerRecord = { via: "hook", name, ...(onBehalfOf !== undefined ? { onBehalfOf } : {}) };
    const may = { via: "hook" as const, name, may: { answer: parts.may.answer } };
    // A key with no schema reaches nothing: no handler can hear it (ADR-0011).
    const fan: HookFanIn = schema
      ? await opts.host.deliverHook({
          hook: name,
          kind: kind.id,
          key,
          delivery: id,
          payload,
          caller,
          may: (workflow) => callerMay(may, "answer", workflow),
          ...(person ? { person: true } : {}),
        })
      : { delivered: [], refused: [], ignored: 0, sources: [] };
    const { waiting, replies, ...fanned } = fan;
    const outcome: HookOutcome = { delivery: id, seen: false, ...fanned };
    // A `reply` that threw, or gave no text, is a line of the log's detail, never of the outcome.
    const failed = (replies ?? []).filter((r) => r.error !== undefined);
    const detail = failed.length
      ? { ...outcome, replyErrors: failed.map(({ run, gate, error }) => ({ run, gate, error })) }
      : outcome;
    // A standing Pool that hears this kind and key has no live run and is not paused (ADR-0017): it
    // waits out the back-off of a hand-over. 503, so the service sends it again, and the delivery
    // does not claim its id, so that send is heard. The Gates that took it pass it over then.
    if (waiting?.length) {
      write({ hook: name, kind: "no-live-run", status: 503, delivery: id, digest, key, detail }, claimed);
      return answerOf(outcome, 503, replies, waiting);
    }
    // Every Source holds as many items as it may (ADR-0017): 429, so the service sends it again. The
    // delivery does not claim its id, so that send is heard: a Gate that took it is passed over by
    // the run's answers, and a Pool that held its item answers `existing`.
    if (fan.sources.length > 0 && fan.sources.every((line) => line.verdict === "hold-full")) {
      write({ hook: name, kind: "hold-full", status: 429, delivery: id, digest, key, detail }, claimed);
      return answerOf(outcome, 429, replies);
    }
    write({ hook: name, kind: "delivered", status: 200, delivery: id, digest, key, detail }, claimed);
    return answerOf(outcome, 200, replies);
  };

  const log: HookDoor["log"] = (name, limit) => {
    const hooks = opts.hooks();
    return {
      hook: name,
      declared: hooks !== undefined && Object.hasOwn(hooks, name),
      lines: opts.store.hookLog(name, limit),
    };
  };

  return { deliver, log };
}

// --- The text that a person reads (ADR-0011) ------------------------------------------------------

/** Compare two strings by their code units: the same order on every host, with no locale. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Join the `reply` texts of the targets (ADR-0011): Sources first (what the act brought), then Gates
 * (what the act answered), and in each by Workflow name, then by run id. Empty texts and exact
 * repeats are dropped. The text of a `skipped` verdict shows only when no other target gave a text,
 * because a skip says "not for me". The texts are joined by a newline; `""` when no target gave a
 * text.
 */
export function joinReplies(replies: readonly HookReply[]): string {
  const sorted = [...replies].sort(
    (a, b) =>
      (a.target === b.target ? 0 : a.target === "source" ? -1 : 1) ||
      byText(a.workflow, b.workflow) ||
      byText(a.run, b.run),
  );
  const said = sorted.filter((r): r is HookReply & { text: string } => typeof r.text === "string" && r.text !== "");
  const spoke = said.filter((r) => r.skipped !== true);
  const shown = spoke.length > 0 ? spoke : said;
  return [...new Set(shown.map((r) => r.text))].join("\n");
}

/** The Workflows of a list of Source lines, distinct and sorted, as a person reads them. */
const named = (workflows: readonly string[]): string => [...new Set(workflows)].sort(byText).join(", ");

/** Why a delivery whose answer a person reads did not count, for a 429 or a 503 (ADR-0011): the
 * rules give that status, the person gets 200, and this text says why. */
function causeText(outcome: HookOutcome, status: number, waiting: readonly string[]): string | undefined {
  if (status === 429) {
    const full = outcome.sources.filter((s) => s.verdict === "hold-full").map((s) => s.workflow);
    return `jr2 cannot take this now: the Pool of ${named(full)} holds as many items as it can. Try again later.`;
  }
  if (status === 503) {
    return `jr2 cannot take this now: the Pool of ${named(waiting)} has no live run. Try again in a minute.`;
  }
  return undefined;
}

/**
 * The door's own text, from the outcome (ADR-0011), for a delivery whose answer a person reads and
 * where no target gave a text: a repeat, a payload that the parse refused, a delivery that reached
 * nothing, or what the fan-in did. It is the same for every service, so the kind never sees the
 * outcome.
 */
export function doorText(outcome: HookOutcome): string {
  if (outcome.seen) return "jr2 got this before, and did not do it again.";
  if (outcome.payloadRefused) {
    const { kind, key, issues } = outcome.payloadRefused;
    const first = issues[0] as { path?: string[]; message?: string } | undefined;
    const why = first?.message ? ` (${first.path?.length ? `${first.path.join(".")}: ` : ""}${first.message})` : "";
    return `jr2 cannot use this: the ${kind} payload "${key}" is not in the form that jr2 knows${why}.`;
  }
  const lines: string[] = [];
  for (const s of outcome.sources) {
    const at = `${s.workflow} ${s.pool}`;
    if (s.verdict === "held") lines.push(`${at}: took the item ${s.key}.`);
    else if (s.verdict === "existing")
      lines.push(`${at}: the item ${s.key} is already in jr2${s.run ? ` (run ${s.run})` : ""}.`);
    else if (s.verdict === "hold-full") lines.push(`${at}: cannot hold the item ${s.key} now.`);
    else if (s.verdict === "reread") lines.push(`${at}: reads its items again.`);
    else if (s.verdict === "paused") lines.push(`The Pool of ${s.workflow} is paused, so it took nothing.`);
  }
  for (const d of outcome.delivered) lines.push(`${d.workflow} ${d.run}: ${d.gate} took "${d.event}".`);
  for (const r of outcome.refused) lines.push(`${r.run}: ${r.gate} did not take it: ${r.reason}`);
  if (lines.length > 0) return lines.join("\n");
  // Only skips, or nothing: a skip's reason is the text of its Source's `reply`, if it has one.
  const skipped = outcome.sources.filter((s) => s.verdict === "skipped");
  if (skipped.length > 0)
    return skipped.map((s) => `${s.workflow}: did nothing: ${s.reason ?? "no reason"}`).join("\n");
  return "Nothing in jr2 waits for this now.";
}

/**
 * The one text of a delivery whose answer a person reads (ADR-0011): the joined `reply` texts, else
 * the door's own text; and for a 429 or a 503, the cause after it, so the text always says why.
 */
export function chatText(
  outcome: HookOutcome,
  at: { status: number; replies: readonly HookReply[]; waiting: readonly string[] },
): string {
  const joined = joinReplies(at.replies);
  const cause = causeText(outcome, at.status, at.waiting);
  if (joined === "") return cause ?? doorText(outcome);
  return cause === undefined || joined.split("\n").includes(cause) ? joined : `${joined}\n${cause}`;
}

/** Cut a text to `max` characters (code points, so no character is cut in two), the last one an
 * ellipsis when the text was longer. No `max`: the text whole. */
export function cutText(text: string, max: number | undefined): string {
  if (max === undefined) return text;
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, Math.max(0, max - 1)).join("")}…`;
}

// --- The follow-up post (ADR-0011, ADR-0068) --------------------------------------------------------

/** How long the door waits for a follow-up post to settle. */
const FOLLOW_UP_MS = 10_000;

/**
 * The follow-up post through the Instance Effector's signed wire: one `http` call, with no secret,
 * sent once. It has no slot, no ledger row and no run, so its id is new for each post. The
 * Effector's fence takes it only to a host that a Hook's kind declares in `posts` (`jr2 up` writes
 * them, ADR-0068). It rejects with the reason of an outcome that is not a 2xx response.
 */
export function createHookPost(opts: { key: Buffer | string; transport: EffectorTransport }): HookPost {
  const client = createEffectorClient(opts);
  return async ({ url, json }) => {
    const id = `hook-follow-up-${randomBytes(12).toString("hex")}`;
    const signal = AbortSignal.timeout(FOLLOW_UP_MS);
    let state: EffectState = await client.start(
      id,
      { kind: "http", method: "POST", url: [{ text: url }], body: { json }, timeoutMs: FOLLOW_UP_MS, maxBody: 4096 },
      signal,
    );
    while (state.state === "running") state = await client.poll(state.replica, id, signal);
    const out = state.output;
    if (state.state !== "settled" || out === undefined) throw new Error("the Instance Effector lost the post");
    if (!("outcome" in out)) throw new Error("the Instance Effector gave the post an output of another kind");
    if (out.outcome !== "response") throw new Error(`the post is ${out.outcome}: ${"reason" in out ? out.reason : ""}`);
    if (out.status < 200 || out.status > 299) throw new Error(`the post got ${out.status}`);
  };
}
