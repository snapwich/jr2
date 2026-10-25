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
import { effectBindingShape, openEffectLogic, openPartsOf, type OpenOf } from "./open-effect.ts";
import { httpFileWith, sandboxEffectorPort } from "./sandbox-effect.ts";

// --- Naming a secret -----------------------------------------------------------------------------

// Naming it in an Effect is what places it in that Effect's Effector (ADR-0068). On the wire it is
// a name.
/** What `secret("name")` gives: an Effect secret, by its name in the `secrets` list of
 * `jr2.config.ts`. Put it in an Effect's `auth`, a header, a `text` or a command's `env`. Its
 * `.path` is the path of a file that holds the value. The value stays in the Effector, so the
 * Machine and the Agent never see it. */
export type Secret = { readonly secret: string; readonly path: { readonly secret: string; readonly path: true } };

/** What the `text` template gives: a string of literal text and Effect secrets, in order. The
 * Effector builds the string, so the Machine never sees the value of a secret. */
export type Text = { readonly text: readonly TextPart[] };

declare const openSecretMark: unique symbol;
/** The TYPE half of an Open secret (ADR-0054): whatever carries `secret(open)` — the secret, its
 * `.path`, a `text` or a `basic` pair holding it, a `bearer` of it — carries this mark, so the
 * Effect's constructor states the Open part "secret" and `customize()` offers `{ secret }`.
 * Phantom.
 *
 * @internal
 */
export type OpenSecretMark = { readonly [openSecretMark]: true };

/** A named secret, never `secret(open)`: where a definition's Open part is a whole that holds a
 * secret — a dispatch's target (ADR-0071) — the secret is bound with it, to a name, so the mark
 * `secret(open)` carries may not be present. One type for the definition and the binding. */
export type NamedSecret = Secret & { readonly [K in keyof OpenSecretMark]?: never };

/** `secret(open)`: a secret a packaged Machine names in its auth, a header or a command's env, and
 * leaves for its composer to name (ADR-0054). */
export type OpenSecret = {
  readonly secret: string;
  readonly path: { readonly secret: string; readonly path: true } & OpenSecretMark;
} & OpenSecretMark;

/** The name an Open secret stands under in a definition's plain data until `customize()` binds it.
 * `@` is no character of a secret's name, so it can never be one; an Effect that still holds it
 * runs nothing (open-effect.ts). */
export const OPEN_SECRET = "@open";

const SECRET_NAME = /^[A-Za-z0-9._-]{1,253}$/;

/** Each `secret(open)` a definition names, by every object that stands for it — the secret, its
 * `.path`, a `text` part built from it — so a definition that names one Open secret in two places
 * (a value and its `.path`) is told from one that names two. */
const openSecretOf = new WeakMap<object, object>();

/**
 * Name an Effect secret: `secret("jira")`. The name is the `name` of an entry in the `secrets`
 * list of `jr2.config.ts`. The Effector reads the value and puts it into the call, or into the env
 * of a `command`. The Agent never reads it, and the Orchestrator never holds it.
 *
 * Use it in `bearer`, `basic` or `text`, or in the `env` of a `command`. In an `env`,
 * `secret("x")` gives the value, and `secret("x").path` gives the path of a file that holds the
 * value.
 *
 * `secret(open)` leaves the name to the composer of a packaged Machine, who binds it one time:
 * `customize(machine, { effects: { <slot>: { secret: "<name>" } } })`. An Effect can have one Open
 * secret, in its `auth`, a header or its `env`. A url cannot have one: leave the whole url Open
 * (`url: open`) instead.
 *
 * It refuses, when you call it:
 * - a name that is not letters, digits, `.`, `_` and `-`, that starts with `.`, or that is longer
 *   than 253 characters: `secret("<name>"): a secret's name is letters, digits, ".", "_" and "-",
 *   and does not start with "." — it is the file the Effector reads it from (ADR-0068)`
 * - an Effect that names `secret(open)` in two places that are two secrets: `an Effect takes one
 *   Open secret — it names secret(open) in two places that are two secrets; name one secret(open)
 *   and use it in each place, or name the others with secret("<name>") (ADR-0054)`
 * - `secret(open)` in a url: ``secret(open) in a url: a url's secret is not an Open part — leave
 *   the whole url Open (`url: open`) and let the composer bind it with its secret in its path
 *   (ADR-0054)``
 *
 * And at `jr2 up`:
 * - a name that the `secrets` list does not have: ``workflow "<workflow>": the <kind> Effect
 *   "<slot>" names secret("<name>"), which the `secrets` list does not hold — add it: secrets: [{
 *   name: "<name>", value: process.env.<NAME> }] (ADR-0068)``
 * - a value of fewer than 8 characters: `secrets[<i>] (<name>) is an Effect secret shorter than 8
 *   characters — the Effector replaces every match of a secret in what it returns, and a value
 *   this short would match ordinary text. Use the whole credential; the value itself is not shown
 *   (ADR-0068)`
 *
 * @param name - The name of an entry in the `secrets` list.
 * @returns The Effect secret, for an Effect. Its `.path` names the file of the secret, for the
 *   `env` of a `command`.
 *
 * @example
 * ```ts
 * import { command, jr2Setup, secret, workspace, type Workspaced } from "@jr2/orchestrator";
 *
 * type Input = Workspaced<{}, "app">;
 *
 * const body = jr2Setup({
 *   types: {} as { context: Input; input: Input },
 *   actors: {
 *     // The command reads the file at $KUBECONFIG. The Agent never reads the secret.
 *     deploy: command(["kubectl", "apply", "-f", "k8s/"], {
 *       env: { KUBECONFIG: secret("kube").path },
 *     }),
 *   },
 * }).createMachine({
 *   id: "deploy",
 *   context: ({ input }) => input,
 *   initial: "deploying",
 *   states: {
 *     deploying: { invoke: { src: "deploy", onDone: "done" } },
 *     done: { type: "final" },
 *   },
 * });
 *
 * export const machine = workspace(body, {
 *   repos: { app: { url: "https://github.com/you/app.git" } },
 *   spec: () => ({ branch: "deploy" }),
 * });
 * ```
 *
 * @see docs/concepts/secrets-and-trust.md
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md
 * @see docs/reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md
 */
export function secret(name: string): Secret;
/**
 * Leave an Effect secret Open: `secret(open)`, in a Machine that you publish as a package. The
 * composer binds its name one time: `customize(machine, { effects: { <slot>: { secret: "<name>"
 * } } })`. {@link secret} tells the rest, and what it refuses.
 *
 * @param name - `open`.
 * @returns The Open secret, for an Effect. Its `.path` names the file of the secret, for the `env`
 *   of a `command`.
 *
 * @see docs/concepts/secrets-and-trust.md
 * @see docs/guides/bind-open-parts.md
 * @see docs/reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md
 */
export function secret(name: typeof open): OpenSecret;
export function secret(name: string | typeof open): Secret | OpenSecret {
  if ((name as unknown) === open) {
    // An Open secret (ADR-0054): the composer binds its name once, with `customize()`'s
    // `{ effects: { <slot>: { secret: "<name>" } } }`. Its plain data names `OPEN_SECRET` until then.
    const s = { secret: OPEN_SECRET } as OpenSecret;
    const path = Object.freeze({ secret: OPEN_SECRET, path: true as const });
    Object.defineProperty(s, "path", { value: path, enumerable: false });
    openSecretOf.set(s, s);
    openSecretOf.set(path, s);
    return s;
  }
  if (typeof name !== "string" || !SECRET_NAME.test(name) || name.startsWith(".")) {
    throw new Error(
      `secret("${String(name)}"): a secret's name is letters, digits, ".", "_" and "-", and does not start with "." — ` +
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

/**
 * What a value that may hold `secret(open)` gives: marked when it does.
 *
 * @internal
 */
type MarkedIf<V, T> = [Extract<V, OpenSecretMark>] extends [never] ? T : T & OpenSecretMark;

/** The values of a record type, or never. */
type ValuesOf<R> = R extends Readonly<Record<string, infer V>> ? V : never;

/** "secret" when one of these values holds `secret(open)`, else never: the Open part it states. */
export type OpenSecretIn<V> = [Extract<V, OpenSecretMark>] extends [never] ? never : "secret";

/** The Open parts an http definition's types state (ADR-0054): its url, when it is `open`, and its
 * secret, when its auth or a header holds `secret(open)`.
 *
 * @internal
 */
export type HttpOpenParts<U, A, H> = (U extends typeof open ? "url" : never) | OpenSecretIn<A | ValuesOf<H>>;

/** A secret's wire part: `{ secret: name }` — for an Open secret, a part that stands for it. */
function partOf(s: Secret): TextPart {
  const part = { secret: s.secret };
  const owner = openSecretOf.get(s);
  if (owner) openSecretOf.set(part, owner);
  return part;
}

/**
 * Make a string from literal text and Effect secrets, as a tagged template:
 * `` text`Token ${secret("x")}` ``. The Effector puts in the value of each secret when it makes
 * the call. Use it for a url with a secret in its path, or for a header value. Use it also for
 * `auth`, where it is the whole `Authorization` header, or for a part of `basic`.
 *
 * It refuses a `${…}` that is not a `secret(...)` or a string: `` text`…`: a value is a
 * secret("name") or a string, got <value> ``.
 *
 * @param strings - The literal text of the template.
 * @param values - The `${…}` values, each a `secret(...)` or a string.
 * @returns The string, which the Effector makes.
 *
 * @example
 * ```ts
 * import { http, jr2Setup, secret, text } from "@jr2/orchestrator";
 *
 * export const machine = jr2Setup({
 *   actors: {
 *     notify: http({
 *       method: "POST",
 *       url: text`https://api.telegram.org/bot${secret("telegram")}/sendMessage`,
 *       headers: { "x-run-source": text`jr2` },
 *       request: () => ({ json: { chat_id: "12345", text: "The run is done." } }),
 *     }),
 *   },
 * }).createMachine({
 *   id: "notify",
 *   initial: "notifying",
 *   states: {
 *     notifying: { invoke: { src: "notify", onDone: "done" } },
 *     done: { type: "final" },
 *   },
 * });
 * ```
 *
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/concepts/secrets-and-trust.md
 * @see docs/reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md
 */
export function text<const V extends Array<Secret | OpenSecret | string>>(
  strings: TemplateStringsArray,
  ...values: V
): MarkedIf<V[number], Text>;
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
    else if (isSecret(v)) parts.push(partOf(v));
    else throw new Error(`text\`…\`: a value is a secret("name") or a string, got ${JSON.stringify(v)}`);
  });
  return { text: parts };
}

/**
 * Make the `auth` of an `http` Effect that sends `Authorization: Bearer <value>`, with the value
 * of an Effect secret. In a packaged Machine, the secret can be `secret(open)`.
 *
 * It refuses a value that is not a secret: `bearer(…) takes a secret("name")`.
 *
 * @param s - The secret: `secret("name")`, or `secret(open)`.
 * @returns The `auth` of an `http` Effect.
 *
 * @example
 * ```ts
 * import { bearer, http, jr2Setup, secret } from "@jr2/orchestrator";
 *
 * export const machine = jr2Setup({
 *   actors: {
 *     status: http({
 *       method: "GET",
 *       url: "https://api.github.com/repos/you/app",
 *       auth: bearer(secret("github")),
 *     }),
 *   },
 * }).createMachine({
 *   id: "status",
 *   initial: "reading",
 *   states: {
 *     reading: { invoke: { src: "status", onDone: "done" } },
 *     done: { type: "final" },
 *   },
 * });
 * ```
 *
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/concepts/secrets-and-trust.md
 * @see docs/reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md
 * @see docs/reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md
 */
export function bearer<const S extends Secret>(s: S): MarkedIf<S, { readonly bearer: Secret }>;
export function bearer(s: Secret): { readonly bearer: Secret } {
  if (!isSecret(s)) throw new Error('bearer(…) takes a secret("name")');
  return { bearer: s };
}

/**
 * Make the `auth` of an `http` Effect that sends `Authorization: Basic <value>`, where the value
 * is the base64 of `user:password`. The Effector puts in the value of each secret.
 *
 * Each of `user` and `password` is a string, a `secret(...)` or a `text`. In a packaged Machine,
 * one of them can hold `secret(open)`. It refuses another value: `` expected a string, a
 * secret("name") or a text`…`, got <value> ``.
 *
 * @param user - The user name: a string, a `secret(...)` or a `text`.
 * @param password - The password: a string, a `secret(...)` or a `text`.
 * @returns The `auth` of an `http` Effect.
 *
 * @example
 * ```ts
 * import { basic, http, jr2Setup, secret } from "@jr2/orchestrator";
 *
 * export const machine = jr2Setup({
 *   actors: {
 *     issue: http({
 *       method: "GET",
 *       url: "https://jira.example.com/rest/api/2/issue/APP-1",
 *       auth: basic("jr2-bot@example.com", secret("jira-token")),
 *     }),
 *   },
 * }).createMachine({
 *   id: "issue",
 *   initial: "reading",
 *   states: {
 *     reading: { invoke: { src: "issue", onDone: "done" } },
 *     done: { type: "final" },
 *   },
 * });
 * ```
 *
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/concepts/secrets-and-trust.md
 * @see docs/reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md
 * @see docs/reference/decisions/0054-the-kit-ships-machines-and-a-shipped-machine-leaves-its-parts-open.md
 */
export function basic<const U extends string | Secret | Text, const P extends string | Secret | Text>(
  user: U,
  password: P,
): MarkedIf<U | P, { readonly basic: { user: Text; password: Text } }>;
export function basic(
  user: string | Secret | Text,
  password: string | Secret | Text,
): { readonly basic: { user: Text; password: Text } } {
  return { basic: { user: asText(user), password: asText(password) } };
}

function isSecret(v: unknown): v is Secret {
  return typeof v === "object" && v !== null && typeof (v as Secret).secret === "string" && !("text" in v);
}

/**
 * Whether these places of one definition — wire parts, secrets, `.path`s — name `secret(open)`
 * (ADR-0054). They may name one Open secret, in as many places as the author likes (a value and its
 * `.path`); a second `secret(open)` is refused: one binding names one secret.
 */
export function openSecretsIn(items: readonly unknown[]): boolean {
  const owners = new Set<object>();
  for (const item of items) {
    if (typeof item !== "object" || item === null || (item as { secret?: unknown }).secret !== OPEN_SECRET) continue;
    owners.add(openSecretOf.get(item) ?? item);
  }
  if (owners.size > 1) {
    throw new Error(
      "an Effect takes one Open secret — it names secret(open) in two places that are two secrets; name one " +
        'secret(open) and use it in each place, or name the others with secret("<name>") (ADR-0054)',
    );
  }
  return owners.size === 1;
}

/**
 * One value of a definition with its Open secret named (ADR-0054): `secret(open)` becomes
 * `secret(name)`, its `.path` that secret's `.path`, and a `text` part `{ secret: name }` inside a
 * `text`. A string, a named secret and a `text` with no Open part are as written. `secret(name)`
 * checks the name, as it checks one the author writes.
 */
function bindOpenValue(v: unknown, name: string): unknown {
  if (typeof v !== "object" || v === null) return v;
  const o = v as { secret?: unknown; path?: unknown; text?: unknown };
  if (o.secret === OPEN_SECRET) return o.path === true ? secret(name).path : secret(name);
  if (Array.isArray(o.text)) return { text: o.text.map((part) => bindOpenValue(part, name)) };
  return v;
}

/**
 * A header or env record with its Open secret named (ADR-0054): each VALUE is bound, by its place —
 * a key is the author's header or variable name, whatever it is (`bearer`, `secret`, `basic`), and
 * never read as a shape.
 */
export function bindOpenSecretIn<R extends Readonly<Record<string, unknown>> | undefined>(record: R, name: string): R {
  if (record === undefined) return record;
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, bindOpenValue(v, name)])) as R;
}

/** An http definition's auth with its Open secret named (ADR-0054): a `bearer` of it, a `basic`
 * pair holding it, or a `text` of it. */
export function bindOpenAuth<A extends HttpDefinition<z.ZodType | undefined>["auth"]>(auth: A, name: string): A {
  if (auth === undefined) return auth;
  if ("bearer" in auth) return { bearer: bindOpenValue(auth.bearer, name) } as A;
  if ("basic" in auth) {
    return {
      basic: { user: bindOpenValue(auth.basic.user, name), password: bindOpenValue(auth.basic.password, name) },
    } as A;
  }
  return bindOpenValue(auth, name) as A;
}

function asText(v: string | Secret | Text): Text {
  if (typeof v === "string") return { text: v === "" ? [] : [{ text: v }] };
  if (isSecret(v)) return { text: [partOf(v)] };
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
    /** The Repo Slot whose Worktree holds it. Write it only when the Workspace has more than one.
     */
    readonly slot?: string;
    /** Path segments that jr2 adds to the end of the url, as `path` of `request` does for a json
     * or text body. */
    readonly segments?: FromInput<S, readonly string[]>;
    /** The content type of the body. Write it or a `content-type` header, not both. With neither,
     * it is `application/octet-stream`. */
    readonly contentType?: string;
  };
};

/**
 * Make a Worktree file the body of an `http` Effect: `body: file("dist/report.pdf")`. The Effect
 * then runs in the Sandbox Effector of the Workspace whose body invokes it. That Effector opens the
 * file in the Worktree and sends it. Use it with `PUT`, `POST` or `PATCH`. `path` and `segments`
 * can be functions of the input of the Effect.
 *
 * Some paths and files give the output `refused`, and then nothing is sent. The path has a symlink
 * in it, has `..`, or is absolute. Or the file is a FIFO, a directory, or a file with more than one
 * link.
 *
 * It refuses, when you call it:
 * - a path that is not a string or a function: `file(path): the path is a string, or a function of
 *   the Effect's input that returns one`
 *
 * And when `http` takes the definition:
 * - a method other than `PUT`, `POST` and `PATCH`: `http({ method: "<method>", body: file(...) }):
 *   a file body is sent with PUT, POST, PATCH (ADR-0068)`
 * - a `request` beside it: ``http({ body: file(...), request }): with a file body the run's part
 *   is file()'s — its path, from the input if it must be, and its `segments` — so write no
 *   `request` (ADR-0068)``
 * - a `content-type` header and `contentType`: `http({ headers, body: file(path, { contentType })
 *   }): "content-type" is set by file()'s contentType — write one of them (ADR-0067)`
 *
 * And at `jr2 up`, an Effect that no `workspace()` invokes: `workflow "<workflow>": the http Effect
 * "<slot>" sends a Worktree file as its body, and no workspace() invokes it — outside a Workspace
 * there is no Worktree to read; invoke it from a workspace()'s body, or send a json or text body
 * (ADR-0068)`.
 *
 * @param path - The file, relative to the Worktree of the Repo Slot: a string, or a function of
 *   the input of the Effect that gives one.
 * @param options - Optional. Each field says what it does.
 * @returns The `body` of an `http` Effect.
 *
 * @example
 * ```ts
 * import {
 *   bearer,
 *   command,
 *   file,
 *   http,
 *   jr2Setup,
 *   secret,
 *   workspace,
 *   type Workspaced,
 * } from "@jr2/orchestrator";
 *
 * type Input = Workspaced<{}, "app">;
 *
 * const body = jr2Setup({
 *   types: {} as { context: Input; input: Input },
 *   actors: {
 *     build: command(["npm", "run", "report"]),
 *     upload: http({
 *       method: "PUT",
 *       url: "https://files.example.com/reports",
 *       auth: bearer(secret("files")),
 *       body: file("dist/report.pdf", {
 *         segments: ["report.pdf"],
 *         contentType: "application/pdf",
 *       }),
 *     }),
 *   },
 * }).createMachine({
 *   id: "report",
 *   context: ({ input }) => input,
 *   initial: "building",
 *   states: {
 *     building: { invoke: { src: "build", onDone: "uploading" } },
 *     uploading: { invoke: { src: "upload", onDone: "done" } },
 *     done: { type: "final" },
 *   },
 * });
 *
 * export const machine = workspace(body, {
 *   repos: { app: { url: "https://github.com/you/app.git" } },
 *   spec: () => ({ branch: "report" }),
 * });
 * ```
 *
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/concepts/effects.md
 * @see docs/reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md
 */
export function file<S extends z.ZodType | undefined = undefined>(
  path: FromInput<S, string>,
  options: {
    /** The Repo Slot whose Worktree holds the file. Write it only when the Workspace has more than
     * one. */
    slot?: string;
    /**
     * Path segments that jr2 adds to the end of the url, as `path` does in `request` for a json or
     * text body. A list of strings, or a function of the input of the Effect that gives one.
     */
    segments?: FromInput<S, readonly string[]>;
    /**
     * The content type of the body. Default `application/octet-stream`. Do not write it beside a
     * `content-type` header.
     */
    contentType?: string;
  } = {},
): FileBody<S> {
  // The Sandbox Effector opens the file beneath the Worktree with no symlink at any component
  // (ADR-0067, ADR-0068); the refusals it makes are output, never a fault.
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

/** What the `request` of an `http` definition returns: the part of the request that changes for
 * each run. The definition fixes the rest. */
export type HttpRequestParts = {
  /**
   * Path segments that jr2 adds to the end of the url. jr2 encodes each segment. A segment that
   * is `.`, `..` or empty gives the output `refused`, and nothing is sent.
   */
  path?: readonly string[];
  /** A JSON body. Do not give `text` too. When it starts, the Effect refuses both: ``http:
   * `request` returned both json and text``. */
  json?: unknown;
  /** A text body. */
  text?: string;
};

/** An `http` Effect's definition. */
export type HttpDefinition<S extends z.ZodType | undefined = undefined> = {
  /**
   * The HTTP method: `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS`. It refuses
   * another: `http({ method: "<method>" }): the method is one of GET, HEAD, POST, PUT, PATCH,
   * DELETE, OPTIONS`.
   */
  method: HttpMethod;
  // The scheme and host are literal so that no param reaches the host (ADR-0068); an Open url is
  // bound once by the composer, never per run (ADR-0054).
  /**
   * The url: `http://` or `https://`, then a literal host. No input, param or Effect secret can
   * change where the call goes. An Effect secret can be only in the path:
   * `` text`https://api.telegram.org/bot${secret("tg")}/sendMessage` ``.
   *
   * Or `open`: a packaged Machine that cannot know the host leaves the url Open, and the composer
   * binds it one time with `customize(machine, { effects: { <slot>: { url } } })`.
   *
   * It refuses:
   * - a scheme or host that is not literal: `` http({ url }): the url is an http:// or https:// url
   *   whose scheme and host are literal — a secret may sit only in its path, after a "/":
   *   text`https://api.example.com/bot${secret("tg")}/send` (ADR-0068) ``
   * - an Effect secret after `?` or `#`: `` http({ url }): secret("<name>") sits in the url's query
   *   or fragment — a secret may sit only in its path; send it in `auth` or a header instead:
   *   headers: { "x-api-key": text`${secret("...")}` } (ADR-0068) ``
   * - a host that is not a host: `http({ url }): "<scheme>://<host>" is not a host`
   * - a user name or password in the url: ``http({ url }): the url carries userinfo — use `auth` ``
   */
  url: string | Text | typeof open;
  /**
   * Headers that are the same for each run. Each name is lowercase. A value is a string, or a
   * `text` with an Effect secret.
   *
   * It refuses:
   * - a name that is not lowercase, or that frames or routes the request (`host`,
   *   `content-length`, `transfer-encoding`, `connection`, `upgrade`, `te`, `trailer`,
   *   `keep-alive`, `proxy-*`): `http({ headers }): "<name>" is not a header an Effect sets — a
   *   lowercase name that does not frame or route the request (ADR-0068)`
   * - an `authorization` header beside `auth`: ``http({ headers }): "authorization" is set by
   *   `auth` — write one of them``
   */
  headers?: Readonly<Record<string, string | Text>>;
  /**
   * The `Authorization` header: `bearer(secret("x"))`, `basic(user, password)`, or a `text` that
   * is the whole value.
   */
  auth?: { readonly bearer: Secret } | { readonly basic: { user: Text; password: Text } } | Text;
  /**
   * The zod schema of the input of the Effect: what the `input` of the `invoke`, or `fromPick`,
   * gives it. jr2 parses the input with it before the call. When it starts, input that does not
   * agree with it makes the Effect fail (its `onError` route): `http "<slot>": its input does not
   * match the definition's input schema — <path>: <message>`, one `<path>: <message>` for each
   * problem, joined by `; `.
   */
  input?: S;
  /**
   * A function that makes the part of the request that changes for each run, from the input:
   * `path` segments, and a `json` or `text` body. It cannot change the host, a header or an
   * Effect secret. Do not write it beside `body`.
   */
  request?: (input: S extends z.ZodType ? z.infer<S> : void) => HttpRequestParts;
  // A file body is an ADR-0067 Effect: the Sandbox Effector of the Workspace sends it.
  /**
   * A Worktree file as the body: `file(path, { slot?, segments?, contentType? })`. The Effect then
   * runs in the Sandbox Effector of its Workspace. Do not write `request` beside it: the `segments`
   * of `file` are the path. It refuses another body: ``http({ body }): a body is file(path, {
   * slot?, segments?, contentType? }) — json and text come from `request` ``.
   */
  body?: FileBody<S>;
  /**
   * How long jr2 waits for the answer: a number and a unit, such as `"30s"` or `"2m"`. Default
   * `"30s"`. With no answer in that time, the output is `unknown`. It refuses a value that is not
   * a positive duration: `http: timeout "<timeout>" is not a positive duration (like "30s",
   * "2m")`.
   */
  timeout?: Duration;
  /**
   * The largest number of bytes of a text response body that the output keeps. Default 65536.
   * When jr2 cuts the body, `truncated` is `true`. It refuses a value that is not a positive whole
   * number: `http({ maxBody }): a positive number of bytes`.
   */
  maxBody?: number;
  // The restore rule (ADR-0067): a restore that finds no replica holding the call sends it again
  // only when it is marked; unmarked, it settles `unknown`.
  /**
   * `true` when it is safe to send the call two times: it has its own idempotency key, or it only
   * reads. Default `false`. After an Orchestrator restart, jr2 cannot always tell if the call went
   * out. Then it sends an idempotent call again, and gives any other call the output `unknown`.
   */
  idempotent?: boolean;
};

/** @internal */
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
  if (url.some((p) => "secret" in p && p.secret === OPEN_SECRET)) {
    // A url that carries a secret is left Open whole (ADR-0054): the composer binds it with its
    // secret in its path, so two copies of one Machine spend two teams' secrets.
    throw new Error(
      "secret(open) in a url: a url's secret is not an Open part — leave the whole url Open " +
        "(`url: open`) and let the composer bind it with its secret in its path (ADR-0054)",
    );
  }
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
  // An Open secret (ADR-0054) is the composer's to name: its places are the auth and the headers,
  // one per Effect, and it names no secret until `customize()` binds it.
  const opened = openSecretsIn([
    ...Object.values(headers).flat(),
    ...(def.auth === undefined
      ? []
      : "bearer" in def.auth
        ? [def.auth.bearer]
        : "basic" in def.auth
          ? [...def.auth.basic.user.text, ...def.auth.basic.password.text]
          : asText(def.auth).text),
  ]);
  const named = secrets.filter((name) => name !== OPEN_SECRET);
  secrets.splice(0, secrets.length, ...named);
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
    ...(opened ? { openSecret: true as const } : {}),
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

/**
 * The unbound logic of an http definition with Open parts (ADR-0054) — its url, an Open secret in
 * its auth or a header, or both — or undefined when every part is fixed. Binding builds the Effect
 * again, whole, with `rebuild` (its own constructor) over the definition with the bound parts, so
 * the bound one is checked like any definition; a binding that names one of two Open parts gives an
 * Effect still Open in the other.
 */
export function openHttpOf<S extends z.ZodType | undefined>(
  def: HttpDefinition<S>,
  rebuild: (def: HttpDefinition<S>) => unknown,
): EffectLogic<unknown, unknown> | undefined {
  const parts = def.url === open ? openHttpParts(def) : httpParts(def);
  const opened = openPartsOf(parts);
  if (opened.length === 0) return undefined;
  return openEffectLogic(parts, opened, (binding) => {
    if (binding.argv !== undefined) {
      throw new Error(
        `an http Effect's Open parts are its url and its secret — bind it with ${effectBindingShape(opened)}, not an argv`,
      );
    }
    let bound: HttpDefinition<S> = def;
    if (binding.url !== undefined) bound = { ...bound, url: binding.url };
    if (binding.secret !== undefined) {
      const headers = bindOpenSecretIn(bound.headers, binding.secret);
      const auth = bindOpenAuth(bound.auth, binding.secret);
      bound = { ...bound, ...(headers !== undefined ? { headers } : {}), ...(auth !== undefined ? { auth } : {}) };
    }
    return rebuild(bound) as EffectLogic<unknown, unknown>;
  });
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
export function httpWith<
  S extends z.ZodType | undefined = undefined,
  const U extends HttpDefinition<S>["url"] = string,
  const A extends HttpDefinition<S>["auth"] = undefined,
  const H extends HttpDefinition<S>["headers"] = undefined,
>(
  portFactory: EffectorPortFactory,
  def: HttpDefinition<S> & { url: U; auth?: A; headers?: H },
): EffectLogic<HttpInput<S>, HttpOutput> & OpenOf<HttpOpenParts<U, A, H>>;
export function httpWith<S extends z.ZodType | undefined = undefined>(
  portFactory: EffectorPortFactory,
  def: HttpDefinition<S>,
): EffectLogic<HttpInput<S>, HttpOutput> {
  const unbound = openHttpOf(def, (bound) => httpWith(portFactory, bound));
  if (unbound) return unbound as EffectLogic<HttpInput<S>, HttpOutput>;
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
 * unknown": an http Effect has no stop route, so the Effector finishes the call and drops an
 * outcome nobody reads. The Machine never hears it.
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
 * Make an `http` Effect: a call to a URL, with Effect secrets that the Agent never reads. Put it
 * in `actors`, and invoke it by its key: `actors: { comment: http({ ... }) }`, then `invoke: {
 * src: "comment" }`.
 *
 * It runs in the Instance Effector, which `jr2 up` deploys when a Machine has an `http` Effect.
 * With `body: file(...)`, it runs in the Sandbox Effector of the Workspace whose body invokes it.
 * The Effector makes the call. The Orchestrator holds no secret.
 *
 * Every outcome is output (`HttpOutput`): `response`, `unreachable`, `refused` or `unknown`. A 4xx
 * or 5xx status is output too. jr2 sends the call at most one time, unless you mark it
 * `idempotent`. When its state exits while the call runs, jr2 stops waiting for it. The Effector
 * can still send it.
 *
 * Each field of {@link HttpDefinition} tells what it refuses. `createMachine` also refuses an
 * Effect written directly in an `invoke`: `machine "<id>": state "<state>" invokes an Effect
 * inline — a Part is a key of actors, so it has a name that the ledger, the report and
 * customize() share: actors: { <name>: http(...) }, then invoke: { src: "<name>" }`.
 *
 * @param def - The definition. Each field tells what it does.
 * @returns An Effect, for `actors`.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { bearer, http, jr2Setup, secret } from "@jr2/orchestrator";
 *
 * const comment = http({
 *   method: "POST",
 *   url: "https://jira.example.com/rest/api/2/issue",
 *   auth: bearer(secret("jira")),
 *   input: z.object({ key: z.string(), body: z.string() }),
 *   request: ({ key, body }) => ({ path: [key, "comment"], json: { body } }),
 * });
 *
 * export const machine = jr2Setup({
 *   types: {} as { context: { key: string }; input: { key: string } },
 *   actors: { comment },
 * }).createMachine({
 *   id: "comment",
 *   context: ({ input }) => input,
 *   initial: "commenting",
 *   states: {
 *     commenting: {
 *       invoke: {
 *         src: "comment",
 *         input: ({ context }) => ({ key: context.key, body: "The build passed." }),
 *         onDone: "done",
 *       },
 *     },
 *     done: { type: "final" },
 *   },
 * });
 * ```
 *
 * @see docs/concepts/effects.md
 * @see docs/guides/run-a-command-or-call-a-url.md
 * @see docs/concepts/secrets-and-trust.md
 * @see docs/reference/decisions/0068-an-effector-holds-an-effects-secrets-and-signs-its-wire.md
 * @see docs/reference/decisions/0067-an-effect-is-an-actor-slot-and-runs-at-most-once-unless-marked-idempotent.md
 */
export function http<
  S extends z.ZodType | undefined = undefined,
  const U extends HttpDefinition<S>["url"] = string,
  const A extends HttpDefinition<S>["auth"] = undefined,
  const H extends HttpDefinition<S>["headers"] = undefined,
>(
  def: HttpDefinition<S> & { url: U; auth?: A; headers?: H },
): EffectLogic<HttpInput<S>, HttpOutput> & OpenOf<HttpOpenParts<U, A, H>>;
export function http<S extends z.ZodType | undefined = undefined>(
  def: HttpDefinition<S>,
): EffectLogic<HttpInput<S>, HttpOutput> {
  // The Orchestrator signs the start, and the Effector builds the request: the definition's parts,
  // and `request`'s from the input (ADR-0068).
  if (def.body !== undefined) return httpFileWith(sandboxEffectorPort, def);
  return httpWith(
    (target) => createEffectorClient({ key: target.key, transport: nodeEffectorTransport(target.service) }),
    def,
  );
}
