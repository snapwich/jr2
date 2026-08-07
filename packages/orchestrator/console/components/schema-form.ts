// The shared form (start-run + gate delivery — ADR-0033): one component for both writes the
// Console makes. A flat object schema becomes typed inputs (string/number/boolean/enum, required
// marked), no schema becomes a raw JSON textarea. `onSubmit` resolves to an error string to render
// inline (the server's 400 names the accepted shape — that text IS the form's error display) or null when the write
// landed. The inputs are UNCONTROLLED: what the reader is typing is theirs, not state, and the
// vdom's keyed diff keeps the elements — and so the half-typed text — alive across status frames.

import { h, type JSX } from "preact";
import { useState } from "preact/hooks";

/** One property of a flat object schema, as far as the form reads it. */
type SchemaProp = { type?: string; enum?: unknown[]; description?: string };

/** The schema's `properties`, or null when there is no schema to generate from (→ raw textarea). */
function propsOf(schema: unknown): Record<string, SchemaProp> | null {
  if (!schema || typeof schema !== "object") return null;
  return (schema as { properties?: Record<string, SchemaProp> }).properties ?? {};
}

function requiredOf(schema: unknown): Set<unknown> {
  const required = (schema as { required?: unknown } | null)?.required;
  return new Set(Array.isArray(required) ? required : []);
}

export function SchemaForm(props: {
  schema: unknown;
  submitLabel: string;
  onSubmit: (body: Record<string, unknown>) => Promise<string | null>;
}): JSX.Element {
  const { schema, submitLabel, onSubmit } = props;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const properties = propsOf(schema);
  const required = requiredOf(schema);

  const submit = (e: Event): void => {
    e.preventDefault();
    setError(null);
    let body: Record<string, unknown>;
    try {
      body = collect(e.currentTarget as HTMLFormElement, properties);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : String(ex));
      return;
    }
    setBusy(true);
    void onSubmit(body)
      .catch((ex: unknown) => String(ex))
      .then((failure) => {
        setBusy(false);
        if (failure) setError(failure); // the server's 400 body, inline where the reader typed
      });
  };

  return h(
    "form",
    { class: "schema-form", onSubmit: submit },
    properties === null
      ? h("textarea", { placeholder: "{ }  — raw JSON: this workflow declares no input schema", rows: 3 })
      : Object.entries(properties).map(([key, prop]) => field(key, prop, required)),
    h("button", { type: "submit", disabled: busy }, submitLabel),
    h("div", { class: "form-error", hidden: error === null }, error ?? ""),
  );
}

function field(key: string, prop: SchemaProp, required: Set<unknown>): JSX.Element {
  let input: JSX.Element;
  if (Array.isArray(prop.enum)) {
    // Options carry the value's INDEX, not its string: a numeric enum must round-trip as a
    // number or the server 400s a form no input could ever satisfy. An optional enum gets an
    // "(omit)" first option — a <select> always holds something, so absence needs a row.
    input = h(
      "select",
      { name: key },
      ...(required.has(key) ? [] : [h("option", { value: "" }, "(omit)")]),
      ...prop.enum.map((v, i) => h("option", { value: String(i) }, typeof v === "string" ? v : JSON.stringify(v))),
    );
  } else if (prop.type === "boolean") {
    // A checkbox always answers (unchecked reads as false), which would override a server
    // default the schema marked optional — an optional boolean must be OMISSIBLE.
    input = required.has(key)
      ? h("input", { name: key, type: "checkbox" })
      : h(
          "select",
          { name: key },
          h("option", { value: "" }, "(omit)"),
          h("option", { value: "true" }, "true"),
          h("option", { value: "false" }, "false"),
        );
  } else if (prop.type === "number" || prop.type === "integer") {
    input = h("input", { name: key, type: "number", step: "any" });
  } else {
    input = h("input", { name: key, type: "text" });
  }
  return h("label", { key, title: prop.description }, h("span", null, required.has(key) ? `${key} *` : key), input);
}

/** The submit body, read back off the DOM the fields live in. Typed fields: empty optional inputs
 *  are ABSENT, not "" — the server's schema is the authority on required-ness and says so in its
 *  400. The raw textarea must parse to an object. */
function collect(form: HTMLFormElement, properties: Record<string, SchemaProp> | null): Record<string, unknown> {
  if (properties === null) {
    const text = (form.querySelector("textarea")?.value ?? "").trim();
    if (!text) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("not valid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }
  const body: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    const el = form.elements.namedItem(key);
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      body[key] = el.checked; // a required boolean: always an answer, by design
      continue;
    }
    const value = el.value;
    if (value === "") continue;
    if (Array.isArray(prop.enum)) {
      body[key] = prop.enum[Number(value)]; // the option held the index — the VALUE keeps its type
      continue;
    }
    if (prop.type === "boolean") {
      body[key] = value === "true"; // the optional-boolean select
      continue;
    }
    body[key] = prop.type === "number" || prop.type === "integer" ? Number(value) : value;
  }
  return body;
}
