// `hook-kinds/door.ts`: what the Hook's door reads from a Hook and a kind. The package does not
// export it, because it is NOT part of a kind's interface: a kind imports `@jr2/orchestrator/hooks` only. It is here because
// `defineHookKind` decides the shape of a Hook, so the code that reads a Hook is beside it.

import type { z } from "zod";
import { HOOK } from "./hook.ts";
import { HOOK_KIND_APIS, type Hook, type HookKind, type HookParts, type HookRequest, type Signed } from "./index.ts";

/** True when `value` is a Hook that a kind's constructor made. */
export function isHook(value: unknown): value is Hook {
  return typeof value === "object" && value !== null && Object.hasOwn(value, HOOK);
}

/** The kind, the credential and `may` of a Hook. It throws when `hook` is not a Hook. */
export function hookParts<K extends HookKind>(hook: Hook<K>): HookParts<K> {
  if (!isHook(hook)) throw new Error("not a Hook: make it with its kind, such as github({ secret, may })");
  return hook[HOOK];
}

/**
 * The request that the door gives a kind. Header names become lowercase. A header with more than
 * one value keeps them joined by ", ", as `Headers` does. `strip` names a header that the door
 * removes (the `token` verifier's header), so no code of the kind can read it.
 */
export function hookRequest(
  headers: Headers | { readonly [name: string]: string | readonly string[] | undefined },
  body: Uint8Array,
  strip?: string,
): HookRequest {
  const out: { [name: string]: string } = Object.create(null) as { [name: string]: string };
  const entries: Iterable<[string, string | readonly string[] | undefined]> =
    headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [name, value] of entries) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    const text = typeof value === "string" ? value : value.join(", ");
    out[lower] = Object.hasOwn(out, lower) ? `${out[lower]}, ${text}` : text;
  }
  if (strip !== undefined) delete out[strip.toLowerCase()];
  const bytes = new Uint8Array(body);
  return Object.freeze({
    headers: Object.freeze(out),
    body: bytes,
    text: new TextDecoder("utf-8").decode(bytes),
  });
}

/**
 * The schema of an event key: the exact key, else the longest `prefix.*` key that the event key
 * starts with (`block_actions.*` for `block_actions.approve`). `undefined` when the kind names no
 * schema for the key: the door does not parse such a delivery, and it reaches nothing.
 */
export function schemaFor(kind: HookKind, key: string): z.ZodType | undefined {
  if (Object.hasOwn(kind.events, key)) return kind.events[key];
  let best: { readonly length: number; readonly schema: z.ZodType } | undefined;
  for (const [k, schema] of Object.entries(kind.events)) {
    if (!k.endsWith(".*")) continue;
    const prefix = k.slice(0, -1); // keeps the "."
    if (key.length > prefix.length && key.startsWith(prefix) && (!best || prefix.length > best.length)) {
      best = { length: prefix.length, schema };
    }
  }
  return best?.schema;
}

/** The bytes that the service signed, joined. A string part is UTF-8. */
export function signedBytes(signed: Signed): Uint8Array {
  const parts = signed.bytes.map((b) => (typeof b === "string" ? new TextEncoder().encode(b) : b));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

/** The signature as bytes, or `undefined` when its hex or base64 is not well formed. */
export function signatureBytes(signed: Signed): Uint8Array | undefined {
  const s = signed.signature;
  if ("hex" in s) {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(s.hex)) return undefined;
    return Uint8Array.from(Buffer.from(s.hex, "hex"));
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s.base64) || s.base64.length % 4 !== 0) return undefined;
  return Uint8Array.from(Buffer.from(s.base64, "base64"));
}

/**
 * The kinds of one Assembly, by id. It throws when two different kinds give one id, or when a kind
 * states an `api` that this copy of `@jr2/orchestrator/hooks` does not know. One kind that two Hooks use is one
 * entry.
 */
export function kindsById(kinds: Iterable<HookKind>): ReadonlyMap<string, HookKind> {
  const out = new Map<string, HookKind>();
  for (const kind of kinds) {
    if (!HOOK_KIND_APIS.includes(kind.api)) {
      throw new Error(`Hook kind ${kind.id} states api ${String(kind.api)}; this jr2 knows api 1 only`);
    }
    const had = out.get(kind.id);
    if (had !== undefined && had !== kind) {
      throw new Error(`two different Hook kinds have the id ${kind.id}: one id is one kind in an Assembly`);
    }
    out.set(kind.id, kind);
  }
  return out;
}
