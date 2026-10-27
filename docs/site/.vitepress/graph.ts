// `::: graph @/examples/<file>.ts` (docs/site/README.md "Graphs"): the graph of the Machine that the
// example exports, as the Console draws it. build/machine-doc.ts reads the Machine; the theme's
// MachineGraph lays it out with elk, in the browser, when the reader opens it. After a set of
// tabs, it is a tab of that set; the bundle shows nothing for it, since the code is there.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MarkdownRenderer } from "vitepress";
import { GRAPH_OPEN } from "../build/vitepress.ts";

type State = {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount: number[];
  blkIndent: number;
  line: number;
  env: { includes?: string[] };
  push(type: string, tag: string, nesting: -1 | 0 | 1): { content: string; map: [number, number] | null };
};

const SITE = fileURLToPath(new URL("..", import.meta.url));

const lineOf = (state: State, n: number) => state.src.slice(state.bMarks[n]! + state.tShift[n]!, state.eMarks[n]);

/** The block rule: `::: graph @/examples/<file>.ts` to the line of as many colons, as the
 * MachineGraph of that file's Machine. */
function graphBlock(state: State, start: number, end: number, silent: boolean): boolean {
  if (state.sCount[start]! - state.blkIndent >= 4) return false;
  const m = GRAPH_OPEN.exec(lineOf(state, start).trimEnd());
  if (!m) return false;
  if (silent) return true;
  let close = start + 1;
  while (close < end && lineOf(state, close).trimEnd() !== m[1]) close++;
  const file = join(SITE, m[2]!);
  // The dev server renders the page again when the example changes, as for a `<<<`.
  state.env.includes?.push(file);
  const doc = execFileSync(process.execPath, [join(SITE, "build/machine-doc.ts"), file], { encoding: "utf8" });
  const token = state.push("html_block", "", 0);
  token.content = `<MachineGraph doc="${encodeURIComponent(doc)}" />\n`;
  token.map = [start, close];
  state.line = close + 1;
  return true;
}

/** The graph rule, on the site's renderer. */
export function graphPlugin(md: MarkdownRenderer): void {
  md.block.ruler.before("fence", "jr2_graph", graphBlock as never, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
}
