// The Secret of one slot of the Custodian of an Instance (`jr2-custodian-slot-<i>`, ADR-0084): what
// the Orchestrator writes for a Harness pod (`jr2 up` for slots 0–2), and what the Custodian pod's
// control process reads to render the slot's rules (`custodian-control.ts`). Pure: the format and
// its check, no I/O.
//
//   slot.json            the slot's spec (`SlotSpec`): its Harness pod, its held manifest, its
//                        placeholder table, and the pod whose literal values it reads. Names only
//   values.<file>        a file of the slot's folder of values: the control token and its Stand-in,
//                        the fetch token, each held secret's Stand-in (`<NAME>.standin`)
//   tls.<stem>.crt|key   the leaf of an Intercepted host (`leafStem`), and of jr2's own name
//
// A held secret's VALUE is in this Secret only for a slot that names no `heldPod` (a check pod: the
// slot Secret holds the copy of its literal values as `values.<NAME>`, and `jr2 up` deletes the
// Secret after the check). Else it is in the pod's `jr2-held-secrets-<heldPod>` (a literal) or in
// the user's own Secret (`secretKeyRef`), so a rotation reaches the Custodian with no new slot Secret
// (ADR-0059); a `values.<NAME>` of this Secret is then not read. A Secret's key cannot hold a `/`,
// so each key names one file of one of the two folders, and no key names a file outside them.

import { z } from "zod";
import type { SlotOwner } from "./custodian-rules.ts";
import type { HeldManifest } from "./held-secrets.ts";
import type { PlaceholderTable } from "./placeholders.ts";

/** The key of the slot's spec. */
export const SLOT_SPEC_KEY = "slot.json";

/** What a slot's rules are made from, as the slot Secret states it. */
export type SlotSpec = {
  version: 1;
  owner: SlotOwner;
  manifest: HeldManifest;
  placeholders: PlaceholderTable;
  /** The pod whose `jr2-held-secrets-<pod>` holds the slot's literal values. Absent when the
   * manifest has no literal, or when the slot Secret holds each literal's value itself
   * (`values.<NAME>`: a check pod). */
  heldPod?: string;
};

/** A slot's own files, by their path in its folder (`values/<file>`, `tls/<file>`). */
export type SlotFiles = Map<string, Buffer>;

/** The two folders of a slot that the Secret fills, and the prefix of each one's keys. */
const FOLDERS = ["values", "tls"] as const;

/** A Kubernetes object name (RFC 1123 subdomain): what a Sandbox, a pod label or a Secret is named. */
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
/** One file of a folder: a Secret key's own characters, and never `.` or `..`. */
const FILE = /^[A-Za-z0-9_.-]{1,240}$/;

const name = z.string().regex(NAME);
/** One held secret: the names that say where its value is. The renderer checks its hosts and headers. */
const binding = z
  .object({
    name: z.string().min(1),
    source: z.union([
      z.object({ kind: z.literal("literal") }).strict(),
      z.object({ kind: z.literal("secret"), secret: name, key: z.string().regex(/^[-._a-zA-Z0-9]{1,253}$/) }).strict(),
    ]),
    hosts: z.array(z.any()),
    headers: z.array(z.any()),
  })
  .passthrough();
const spec = z.object({
  version: z.literal(1),
  owner: z.union([z.object({ sandbox: name }).strict(), z.object({ pod: name }).strict()]),
  manifest: z.object({ version: z.literal(1), secrets: z.array(binding), egress: z.array(z.any()) }).passthrough(),
  placeholders: z.object({
    range: z.string(),
    rows: z.array(z.object({ name: z.string(), address: z.string() }).strict()),
  }),
  heldPod: name.optional(),
});

/** The Secret's data of one slot, as `stringData`. `files` holds the slot's own files by their path in
 * its folder; each must be in `values/` or `tls/`. */
export function slotSecretData(slotSpec: SlotSpec, files: ReadonlyMap<string, string>): Record<string, string> {
  const data: Record<string, string> = { [SLOT_SPEC_KEY]: JSON.stringify(slotSpec) };
  for (const [path, text] of files) data[keyOf(path)] = text;
  return data;
}

/** The key of a file of a slot's folder. */
function keyOf(path: string): string {
  const [folder, file, ...rest] = path.split("/");
  if (!FOLDERS.includes(folder as (typeof FOLDERS)[number]) || file === undefined || rest.length > 0) {
    throw new Error(`a slot Secret holds files of values/ and tls/ alone, not ${path}`);
  }
  if (!FILE.test(file) || file === "." || file === "..") throw new Error(`${path} is not a file name of a slot`);
  return `${folder}.${file}`;
}

/**
 * A slot Secret's spec and files, from its data (each value base64, as the API gives it). Throws,
 * with a reason that names a key and never a value, when the spec is not a slot spec, or a key is
 * not one of the slot's files. The renderer checks the rest (`renderSlot`).
 */
export function readSlotSecret(data: Record<string, string> | undefined): { spec: SlotSpec; files: SlotFiles } {
  const raw = data?.[SLOT_SPEC_KEY];
  if (raw === undefined) throw new Error(`the slot Secret has no ${SLOT_SPEC_KEY}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new Error(`${SLOT_SPEC_KEY} is not JSON`);
  }
  const checked = spec.safeParse(parsed);
  if (!checked.success) {
    const at = checked.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new Error(`${SLOT_SPEC_KEY} is not a slot spec: ${at}`);
  }
  const files: SlotFiles = new Map();
  for (const [key, value] of Object.entries(data!)) {
    if (key === SLOT_SPEC_KEY) continue;
    const folder = FOLDERS.find((f) => key.startsWith(`${f}.`));
    const file = folder === undefined ? undefined : key.slice(folder.length + 1);
    if (folder === undefined || file === undefined || !FILE.test(file) || file === "." || file === "..") {
      throw new Error(`the slot Secret's key ${key} is not a file of values/ or tls/`);
    }
    files.set(`${folder}/${file}`, Buffer.from(value, "base64"));
  }
  return { spec: checked.data as SlotSpec, files };
}
