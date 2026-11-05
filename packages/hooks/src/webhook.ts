// `@jr2/hooks/webhook`: the general kind, for a service that has no kind of its own (ADR-0078). It
// makes a kind from data, through `defineHookKind`, as each other kind is made. So it gives a kind
// nothing that the interface does not give a kind from another package.
//
// It makes a kind, not a Hook: the service's protocol is the same for each Instance, so the
// Instance writes it one time, in a module of its own that `jr2.config.ts` imports for its Hooks
// and the Workflows import for their handlers. The Hook in the config gives only the credential
// and `may`.
//
// What it cannot do: a handshake, a body that is not JSON, a signature over more than the raw
// body, a signed timestamp, and an answer that a person reads. A service that needs one of them
// needs a kind module.

import {
  at,
  defineHookKind,
  json,
  type Events,
  type HookKindOf,
  type HookRequest,
  type MacAlg,
  type Verify,
} from "@jr2/hooks";

/** Where a value is in a delivery: a header (lowercase), or a dotted path in the JSON body. */
export type Field = { readonly header: string } | { readonly json: string };

/** How the general kind verifies. `mac` is over the raw body only. */
export type WebhookVerify =
  | {
      readonly mac: {
        /** The header of the signature (lowercase). */
        readonly header: string;
        /** `sha256` when it is not given. */
        readonly alg?: MacAlg;
        /** The text before the signature in the header's value, such as `sha256=`. */
        readonly prefix?: string;
        /** `hex` when it is not given. */
        readonly encoding?: "hex" | "base64";
      };
    }
  | { readonly token: { readonly header: string } };

type VerifyOf<W extends WebhookVerify> = W extends { readonly mac: unknown }
  ? Extract<Verify, { readonly mac: unknown }>
  : Extract<Verify, { readonly token: unknown }>;

/** The text of a field's value: a string, or a number as a string. */
function pick(req: HookRequest, body: unknown, f: Field): string | undefined {
  const v = "header" in f ? req.headers[f.header.toLowerCase()] : at(body, f.json);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * A kind from data.
 * - `id`: the kind's id. The Instance chooses it; it must not be the id of another kind.
 * - `events`: a zod schema for each event key that a handler can hear. The door parses with it, as
 *   for each kind (`Events` in `@jr2/hooks`).
 * - `verify`: `mac` over the raw body (the header, its prefix, the algorithm, the encoding), or
 *   `token` in a header.
 * - `key`: the event key, from one field; or `{ name, action }`, which gives `<name>.<action>`, or
 *   `<name>` when the delivery has no action.
 * - `delivery`: the delivery id. `onBehalfOf`: optional.
 *
 * The answer is the outcome JSON.
 */
export function webhook<const Id extends string, const E extends Events, const W extends WebhookVerify>(spec: {
  readonly id: Id;
  readonly events: E;
  readonly verify: W;
  readonly key: Field | { readonly name: Field; readonly action?: Field };
  readonly delivery: Field;
  readonly onBehalfOf?: Field;
}): HookKindOf<Id, E, VerifyOf<W>> {
  const sv = spec.verify as WebhookVerify;
  let verify: Verify;
  if ("mac" in sv) {
    const mac = sv.mac;
    const header = mac.header.toLowerCase();
    const prefix = mac.prefix ?? "";
    verify = {
      mac: {
        alg: mac.alg ?? "sha256",
        signed: (req) => {
          const raw = req.headers[header];
          if (raw === undefined || !raw.startsWith(prefix)) return { unsigned: `no ${header} header` };
          const value = raw.slice(prefix.length);
          return { bytes: [req.body], signature: mac.encoding === "base64" ? { base64: value } : { hex: value } };
        },
      },
    };
  } else {
    verify = { token: { header: sv.token.header.toLowerCase() } };
  }
  const k = spec.key;
  return defineHookKind({
    api: 1,
    id: spec.id,
    events: spec.events,
    verify,
    read: (req) => {
      const body = json(req);
      const name = "name" in k ? pick(req, body, k.name) : pick(req, body, k);
      const action = "name" in k && k.action ? pick(req, body, k.action) : undefined;
      const id = pick(req, body, spec.delivery);
      if (name === undefined) throw new Error("the delivery has no event name");
      if (id === undefined) throw new Error("the delivery has no delivery id");
      const by = spec.onBehalfOf ? pick(req, body, spec.onBehalfOf) : undefined;
      return { key: action ? `${name}.${action}` : name, id, payload: body, ...(by ? { onBehalfOf: by } : {}) };
    },
  }) as unknown as HookKindOf<Id, E, VerifyOf<W>>;
}
