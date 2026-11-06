// The TYPE-level claims of `@jr2/orchestrator/hooks` (ADR-0078, ADR-0011), asserted by the compiler.
// `pnpm typecheck` is what runs this file: each `@ts-expect-error` below fails the build if the
// error it names stops happening. The claims sit in a function that never runs, because some of
// them would throw at run time (`defineHookKind` refuses `api: 2` there too).
//
// The claims:
//   1. a kind never gets a credential: `read` gets the request alone, and the request holds none;
//   2. a `mac` kind gives the signed bytes, never a verdict;
//   3. a kind is synchronous, and the door gives it no clock;
//   4. a kind with no `answer` cannot say that a person reads the answer;
//   5. only `api: 1` exists, and a follow-up host is https;
//   6. a Hook's config gives the credential that its verifier needs, as a named secret;
//   7. the handlers of a kind hear only the keys that its schemas name, keyed by the kind's id, and
//      never a key that holds `*`;
//   8. a handler's payload is the schema's output, with only its named fields;
//   9. an `events` entry is a zod schema, for a kind and for `webhook()`;
//  10. two kinds with one id do not compile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  defineHookKind,
  type HookKindOf,
  type HookRequest,
  type KindHooks,
  type PayloadOf,
} from "../src/hook-kinds/index.ts";
import { discord } from "../src/hook-kinds/discord.ts";
import { github } from "../src/hook-kinds/github.ts";
import { slack } from "../src/hook-kinds/slack.ts";
import { webhook } from "../src/hook-kinds/webhook.ts";

const E = { "thing.done": z.looseObject({ id: z.string() }) };
const delivery = (req: HookRequest) => ({ key: "thing.done", id: req.headers["x-id"] ?? "", payload: {} });

/** A kind that gives a second `github`; never made at run time. */
declare const otherGithub: HookKindOf<
  "github",
  { readonly push: z.ZodObject<{ ref: z.ZodString }> },
  { readonly token: { readonly header: string } }
>;

/** A kind whose `HookKinds` key is not its id; never made at run time. */
declare const misnamed: HookKindOf<
  "tracker",
  { readonly "ticket.moved": z.ZodObject<{ id: z.ZodString }> },
  { readonly token: { readonly header: string } }
>;

declare module "../src/hook-kinds/index.ts" {
  interface HookKinds {
    // @ts-expect-error 10. A second kind with the id `github` does not compile ("Subsequent property
    // declarations must have the same type"). `jr2 up` refuses the same at run time (`kindsById`).
    github: typeof otherGithub;
    // The door matches by `id` ("tracker"), so a handler keyed `track` would reach nothing (7).
    track: typeof misnamed;
  }
}

type Approve = { readonly type: "approve"; readonly by: string };
type Handlers = KindHooks<{ readonly meta: { readonly pr: string } }, Approve | undefined>;

export function claims(): unknown[] {
  return [
    // 1. `read` gets the request and nothing more: no Hook, no credential.
    defineHookKind({
      api: 1,
      id: "k1",
      events: E,
      verify: { token: { header: "x-token" } },
      // @ts-expect-error A second parameter (the Hook, its secret) is never given.
      read: (req: HookRequest, hook: { secret: string }) => ({ ...delivery(req), id: hook.secret }),
    }),
    defineHookKind({
      api: 1,
      id: "k2",
      events: E,
      verify: { token: { header: "x-token" } },
      // @ts-expect-error `credential` is not on the request.
      read: (req) => ({ ...delivery(req), id: req.credential }),
    }),

    // 2. `signed` gives `{ bytes, signature, at? }`; the door asks the Instance Effector.
    defineHookKind({
      api: 1,
      id: "k3",
      events: E,
      // @ts-expect-error `signed` gives the bytes and the signature, never a verdict.
      verify: { mac: { alg: "sha256", signed: () => ({ match: true }) } },
      read: delivery,
    }),

    // 3. No Promise, and no clock.
    defineHookKind({
      api: 1,
      id: "k4",
      events: E,
      verify: { token: { header: "x-token" } },
      // @ts-expect-error `read` cannot wait.
      read: async (req) => delivery(req),
    }),
    defineHookKind({
      api: 1,
      id: "k5",
      events: E,
      // @ts-expect-error `signed` cannot wait.
      verify: { ed25519: { signed: async (req) => ({ bytes: [req.body], signature: { hex: "" } }) } },
      read: delivery,
    }),
    defineHookKind({
      api: 1,
      id: "k6",
      events: E,
      verify: { token: { header: "x-token" } },
      // @ts-expect-error The door gives no `now`. A signed timestamp goes back to the door as `at`.
      read: (req: HookRequest, now: number) => ({ ...delivery(req), id: String(now) }),
    }),

    // 4. `readBy: "person"` needs `answer`. (An overload refuses it, so the error is on the call.)
    // @ts-expect-error A kind with no `answer` cannot give `readBy: "person"`.
    defineHookKind({
      api: 1,
      id: "k7",
      events: E,
      verify: { token: { header: "x-token" } },
      read: (req) => ({ ...delivery(req), readBy: "person" as const }),
    }),

    // 5. `api: 1` only; a post host is https.
    defineHookKind({
      // @ts-expect-error jr2 1.x knows `api: 1` only.
      api: 2,
      id: "k8",
      events: E,
      verify: { token: { header: "x-token" } },
      read: delivery,
    }),
    // @ts-expect-error A post host is https.
    defineHookKind({
      api: 1,
      id: "k9",
      events: E,
      verify: { token: { header: "x-token" } },
      read: (req) => ({ ...delivery(req), readBy: "person" as const }),
      answer: (text: string) => ({ body: null, then: { post: "https://hooks.example.com/r", json: { text } } }),
      posts: ["http://hooks.example.com/"],
    }),

    // 6. The credential of each verifier.
    // @ts-expect-error `discord` verifies with a public key, not a secret.
    discord({ secret: { secret: "DISCORD" } }),
    // @ts-expect-error `github` verifies with a secret, not a public key.
    github({ publicKey: "8f3b" }),
    // @ts-expect-error A secret is named with `secret()`; its value is never in the config.
    github({ secret: process.env.GH_HOOK }),
    // @ts-expect-error `may` names Workflows whose Gates the Hook answers; a Hook never starts.
    github({ secret: { secret: "GH" }, may: { start: "all" } }),
    github({ secret: { secret: "GH" }, may: { answer: ["review"] } }),
    slack({ secret: { secret: "SLACK" } }),

    // 9. An `events` entry is a zod schema.
    defineHookKind({
      api: 1,
      id: "e1",
      // @ts-expect-error `{ id: "string" }` is not a zod schema.
      events: { "thing.done": { id: "string" } },
      verify: { token: { header: "x-token" } },
      read: delivery,
    }),
    webhook({
      id: "e2",
      // @ts-expect-error A TypeScript type is not a schema; `webhook()` takes a zod schema for each event name.
      events: { "build.done": {} as { readonly id: string } },
      verify: { token: { header: "x-token" } },
      key: { json: "type" },
      delivery: { json: "id" },
    }),
  ];
}

// 7. The handlers of a kind: keyed by the kind's id, then by an event key that a schema names.
export const h0: Handlers = {
  github: {
    "pull_request_review.submitted": ({ payload, meta }) =>
      payload.pull_request.html_url === meta.pr && payload.review.state === "approved"
        ? { type: "approve", by: payload.review.user.login }
        : undefined,
  },
  slack: { "block_actions.approve": ({ payload }) => ({ type: "approve", by: payload.user.id }) },
  discord: { "application_command.jr2": ({ payload }) => ({ type: "approve", by: payload.data.name }) },
};
export const h1: Handlers = {
  github: {
    // @ts-expect-error The `github` kind names no schema for `pull_request.closed`.
    "pull_request.closed": () => undefined,
  },
};
export const h2: Handlers = {
  slack: {
    // @ts-expect-error A handshake is the kind's. No handler hears `url_verification`.
    url_verification: () => undefined,
  },
};
export const h3: Handlers = {
  // @ts-expect-error No kind in scope has the id `jira`.
  jira: {},
};
export const h4: Handlers = {
  // @ts-expect-error `track` is not the id of the kind that it names, so no handler is keyed by it.
  track: { "ticket.moved": () => undefined },
};
export const h5: Handlers = {
  github: {
    // @ts-expect-error A handler gives an event of its Gate, and `reject` is not one.
    "pull_request_review.submitted": () => ({ type: "reject", by: "x" }),
  },
};
export const h6: Handlers = {
  slack: {
    // @ts-expect-error A key with `*` is a schema's key, never a handler's: the door matches a key
    // exactly. Name the full key, `block_actions.approve`.
    "block_actions.*": () => ({ type: "approve", by: "x" }),
  },
};

// 8. A payload is the output of its kind's schema, and nothing more.
export const p1: Handlers = {
  github: {
    "issue_comment.created": ({ payload: p }) =>
      // @ts-expect-error GitHub sends `comment.id`, but the schema does not name it.
      p.comment.id === 1 ? { type: "approve", by: p.comment.user.login } : undefined,
  },
};
type Review = PayloadOf<"github", "pull_request_review.submitted">;
export const p2 = (r: Review): string | null => r.review.body;
// @ts-expect-error `PayloadOf` takes a key that the kind's schemas name.
export type P3 = PayloadOf<"github", "pull_request.closed">;

test("the type claims compile (pnpm typecheck checks them); the handlers run as typed", () => {
  assert.equal(typeof claims, "function");
  const by = h0.slack?.["block_actions.approve"]?.({
    meta: { pr: "x" },
    payload: { user: { id: "U1" }, actions: [], response_url: "https://hooks.slack.com/a" },
  });
  assert.deepEqual(by, { type: "approve", by: "U1" });
});
