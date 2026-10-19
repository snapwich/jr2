// An object or array property's textarea, parsed (ADR-0033, ADR-0070): a Chart wrapper's one-shot
// door takes `chart` as an object, so the Console's start form sends JSON of the property's type,
// never a string. DOM-free, so the Node test project can read it without the browser libs.

/** One property of a flat object schema, as far as the form reads it. */
export type SchemaProp = { type?: string; enum?: unknown[]; description?: string };

/** An object or array property's textarea, parsed: absent when empty, an error that names the
 *  field when the text is not JSON of the property's type. */
export function jsonField(key: string, prop: SchemaProp, text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${key}: not valid JSON`);
  }
  const isArray = Array.isArray(parsed);
  const ok = prop.type === "array" ? isArray : parsed !== null && typeof parsed === "object" && !isArray;
  if (!ok) throw new Error(`${key}: must be a JSON ${prop.type}`);
  return parsed;
}
