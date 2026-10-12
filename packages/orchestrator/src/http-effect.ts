// The `http` Effect (ADR-0068): call a URL from the Instance Effector, with a secret the Agent
// never reads. An actor slot beside `command()` (ADR-0067):
//
//   comment: http({
//     method: "POST",
//     url: "https://jira.example.com/rest/api/2/issue",
//     auth: bearer(secret("jira")),
//     input: z.object({ key: z.string(), body: z.string() }),
//     request: ({ key, body }) => ({ path: [key, "comment"], json: { body } }),
//   })
//
// Its body may be a Worktree file instead (ADR-0067), and then it runs in the Sandbox Effector of the
// Workspace whose body invokes it, which opens the file beneath the Worktree with no symlink:
//
//   report: http({
//     method: "PUT",
//     url: "https://files.example.com/reports",
//     auth: bearer(secret("files")),
//     input: z.object({ marker: z.string() }),
//     body: file("dist/report.pdf", { segments: ({ marker }) => [marker], contentType: "application/pdf" }),
//   })
//
// The definition is plain data `jr2 up` reads without running anything (`HttpParts`): the kind,
// the placement (`instance`, or `sandbox` for a file body), the fixed host, the secret names. `request` is the one function: it
// maps the Effect's typed input to the run's part of the request — `path` segments and a body —
// and nothing else, so an Agent's param reaches a path segment or a body and never the host, a
// header or a secret. The Effector builds the request; the Orchestrator holds no secret.
//
// What this module adds to the Effect's restart safety (effect.ts) for this kind:
//
//   - THE RESTORE RULE. The intent row names the placement and no replica. After an
//     Orchestrator restart, or a start whose answer never came, the Effect asks EVERY replica for
//     its id: one that holds it is followed; when none does, an Effect the author marked
//     `idempotent` is sent again, and any other settles `unknown`. A start that certainly never
//     reached a replica (no connection, a stopping replica) is sent again either way.
//   - A FORGED ANSWER. An answer the placement's key does not verify is not the Effector's: a key
//     that differs from the Effector's, or another process on its address. A poll's is read as a
//     replica gone (its address may be stale), so every replica is asked; when asking every
//     replica gets one, the Effect settles `unknown` and is not sent again — no retry changes the
//     key the answer is checked with, and such a process can make the call fail, never answer it.
//   - D1. When its state exits, the Orchestrator stops polling and records the abort, "outcome
//     unknown", on the ledger and the feed. An http Effect has no stop route: the Effector finishes the call
//     and drops an outcome nobody reads.

import { randomUUID } from "node:crypto";
import type { ActorLogic, AnyActorRef, EventObject } from "xstate";
import type { z } from "zod";
import type {
  Duration,
  EffectLogic,
  EffectMarker,
  EffectRow,
  EffectSnapshot,
  HttpParts,
  OpenHttpParts,
  Unknown,
} from "./effect.ts";
import {
  createEffectorClient,
  EffectorForged,
  EffectorMalformed,
  EffectorNotSent,
  EffectorRefused,
  HTTP_METHODS,
  isEffectHeader,
  MAX_START_BYTES,
  nodeEffectorTransport,
  type EffectorPort,
  type EffectState,
  type HttpMethod,
  type HttpOutput,
  type Replica,
  type HttpStartRequest,
  type StartRequest,
  type TextPart,
  type WireAuth,
  type WireBody,
} from "./effector-wire.ts";
import { boundRun, type AnyActorSystem } from "./registration.ts";
import { open } from "./open.ts";
import { openEffectLogic, type OpenEffect } from "./open-effect.ts";
import { httpFileWith, sandboxEffectorPort } from "./sandbox-effect.ts";

// --- Naming a secret -----------------------------------------------------------------------------

/** A secret an Effect names, by its name in the config's `secrets` list (ADR-0068). Naming it in an
 * Effect is what places it in that Effect's Effector: an Effect secret. Its value never leaves the
 * Effector; on the wire it is a name. */
export type Secret = { readonly secret: string; readonly path: { readonly secret: string; readonly path: true } };

/** A string the Effector builds: literal text and secrets, in order — the `text` template's value. */
export type Text = { readonly text: readonly TextPart[] };

const SECRET_NAME = /^[A-Za-z0-9._-]{1,253}$/;

/** Name a secret: `secret("jira")`. */
export function secret(name: string): Secret {
  // A secret's NAME is not an Open part (ADR-0054): the Open parts are an http url and a
  // command's argv. A url whose secret the composer names is left Open whole.
  if ((name as unknown) === open) {
    throw new Error(
      "secret(open): a secret's name is not an Open part — leave the whole url Open " +
        "(`url: open`) and let the composer bind it with its secret in its path; the auth, the headers " +
        "and a command's env name their secrets in the definition (ADR-0054)",
    );
  }
  if (typeof name !== "string" || !SECRET_NAME.test(name) || name.startsWith(".")) {
    throw new Error(
      `secret("${name}"): a secret's name is letters, digits, ".", "_" and "-", and does not start with "." — ` +
        "it is the file the Effector reads it from (ADR-0068)",
    );
  }
  // `.path` names the secret's FILE in the Effector's own mount, for a credentialed command's env
  // (ADR-0067): `env: { KUBECONFIG: secret("kube").path }`. Not enumerable, so a definition's plain
  // data never carries it.
  const s = { secret: name } as Secret;
  Object.defineProperty(s, "path", { value: Object.freeze({ secret: name, path: true as const }), enumerable: false });
  return s;
}

/** A string with secrets in it: text`Token ${secret("x")}`. Each `${…}` is a secret or a string. */
export function text(strings: TemplateStringsArray, ...values: Array<Secret | string>): Text {
  const parts: TextPart[] = [];
  const push = (s: string): void => {
    if (s === "") return;
    const last = parts.at(-1);
    if (last && "text" in last) parts[parts.length - 1] = { text: last.text + s };
    else parts.push({ text: s });
  };
  strings.forEach((s, i) => {
    push(s);
    if (i >= values.length) return;
    const v = values[i];
    if (typeof v === "string") push(v);
    else if (isSecret(v)) parts.push({ secret: v.secret });
    else throw new Error(`text\`…\`: a value is a secret("name") or a string, got ${JSON.stringify(v)}`);
  });
  return { text: parts };
}

/** `Authorization: Bearer <value>`. */
export function bearer(s: Secret): { readonly bearer: Secret } {
  if (!isSecret(s)) throw new Error('bearer(…) takes a secret("name")');
  return { bearer: s };
}

/** `Authorization: Basic base64(user:password)`. Each is a string, a secret, or a `text`. */
export function basic(
  user: string | Secret | Text,
  password: string | Secret | Text,
): { readonly basic: { user: Text; password: Text } } {
  return { basic: { user: asText(user), password: asText(password) } };
}

function isSecret(v: unknown): v is Secret {
  return typeof v === "object" && v !== null && typeof (v as Secret).secret === "string" && !("text" in v);
}

function asText(v: string | Secret | Text): Text {
  if (typeof v === "string") return { text: v === "" ? [] : [{ text: v }] };
  if (isSecret(v)) return { text: [{ secret: v.secret }] };
  if (typeof v === "object" && v !== null && Array.isArray((v as Text).text)) return v;
  throw new Error(`expected a string, a secret("name") or a text\`…\`, got ${JSON.stringify(v)}`);
}

// --- A Worktree file as the body (ADR-0067) ------------------------------------------------------------

/** A value of a file body's part: as written, or from the Effect's input. */
export type FromInput<S, T> = T | ((input: S extends z.ZodType ? z.infer<S> : void) => T);

/** `file(path, { slot?, segments?, contentType? })`: a Worktree file as an `http` body. */
export type FileBody<S extends z.ZodType | undefined = undefined> = {
  readonly file: {
    /** The file, relative to the Repo Slot's Worktree. */
    readonly path: FromInput<S, string>;
    /** The Repo Slot whose Worktree holds it — needed only where the Workspace carries several. */
    readonly slot?: string;
    /** Path segments appended to the url, as `request`'s `path` is for a json or text body. */
    readonly segments?: FromInput<S, readonly string[]>;
    /** The body's content type: this or a `content-type` header of the definition's, not both (a
     * definition with both is refused). With neither it is `application/octet-stream`. */
    readonly contentType?: string;
  };
};

/**
 * A Worktree file as an `http` body (ADR-0067): `body: file("dist/report.pdf")`. The Effect then runs in
 * the Sandbox Effector of the Workspace whose body invokes it, which opens the file beneath the
 * Worktree — a symlink at any component, `..`, an absolute path, a FIFO, a directory and a file
 * with more than one link are output `refused`, with nothing sent. `path` and `segments` may be
 * functions of the Effect's input.
 */
export function file<S extends z.ZodType | undefined = undefined>(
  path: FromInput<S, string>,
  options: { slot?: string; segments?: FromInput<S, readonly string[]>; contentType?: string } = {},
): FileBody<S> {
  if (typeof path !== "string" && typeof path !== "function") {
    throw new Error("file(path): the path is a string, or a function of the Effect's input that returns one");
  }
  return {
    file: {
      path,
      ...(options.slot !== undefined ? { slot: options.slot } : {}),
      ...(options.segments !== undefined ? { segments: options.segments } : {}),
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
    },
  };
}

/** The methods that send a file body. */
const FILE_METHODS: readonly HttpMethod[] = ["PUT", "POST", "PATCH"];

// --- The definition ------------------------------------------------------------------------------

/** What `request` returns: the run's part of the request. Everything else is the definition's. */
export type HttpRequestParts = {
  /** Path segments appended to the url: each is encoded; `.`, `..` and an empty one are refused
   * in the Effector as output, with nothing sent. */
  path?: readonly string[];
  /** A JSON body. */
  json?: unknown;
  /** A text body. */
  text?: string;
};

/** An `http` Effect's definition. */
export type HttpDefinition<S extends z.ZodType | undefined = undefined> = {
  method: HttpMethod;
  /** The url. Its scheme and host are fixed here — never a param — and a secret may sit only in
   * its path: text`https://api.telegram.org/bot${secret("tg")}/sendMessage`. Or `open`: a packaged
   * Machine that cannot know the host leaves the url Open, and the composer binds it once with
   * `customize(machine, { effects: { <slot>: { url } } })` — never per run (ADR-0054). */
  url: string | Text | typeof open;
  /** Static headers, lowercase; a value may be a `text` with a secret. */
  headers?: Readonly<Record<string, string | Text>>;
  auth?: { readonly bearer: Secret } | { readonly basic: { user: Text; password: Text } } | Text;
  /** The Effect's input — what an invoke's `input` (or `fromPick`) hands it. */
  input?: S;
  /** The run's part of the request, from the input. */
  request?: (input: S extends z.ZodType ? z.infer<S> : void) => HttpRequestParts;
  /** A Worktree file as the body: `file(path, { slot?, segments?, contentType? })` (ADR-0067). Then the
   * Effect runs in its Workspace's Sandbox Effector, and `request` is not written: `file()`'s
   * `segments` are the path. */
  body?: FileBody<S>;
  /** Default 30s. Past it with no answer: output `unknown`. */
  timeout?: Duration;
  /** Bytes of a text body returned. Default 65536. */
  maxBody?: number;
  /** Marked by the author: the call may be sent twice (it carries its own idempotency key, or it
   * is a read). A restore that finds no replica holding it then sends it again; unmarked, it
   * settles `unknown` (ADR-0067). Default false. */
  idempotent?: boolean;
};

export type HttpInput<S> = S extends z.ZodType ? z.infer<S> : void;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY = 65_536;
/** How long a re-asked request waits, at most, after a transport failure. */
const RETRY_MAX_MS = 10_000;

/** The definition's plain data, checked: every refusal names what to write instead. */
export function httpParts<S extends z.ZodType | undefined>(def: HttpDefinition<S>): HttpParts {
  if (!(HTTP_METHODS as readonly string[]).includes(def.method)) {
    throw new Error(`http({ method: "${def.method}" }): the method is one of ${HTTP_METHODS.join(", ")}`);
  }
  if (def.url === open) throw new Error("httpParts: an Open url has no target — read it with openHttpParts");
  const url = asText(def.url).text;
  const target = targetOf(url);
  const headers: Record<string, TextPart[]> = {};
  for (const [name, value] of Object.entries(def.headers ?? {})) {
    // The wire's own rule, so a definition the Machine loads is a start the Effector takes.
    if (!isEffectHeader(name)) {
      throw new Error(
        `http({ headers }): "${name}" is not a header an Effect sets — a lowercase name that does not frame or ` +
          "route the request (ADR-0068)",
      );
    }
    if (name === "authorization" && def.auth !== undefined) {
      throw new Error('http({ headers }): "authorization" is set by `auth` — write one of them');
    }
    headers[name] = [...asText(value).text];
  }
  const auth: WireAuth | undefined =
    def.auth === undefined
      ? undefined
      : "bearer" in def.auth
        ? { bearer: { secret: def.auth.bearer.secret } }
        : "basic" in def.auth
          ? { basic: { user: [...def.auth.basic.user.text], password: [...def.auth.basic.password.text] } }
          : { text: [...asText(def.auth).text] };
  const secrets: string[] = [];
  const note = (parts: readonly TextPart[]): void => {
    for (const p of parts) if ("secret" in p && !secrets.includes(p.secret)) secrets.push(p.secret);
  };
  note(url);
  for (const name of Object.keys(headers).sort()) note(headers[name]!);
  if (auth && "bearer" in auth) note([{ secret: auth.bearer.secret }]);
  if (auth && "basic" in auth) {
    note(auth.basic.user);
    note(auth.basic.password);
  }
  if (auth && "text" in auth) note(auth.text);
  for (const name of secrets) secret(name);
  const maxBody = def.maxBody ?? DEFAULT_MAX_BODY;
  if (!Number.isInteger(maxBody) || maxBody <= 0) throw new Error("http({ maxBody }): a positive number of bytes");
  const body = def.body?.file;
  if (def.body !== undefined && (typeof body !== "object" || body === null)) {
    throw new Error(
      "http({ body }): a body is file(path, { slot?, segments?, contentType? }) — json and text come from `request`",
    );
  }
  if (body && !FILE_METHODS.includes(def.method)) {
    throw new Error(
      `http({ method: "${def.method}", body: file(...) }): a file body is sent with ${FILE_METHODS.join(", ")} (ADR-0068)`,
    );
  }
  if (body?.contentType !== undefined && headers["content-type"] !== undefined) {
    throw new Error(
      'http({ headers, body: file(path, { contentType }) }): "content-type" is set by file()\'s contentType — write ' +
        "one of them (ADR-0067)",
    );
  }
  if (body && def.request !== undefined) {
    throw new Error(
      "http({ body: file(...), request }): with a file body the run's part is file()'s — its path, from the input " +
        "if it must be, and its `segments` — so write no `request` (ADR-0068)",
    );
  }
  return {
    kind: "http",
    method: def.method,
    target,
    url,
    headers,
    ...(auth ? { auth } : {}),
    secrets,
    inputKeys: inputKeysOfSchema(def.input),
    timeoutMs: def.timeout === undefined ? DEFAULT_TIMEOUT_MS : parseDuration(def.timeout),
    maxBody,
    idempotent: def.idempotent === true,
    ...(body
      ? {
          file: {
            ...(body.slot !== undefined ? { slot: body.slot } : {}),
            ...(body.contentType !== undefined ? { contentType: body.contentType } : {}),
          },
        }
      : {}),
  };
}

/** The url an Open definition's other parts are checked against: it names no secret, and nothing
 * is ever sent to it — the unbound logic sends nothing (open-effect.ts). */
const OPEN_PROBE_URL = "https://open.invalid";

/**
 * An Open url's plain data (ADR-0054): every other part checked as `httpParts` checks it, the
 * secrets its headers and auth name, and the sentinel where the url and its target go. The
 * secrets the bound url names join when `customize()` binds it.
 */
export function openHttpParts<S extends z.ZodType | undefined>(def: HttpDefinition<S>): OpenHttpParts {
  const { url: _url, target: _target, ...rest } = httpParts({ ...def, url: OPEN_PROBE_URL });
  return { ...rest, url: open, target: open };
}

/** The scheme, host and port, from the url's literal head: a secret may sit only after the host,
 * in the path, so the host is fixed by the definition and never a value. */
function targetOf(url: readonly TextPart[]): HttpParts["target"] {
  const first = url[0];
  const head = first && "text" in first ? first.text : "";
  const m = /^(https?):\/\/([^/?#]*)(.*)$/i.exec(head);
  const literalPathFollows = m !== null && (m[3] !== "" || url.length === 1);
  if (!m || !literalPathFollows) {
    throw new Error(
      "http({ url }): the url is an http:// or https:// url whose scheme and host are literal — a secret may sit " +
        'only in its path, after a "/": text`https://api.example.com/bot${secret("tg")}/send` (ADR-0068)',
    );
  }
  // The Effector encodes a secret as a path segment, which a query or a fragment would read as a
  // different value: a secret after a `?` or a `#` is refused here, as the Effector refuses it.
  let before = "";
  for (const part of url) {
    if ("text" in part) {
      before += part.text;
    } else if (/[?#]/.test(before)) {
      throw new Error(
        `http({ url }): secret("${part.secret}") sits in the url's query or fragment — a secret may sit only in ` +
          'its path; send it in `auth` or a header instead: headers: { "x-api-key": text`${secret("...")}` } (ADR-0068)',
      );
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(`${m[1]}://${m[2]}/`);
  } catch {
    throw new Error(`http({ url }): "${m[1]}://${m[2]}" is not a host`);
  }
  if (parsed.username || parsed.password) throw new Error("http({ url }): the url carries userinfo — use `auth`");
  const scheme = parsed.protocol === "https:" ? "https" : "http";
  const port = parsed.port ? Number(parsed.port) : scheme === "https" ? 443 : 80;
  return { scheme, host: parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port };
}

function inputKeysOfSchema(schema: z.ZodType | undefined): string[] {
  const shape = (schema as { shape?: unknown } | undefined)?.shape;
  return shape && typeof shape === "object" ? Object.keys(shape) : [];
}

/** The wire request for one run: the definition's parts, and `request`'s from the input. */
export function startRequestOf(parts: HttpParts, run: HttpRequestParts): HttpStartRequest {
  const path = run.path === undefined ? undefined : [...run.path];
  if (path !== undefined && !path.every((seg) => typeof seg === "string")) {
    throw new Error("http: `request` returned a path that is not a list of strings");
  }
  if (run.json !== undefined && run.text !== undefined) throw new Error("http: `request` returned both json and text");
  const body: WireBody | undefined =
    run.json !== undefined ? { json: run.json } : run.text !== undefined ? { text: run.text } : undefined;
  return {
    kind: "http",
    method: parts.method,
    url: [...parts.url],
    ...(path?.length ? { path } : {}),
    ...(Object.keys(parts.headers).length ? { headers: { ...parts.headers } as Record<string, TextPart[]> } : {}),
    ...(parts.auth ? { auth: parts.auth } : {}),
    ...(body ? { body } : {}),
    timeoutMs: parts.timeoutMs,
    maxBody: parts.maxBody,
  };
}

// --- The actor logic -----------------------------------------------------------------------------

/** Which Effector an Effect asks for: the Instance Effector, or the Sandbox Effector of one
 * Workspace's Sandbox (ADR-0067). */
export type EffectorPlacement = "instance" | { sandbox: string };

/** Where a placement's Effector is, as the host knows it (ADR-0068): its Service and its key. */
export type EffectorTarget = { placement: "instance" | "sandbox"; service: string; key: Buffer | string };
export type EffectorPortFactory = (target: EffectorTarget) => EffectorPort;

type Settle = { type: "jr2.effect.settle"; output: unknown };
type Fault = { type: "jr2.effect.error"; error: unknown };

type Running = { controller: AbortController };
const running = new WeakMap<AnyActorRef, Running>();

/**
 * An `http` Effect's slot logic over an injected port factory — the seam `http()` and the unit
 * tests share, as `commandWith` is for a command.
 */
export function httpWith<S extends z.ZodType | undefined = undefined>(
  portFactory: EffectorPortFactory,
  def: HttpDefinition<S> & { url: typeof open },
): EffectLogic<HttpInput<S>, HttpOutput> & OpenEffect<"url">;
export function httpWith<S extends z.ZodType | undefined = undefined>(
  portFactory: EffectorPortFactory,
  def: HttpDefinition<S>,
): EffectLogic<HttpInput<S>, HttpOutput>;
export function httpWith<S extends z.ZodType | undefined = undefined>(
  portFactory: EffectorPortFactory,
  def: HttpDefinition<S>,
): EffectLogic<HttpInput<S>, HttpOutput> {
  if (def.url === open) {
    // An Open url (ADR-0054): unbound logic that carries the parts and binds by building this Effect
    // again, whole, with the composer's url — so the bound one is checked like any definition.
    return openEffectLogic(openHttpParts(def), "url", (binding) => {
      if (!("url" in binding)) {
        throw new Error("an http Effect's Open part is its url — bind it with { url }, not an argv");
      }
      return httpWith(portFactory, { ...def, url: binding.url }) as EffectLogic<unknown, unknown>;
    });
  }
  const parts = httpParts(def);
  type I = HttpInput<S>;
  type O = HttpOutput;
  const logic: ActorLogic<EffectSnapshot<O, I>, EventObject, I> = {
    getInitialSnapshot: (_scope, input) => ({
      status: "active",
      output: undefined,
      error: undefined,
      input,
      effectId: randomUUID(),
    }),
    transition: (snapshot, event, { self, system }) => {
      if (snapshot.status !== "active") return snapshot;
      if (event.type === "jr2.effect.settle") {
        return { ...snapshot, status: "done", output: (event as Settle).output as O, input: undefined };
      }
      if (event.type === "jr2.effect.error") {
        return { ...snapshot, status: "error", error: (event as Fault).error, input: undefined };
      }
      if (event.type === "xstate.stop") {
        stopped(self, system, snapshot.effectId);
        return { ...snapshot, status: "stopped", input: undefined };
      }
      return snapshot;
    },
    start: (snapshot, { self, system }) => {
      if (snapshot.status !== "active") return;
      const run: Running = { controller: new AbortController() };
      running.set(self, run);
      void drive(self, system, snapshot, parts, def, portFactory, run).catch((error: unknown) => {
        if (run.controller.signal.aborted) return;
        if (self.getSnapshot().status === "active") self.send({ type: "jr2.effect.error", error } as Fault);
      });
    },
    getPersistedSnapshot: (snapshot) => snapshot,
  };
  return Object.assign(logic, { effect: parts });
}

const slotOf = (self: AnyActorRef): string => (typeof self.src === "string" ? self.src : self.id);

async function drive<I, O>(
  self: AnyActorRef,
  system: AnyActorSystem,
  snapshot: EffectSnapshot<O, I>,
  parts: HttpParts,
  def: HttpDefinition<z.ZodType | undefined>,
  portFactory: EffectorPortFactory,
  run: Running,
): Promise<void> {
  const binding = boundRun(system);
  const id = snapshot.effectId;
  const slot = slotOf(self);
  const signal = run.controller.signal;
  const now = (): string => new Date().toISOString();
  const mark = (marker: Omit<EffectMarker, "kind" | "slot" | "effect">): void =>
    binding?.marker?.({ kind: "effect", slot, effect: id, ...marker });
  const settle = (output: HttpOutput): void => {
    if (signal.aborted || self.getSnapshot().status !== "active") return;
    // The settled row first, saved at the write: a restart before the transition is saved delivers
    // this output, and sends nothing.
    binding?.recordEffect?.(id, { state: "settled", kind: "http", slot, output, at: now() });
    mark({ stage: "settled", output });
    self.send({ type: "jr2.effect.settle", output } satisfies Settle);
  };
  const unknown = (reason: string): Unknown => ({ outcome: "unknown", reason });

  const row = binding?.effectRow?.(id);
  if (row?.state === "settled") {
    await Promise.resolve();
    if (!signal.aborted && self.getSnapshot().status === "active") {
      self.send({ type: "jr2.effect.settle", output: row.output } satisfies Settle);
    }
    return;
  }
  if (row?.state === "aborted") {
    settle(unknown("its state exited while it ran; not sent again"));
    return;
  }

  const target = binding?.effector?.("instance");
  if (!target) {
    throw new Error(
      `http "${slot}" runs in the Instance Effector, and this Orchestrator knows none — \`jr2 up\` converges it ` +
        "when a registered Machine carries an http Effect (ADR-0068)",
    );
  }
  const port = portFactory(target);
  /** Ask every replica. Undefined when an answer was forged: the Effect is settled then. */
  const findAll = async (): Promise<{ found: EffectState | undefined } | undefined> => {
    try {
      return { found: await retrying(() => port.find(id, signal), signal) };
    } catch (err) {
      if (signal.aborted || !(err instanceof EffectorForged)) throw err;
      settle(
        unknown(
          `${err.message}: the Orchestrator's key for this Effector is not the Effector's, or another process ` +
            "answered; not sent again",
        ),
      );
      return undefined;
    }
  };

  if (row?.state === "intent") {
    // In flight at an Orchestrator restart: ask every replica, follow the one that holds it, and
    // when none does, send it again only if the author marked it idempotent.
    const asked = await findAll();
    if (!asked || signal.aborted) return;
    const { found } = asked;
    if (found) {
      await follow(found);
      return;
    }
    if (!parts.idempotent) {
      settle(
        unknown(
          "it was in flight when the Orchestrator restarted, and no Effector replica holds it; not sent again " +
            "(it is not marked idempotent)",
        ),
      );
      return;
    }
    mark({ stage: "started", text: `${parts.method} ${hostText(parts)} (sent again: it is idempotent)` });
    await send(requestFor());
    return;
  }

  // Fresh: nothing was sent. The run's part of the request is built before the intent row, so a
  // defect in `request` is the Machine's error and sends nothing.
  const req = requestFor();
  // A start the Effector would not read is refused here, before the intent row: nothing is sent.
  const big = tooLarge(req);
  if (big) {
    settle(big);
    return;
  }
  // Write-ahead: the intent row is saved, with the snapshot that holds this child, before the
  // request leaves.
  binding?.recordEffect?.(id, {
    state: "intent",
    kind: "http",
    slot,
    placement: "instance",
    idempotent: parts.idempotent,
    at: now(),
  });
  mark({ stage: "started", text: `${parts.method} ${hostText(parts)}` });
  await send(req);

  function requestFor(): StartRequest {
    let input: unknown = snapshot.input;
    if (def.input !== undefined) {
      const parsed = def.input.safeParse(input);
      if (!parsed.success) {
        throw new Error(
          `http "${slot}": its input does not match the definition's input schema — ` +
            parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
        );
      }
      input = parsed.data;
    }
    const runParts = def.request ? (def.request as (i: unknown) => HttpRequestParts)(input) : {};
    return startRequestOf(parts, runParts ?? {});
  }

  /** Send the start, and follow it. A start that never reached a replica is sent again; one whose
   * answer did not come is looked for on every replica, never sent blind. */
  async function send(req: StartRequest): Promise<void> {
    const big = tooLarge(req);
    if (big) {
      settle(big);
      return;
    }
    for (let wait = 250; ; wait = Math.min(wait * 2, RETRY_MAX_MS)) {
      let state: EffectState;
      try {
        state = await port.start(id, req, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof EffectorRefused || err instanceof EffectorMalformed) throw err;
        if (!(err instanceof EffectorNotSent)) {
          // It may have started — a lost answer, or a forged one: ask every replica first.
          const asked = await findAll();
          if (!asked || signal.aborted) return;
          const { found } = asked;
          if (found) {
            await follow(found);
            return;
          }
          if (!parts.idempotent) {
            settle(unknown("its start may have reached the Effector, and no replica holds it now; not sent again"));
            return;
          }
        }
        await sleep(wait, signal);
        if (signal.aborted) return;
        continue;
      }
      await follow(state);
      return;
    }
  }

  /** Poll the replica that holds it to its outcome. A replica that stops answering for it — gone,
   * or restarted — sends the Effect to every replica again; none holding it is the restore rule. */
  async function follow(first: EffectState): Promise<void> {
    let state = first;
    let replica: Replica = first.replica;
    for (;;) {
      if (state.state === "settled" && state.output) {
        settle(state.output as HttpOutput);
        return;
      }
      if (state.state === "unknown") {
        const asked = await findAll();
        if (!asked || signal.aborted) return;
        const { found } = asked;
        if (!found) {
          if (parts.idempotent) {
            await send(requestFor());
            return;
          }
          settle(unknown("the Effector replica that held it no longer knows it (it restarted); not sent again"));
          return;
        }
        state = found;
        replica = found.replica;
        continue;
      }
      try {
        state = await port.poll(replica, id, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof EffectorRefused || err instanceof EffectorMalformed) throw err;
        // The replica did not answer, or not with the Effector's signature (its address may be
        // stale): the next pass asks every replica.
        state = { effect: id, replica, state: "unknown" };
      }
      if (signal.aborted) return;
    }
  }
}

/**
 * The state that invoked this Effect exited (D1) — or the host is parking the run. Parking keeps
 * the call for the restore to find. An exit stops the polling and records the abort, "outcome
 * unknown": an http Effect has no stop route, so the Effector finishes the call and drops an outcome nobody
 * reads. The Machine never hears it.
 */
function stopped(self: AnyActorRef, system: AnyActorSystem, effectId: string): void {
  const run = running.get(self);
  running.delete(self);
  run?.controller.abort();
  const binding = boundRun(system);
  if (binding?.hostStopping) return;
  const row = binding?.effectRow?.(effectId);
  if (row?.state !== "intent" || row.kind !== "http") return;
  const aborted: EffectRow = { state: "aborted", kind: "http", slot: row.slot, at: new Date().toISOString() };
  binding?.recordEffect?.(effectId, aborted, "with-transition");
  binding?.marker?.({
    kind: "effect",
    slot: row.slot,
    effect: effectId,
    stage: "aborted",
    text: "its state exited while it ran: no longer followed; the Effector may still send it; outcome unknown",
  });
}

/** A start over the bytes the Effector reads is output `refused` (ADR-0068): the Effector could not
 * verify it, and a body built from context or a pick's param can reach the bound. */
function tooLarge(req: StartRequest): HttpOutput | undefined {
  const bytes = Buffer.byteLength(JSON.stringify(req), "utf8");
  if (bytes <= MAX_START_BYTES) return undefined;
  return {
    outcome: "refused",
    reason: `the request is ${bytes} bytes, over the ${MAX_START_BYTES} bytes an Effector reads; nothing was sent`,
  };
}

function hostText(parts: HttpParts): string {
  const { scheme, host, port } = parts.target;
  const standard = (scheme === "https" && port === 443) || (scheme === "http" && port === 80);
  return `${scheme}://${host}${standard ? "" : `:${port}`}`;
}

async function retrying<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let wait = 250; ; wait = Math.min(wait * 2, RETRY_MAX_MS)) {
    try {
      return await call();
    } catch (err) {
      // A refusal and a malformed answer are defects; a forged one would be forged again.
      if (
        signal.aborted ||
        err instanceof EffectorRefused ||
        err instanceof EffectorMalformed ||
        err instanceof EffectorForged
      ) {
        throw err;
      }
      await sleep(wait, signal);
      if (signal.aborted) throw err;
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms / 2 + Math.random() * (ms / 2));
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function parseDuration(d: Duration): number {
  const n = Number.parseFloat(d);
  if (!(n > 0)) throw new Error(`http: timeout "${d}" is not a positive duration (like "30s", "2m")`);
  return d.endsWith("h") ? n * 3_600_000 : d.endsWith("m") ? n * 60_000 : n * 1000;
}

/**
 * THE authoring surface for an `http` Effect (ADR-0068): `actors: { comment: http({ method, url,
 * auth: bearer(secret("jira")), input, request }) }`, invoked as `src: "comment"`. It runs in the
 * Instance Effector, which `jr2 up` converges because this definition is placed there — or, with
 * `body: file(...)`, in the Sandbox Effector of the Workspace whose body invokes it (ADR-0067). The
 * Orchestrator signs the call and holds no secret. Every outcome is output:
 * `response | unreachable | refused | unknown`.
 */
export function http<S extends z.ZodType | undefined = undefined>(
  def: HttpDefinition<S> & { url: typeof open },
): EffectLogic<HttpInput<S>, HttpOutput> & OpenEffect<"url">;
export function http<S extends z.ZodType | undefined = undefined>(
  def: HttpDefinition<S>,
): EffectLogic<HttpInput<S>, HttpOutput>;
export function http<S extends z.ZodType | undefined = undefined>(
  def: HttpDefinition<S>,
): EffectLogic<HttpInput<S>, HttpOutput> {
  if (def.body !== undefined) return httpFileWith(sandboxEffectorPort, def);
  return httpWith(
    (target) => createEffectorClient({ key: target.key, transport: nodeEffectorTransport(target.service) }),
    def,
  );
}
