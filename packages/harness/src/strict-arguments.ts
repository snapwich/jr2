// The arguments of a Menu pick and of an MCP tool call, checked as the model wrote them (ADR-0027).
//
// pi-ai validates each tool call with pi-schema and COERCES the arguments to the schema first
// (`compile({ coerce: true })`): `null` for a required string becomes `"null"`, `3.5` for an
// integer becomes `3`, one value for an array becomes `[value]`, `"42"` for a number becomes `42`.
// For a Door or a Chart (a Menu pick) and for an MCP tool, jr2 refuses that: the Machine and the
// MCP server get the arguments the model wrote, or the model gets a refusal that it can correct
// from. A converted value is a silent change of data, the printed conversation (ADR-0023) shows
// what the model wrote, and the Chart's refuse-then-fix loop (ADR-0070) is what the `chart-refusal`
// claim measures. The Working tools are pi's own, and keep pi's coercion.
//
// The check runs in the tool's `prepareArguments`, which pi calls before its own validation. A
// value that passes here passes pi's validation unchanged: pi-schema converts only a value that
// does not already fit the schema. The refusal is in pi's own words, so the model reads one shape
// of refusal for every tool.
//
// One exception: empty arguments (`{}`) that pi's validation refuses too go on to pi as they are.
// pi-ai makes argument text that does not parse into `{}`, with the parse error and the text beside
// it (`argumentsError`), and `prepareArguments` gets the `{}` alone. pi's validation says that
// error first, with the text the model wrote. A refusal here would tell the model that each field
// is missing, which is not its fault. pi converts nothing in `{}` that it then refuses, so no
// value changes.

import { compile, type Validator } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";

/** A pi-schema error path (a JSON Pointer) as pi-ai shows it to the model: `/edits/0/x` → `edits.0.x`. */
function shownPath(pointer: string): string {
  if (pointer === "") return "root";
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}

/** A plain object with no key: what pi-ai gives for argument text that does not parse. */
function isEmptyObject(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    !Array.isArray(args) &&
    Object.getPrototypeOf(args) === Object.prototype &&
    Object.keys(args).length === 0
  );
}

/**
 * A `prepareArguments` for the tool `name` with the JSON Schema `schema`: the arguments come back
 * unchanged when they fit the schema as they are, and it throws pi-ai's validation text when they
 * do not. Empty arguments that pi's validation refuses too come back unchanged, so pi says why
 * (the parse error of malformed argument text, or the missing fields). The schema is compiled at the first call, with pi-ai's options except the coercion.
 */
export function strictArguments(name: string, schema: unknown): (args: unknown) => never {
  let validator: Validator | undefined;
  let coercing: Validator | undefined;
  return ((args: unknown) => {
    validator ??= compile(schema as object, { formats, unresolvedRefs: "reject" });
    if (validator.check(args)) return args;
    if (isEmptyObject(args)) {
      // pi-ai's own options: what pi's validation does with `{}`.
      coercing ??= compile(schema as object, { formats, coerce: true, unresolvedRefs: "reject" });
      if (!coercing.parse({}).ok) return args;
    }
    const errors = validator
      .errors(args)
      .map((error) => `  - ${shownPath(error.path)}: ${error.message}`)
      .join("\n");
    throw new Error(
      `Validation failed for tool "${name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`,
    );
  }) as (args: unknown) => never;
}
