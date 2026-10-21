// A dispatch's slot schema against its callee's door (ADR-0071): the comparison `jr2 up` and the
// publish door make before any run starts. A match is COMPATIBILITY, one direction: every field the
// door requires is one the slot's schema always sends, with a compatible type, values and bounds,
// and every field of the slot's schema is in the door, since a plain zod door strips the rest
// silently. Equality is not asked: a slot may narrow what the door takes, never widen it.
//
// It compares within the JSON Schema subset ADR-0070 names (`PAYLOAD_KEYWORDS`, chart.ts). A schema
// that uses anything outside it (`oneOf`, `$ref`, `pattern`, `format`) is "not compared", never
// guessed at: a guess that says "ok" hides the mismatch it was asked for, and one that says
// "mismatch" refuses a publish that would run.
//
// Pure, and over two JSON Schemas only: the slot's is `z.toJSONSchema(input, { io: "output" })`
// (what the driver sends, its defaults filled), the door's is what `GET /workflows/<name>` serves (run-host.ts `inputSchema`), so a foreign door
// at another Kit version is compared by the same rules as this Assembly's own.

import { doorSchemaFaults } from "./chart.ts";

/** The comparison's answer: compatible; the faults that make it not, each naming the field; or not
 * compared, with why. */
export type DoorCompat = { ok: true } | { ok: false; faults: string[] } | { ok: "not-compared"; why: string };

type Schema = Record<string, unknown>;

/**
 * Is a slot's input schema compatible with a door (ADR-0071)? `door` null is a door that declares
 * no input (a run of it starts with anything): every slot is compatible with it.
 */
export function doorCompat(slot: unknown, door: unknown): DoorCompat {
  if (door === null) return { ok: true };
  slot = withoutDefaults(slot);
  door = withoutDefaults(door);
  for (const [whose, schema] of [
    ["the slot's input schema", slot],
    ["the door", door],
  ] as const) {
    const fault = doorSchemaFaults(schema)[0];
    if (fault) {
      const at = fault.path.length ? `${fault.path.map(String).join(".")}: ` : "";
      return { ok: "not-compared", why: `${whose} is outside the subset jr2 compares — ${at}${fault.message}` };
    }
  }
  const faults: string[] = [];
  compareValue(slot as Schema, door as Schema, "", faults);
  return faults.length ? { ok: false, faults } : { ok: true };
}

/** Compare two object schemas at `at` (a field path, "" at the root), one direction. */
function compareObject(slot: Schema, door: Schema, at: string, faults: string[]): void {
  const slotProps = propsOf(slot);
  const doorProps = propsOf(door);
  const required = Array.isArray(door.required) ? (door.required as unknown[]).map(String) : [];
  const sent = new Set(Array.isArray(slot.required) ? (slot.required as unknown[]).map(String) : []);
  for (const field of required) {
    if (slotProps[field] === undefined) {
      faults.push(`the door requires "${join(at, field)}", which the slot's input schema does not have`);
    } else if (!sent.has(field)) {
      // The slot's schema is what the driver sends after its parse (`io: "output"`), so a
      // defaulted field is required there: optional means a body may leave it out.
      faults.push(`the door requires "${join(at, field)}", which the slot's input schema leaves optional`);
    }
  }
  // Every field both have is compared, the door's required ones among them.
  const extra = door.additionalProperties;
  for (const [field, sub] of Object.entries(slotProps)) {
    const name = join(at, field);
    const theirs = doorProps[field];
    if (theirs !== undefined) {
      compareValue(sub, theirs, name, faults);
      continue;
    }
    // A door that takes any field (`additionalProperties: {}` or `true`) keeps the slot's extra one;
    // a catchall door (`additionalProperties: <schema>`) keeps it when its value fits.
    if (isOpen(extra)) continue;
    if (isSchema(extra)) {
      compareValue(sub, extra, name, faults);
      continue;
    }
    faults.push(
      extra === false
        ? `the slot's field "${name}" is not in the door, which refuses it`
        : `the slot's field "${name}" is not in the door, which strips it silently`,
    );
  }
}

/** Compare one field's schemas: the type, the values an `enum` or a `const` allows, the bounds,
 * then `items` and nested `properties`, by the same rules. A door node that states none of these
 * takes any value (`z.unknown()`, `z.any()`), and every slot is compatible with it. */
function compareValue(slot: Schema, door: Schema, at: string, faults: string[]): void {
  const theirs = typesOf(door);
  const ours = typesOf(slot);
  if (theirs !== undefined) {
    if (ours === undefined) {
      faults.push(`${label(at)}: the door takes ${theirs.join(" or ")}, and the slot's input schema takes any value`);
      return;
    }
    const outside = ours.filter((t) => !theirs.includes(t) && !(t === "integer" && theirs.includes("number")));
    if (outside.length) {
      faults.push(`${label(at)}: the slot sends ${ours.join(" or ")}, and the door takes ${theirs.join(" or ")}`);
      return;
    }
  }
  const allowed = valuesOf(door);
  const sent = valuesOf(slot);
  if (allowed !== undefined) {
    const list = allowed.map((v) => JSON.stringify(v)).join(", ");
    if (sent === undefined) {
      faults.push(`${label(at)}: the door takes only ${list}, and the slot's input schema does not narrow to them`);
    } else {
      const extra = sent.filter((v) => !allowed.some((a) => same(a, v)));
      if (extra.length) {
        faults.push(
          `${label(at)}: the slot may send ${extra.map((v) => JSON.stringify(v)).join(", ")}, which the door does ` +
            `not take (it takes ${list})`,
        );
      }
    }
  }
  compareBounds(slot, door, at, faults);
  const may = (type: string): boolean => ours === undefined || ours.includes(type);
  if (isSchema(door.items) && !isOpen(door.items) && may("array")) {
    compareValue(isSchema(slot.items) ? slot.items : {}, door.items, `${at}[]`, faults);
  }
  const objectDoor =
    isSchema(door.properties) || (theirs?.includes("object") ?? false) || door.additionalProperties !== undefined;
  if (objectDoor && may("object")) compareObject(slot, door, at, faults);
}

/** The bounds, one direction: the slot's range lies inside the door's, so a bound the door sets
 * and the slot does not is a fault, as is a slot bound wider than the door's. */
function compareBounds(slot: Schema, door: Schema, at: string, faults: string[]): void {
  const pairs: Array<[string, string | undefined, "lower" | "upper"]> = [
    ["minimum", "exclusiveMinimum", "lower"],
    ["maximum", "exclusiveMaximum", "upper"],
    ["minLength", undefined, "lower"],
    ["maxLength", undefined, "upper"],
    ["minItems", undefined, "lower"],
    ["maxItems", undefined, "upper"],
  ];
  for (const [inclusive, exclusive, side] of pairs) {
    const theirs = boundOf(door, inclusive, exclusive);
    if (theirs === undefined) continue;
    const ours = boundOf(slot, inclusive, exclusive);
    const fits =
      ours !== undefined &&
      (side === "lower"
        ? ours.value > theirs.value || (ours.value === theirs.value && (ours.exclusive || !theirs.exclusive))
        : ours.value < theirs.value || (ours.value === theirs.value && (ours.exclusive || !theirs.exclusive)));
    if (fits) continue;
    faults.push(
      `${label(at)}: the door takes ${theirs.keyword} ${theirs.value}, and the slot's input schema ` +
        (ours === undefined ? "sets no such bound" : `allows ${ours.keyword} ${ours.value}`),
    );
  }
}

type Bound = { value: number; exclusive: boolean; keyword: string };

/** A schema's bound on one side: the tighter of its inclusive and exclusive keyword, if any. */
function boundOf(schema: Schema, inclusive: string, exclusive: string | undefined): Bound | undefined {
  const inc = typeof schema[inclusive] === "number" ? (schema[inclusive] as number) : undefined;
  const exc =
    exclusive !== undefined && typeof schema[exclusive] === "number" ? (schema[exclusive] as number) : undefined;
  if (inc === undefined && exc === undefined) return undefined;
  if (exc === undefined) return { value: inc!, exclusive: false, keyword: inclusive };
  if (inc === undefined) return { value: exc, exclusive: true, keyword: exclusive! };
  const lowerSide = inclusive.startsWith("min");
  const excTighter = lowerSide ? exc >= inc : exc <= inc;
  return excTighter
    ? { value: exc, exclusive: true, keyword: exclusive! }
    : { value: inc, exclusive: false, keyword: inclusive };
}

function propsOf(schema: Schema): Record<string, Schema> {
  const props = schema.properties;
  if (!isSchema(props)) return {};
  return Object.fromEntries(Object.entries(props).filter(([, v]) => isSchema(v))) as Record<string, Schema>;
}

/** A schema's types, as a list; undefined when it states none (any value). */
function typesOf(schema: Schema): string[] | undefined {
  const t = schema.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.map(String);
  return undefined;
}

/** The values a schema allows by `enum` or `const`; undefined when it lists none. */
function valuesOf(schema: Schema): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum as unknown[];
  if (Object.hasOwn(schema, "const")) return [schema.const];
  return undefined;
}

/**
 * The schema without its `default`s, at every depth. A default is an annotation: it changes no
 * value a schema takes (a defaulted field is already optional in `io: "input"`), so leaving it out
 * guesses nothing, and a door with a defaulted field — common — is compared, not skipped.
 */
function withoutDefaults(schema: unknown): unknown {
  if (!isSchema(schema)) return schema;
  const { default: _default, ...rest } = schema;
  const out: Schema = { ...rest };
  // Schema nodes only: a field NAMED "default" under `properties` stays.
  if (isSchema(rest.properties)) {
    out.properties = Object.fromEntries(Object.entries(rest.properties).map(([k, v]) => [k, withoutDefaults(v)]));
  }
  if (rest.items !== undefined) out.items = withoutDefaults(rest.items);
  if (rest.additionalProperties !== undefined) out.additionalProperties = withoutDefaults(rest.additionalProperties);
  return out;
}

const isSchema = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const isOpen = (v: unknown): boolean => v === true || (isSchema(v) && Object.keys(v).length === 0);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const join = (at: string, field: string): string => (at ? `${at}.${field}` : field);
const label = (at: string): string => (at ? `"${at}"` : "the body");
