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

/**
 * A `prepareArguments` for the tool `name` with the JSON Schema `schema`: the arguments come back
 * unchanged when they fit the schema as they are, and it throws pi-ai's validation text when they
 * do not. The schema is compiled at the first call, with pi-ai's options except the coercion.
 */
export function strictArguments(name: string, schema: unknown): (args: unknown) => never {
  let validator: Validator | undefined;
  return ((args: unknown) => {
    validator ??= compile(schema as object, { formats, unresolvedRefs: "reject" });
    if (validator.check(args)) return args;
    const errors = validator
      .errors(args)
      .map((error) => `  - ${shownPath(error.path)}: ${error.message}`)
      .join("\n");
    throw new Error(
      `Validation failed for tool "${name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`,
    );
  }) as (args: unknown) => never;
}
