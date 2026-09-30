// The endpoint profile the @model tier runs against (ADR-0066), read from `model-endpoint.json`
// at the instance root — a file the fixture MATERIALIZES from `features/model-endpoints/<name>.json`
// before every converge (World.setupModel), gitignored, and shipped in the instance image by the
// package's `files:` list. Read here, at load, rather than from env: an env read in a definition
// is `undefined` in the pod (the kind config says why), and the in-cluster Orchestrator must see
// exactly the values the host's `jr2 up` did.
//
// Read at load rather than imported: a static JSON import would make `pnpm typecheck` depend on a
// gitignored file. The error names the recipe, because the only way this file is missing is
// running the instance outside the tier.
//
// `_`-prefixed, so workflow discovery skips it: this module is imported, never registered.

import { readFileSync } from "node:fs";
import type { ThinkingLevel } from "@jr2/orchestrator";

/** The tier's two thinking cells, as the scenarios name them. */
export type ThinkingCell = "off" | "on";

export type EndpointProfile = {
  /** The provider id model specifiers use — `<id>/<model>` (ADR-0018). */
  id: string;
  /** The wire protocol pi registers the provider under (`openai-completions`, `anthropic-messages`). */
  api: string;
  /** Reachable FROM PODS. `https://` whenever a key is set (ADR-0059). */
  baseUrl: string;
  /** The model id AFTER the provider prefix — exactly what the endpoint serves. */
  model: string;
  contextWindow?: number;
  maxTokens?: number;
  /** A private CA for the endpoint, as a path relative to the instance folder (ADR-0020). */
  caBundle?: string;
  /** The Dial each cell sets (ADR-0018). Absent cell → the definition's own value. */
  thinking?: Partial<Record<ThinkingCell, ThinkingLevel>>;
  /** Trials per claim cell, and how many runs a claim keeps in flight. */
  trials?: number;
  parallel?: number;
};

export const profile: EndpointProfile = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../model-endpoint.json", import.meta.url), "utf8")) as EndpointProfile;
  } catch (err) {
    throw new Error(
      `model-endpoint.json is not beside this instance — the @model fixture writes it from ` +
        `features/model-endpoints/<name>.json (JR2_MODEL_ENDPOINT); run the tier with \`just e2e-model\` ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
})();

/** The model specifier every definition here names. */
export const MODEL = `${profile.id}/${profile.model}`;

/** The Dial for one cell — spread into a Turn's input, so an unmapped cell sets nothing. */
export function dialFor(cell: ThinkingCell): { thinkingLevel?: ThinkingLevel } {
  const level = profile.thinking?.[cell];
  return level === undefined ? {} : { thinkingLevel: level };
}
