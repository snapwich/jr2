// The site's diagrams (docs/site/README.md "Diagrams"): `::: diagram <layout> [title]` holds one
// list, and the site draws the list. The bundle keeps the list as it is (build/vitepress.ts), so the
// list is the diagram's text, and the two cannot say different things.
//
//   layers  a bullet list. Each item is a band: `**Name**: what it does`, with the parts it holds
//           as its children, and a part with parts in it is a group. An item that starts with an
//           arrow (↓ ↑) is the link between two bands; ` · ` puts two labels on one link, and a
//           label `From → To[: label]` is a line from a part to a part, or between a part and a band.
//           An item that holds bands and the links between them is a bracket around those bands. A part whose
//           text has ` → ` is a Machine: its states in a row, and its transitions as its items.
//   steps   an ordered list: each item is a step, `**What happens.** More text`.
//
// A diagram groups more than it wires: a line from a part to a part is for the point that a
// particular part does a thing (README "When to draw a diagram").

import type { MarkdownRenderer } from "vitepress";
import { DIAGRAM_LAYOUTS } from "../build/vitepress.ts";

type Token = {
  type: string;
  tag: string;
  content: string;
  children: Token[] | null;
  info: string;
  map: [number, number] | null;
  attrSet(name: string, value: string): void;
};
type State = {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount: number[];
  blkIndent: number;
  line: number;
  lineMax: number;
  parentType: string;
  md: { block: { tokenize(state: State, start: number, end: number): void } };
  push(type: string, tag: string, nesting: -1 | 0 | 1): Token;
};
type TokenOf = new (type: string, tag: string, nesting: -1 | 0 | 1) => Token;

const OPEN = /^(:{3,}) diagram (\S+)(?: (\S.*))?$/;
const ARROW = /^[↓↑]/;

const lineOf = (state: State, n: number) => state.src.slice(state.bMarks[n]! + state.tShift[n]!, state.eMarks[n]);

/** The block rule: `::: diagram <layout> [title]` to the line of as many colons, as a
 * `diagram_open` and a `diagram_close` around the tokens of what it holds. */
function diagramBlock(state: State, start: number, end: number, silent: boolean): boolean {
  if (state.sCount[start]! - state.blkIndent >= 4) return false;
  const m = OPEN.exec(lineOf(state, start).trimEnd());
  if (!m || !(DIAGRAM_LAYOUTS as readonly string[]).includes(m[2]!)) return false;
  if (silent) return true;
  let close = start + 1;
  while (close < end && lineOf(state, close).trimEnd() !== m[1]) close++;
  const parent = state.parentType;
  const lineMax = state.lineMax;
  state.parentType = "container";
  state.lineMax = close;
  const open = state.push("diagram_open", "figure", 1);
  open.info = m[2]!;
  open.content = m[3] ?? "";
  open.map = [start, close];
  state.md.block.tokenize(state, start + 1, close);
  state.push("diagram_close", "figure", -1);
  state.parentType = parent;
  state.lineMax = lineMax;
  state.line = close + 1;
  return true;
}

type Item = { inline?: Token; children: Item[] };

/** The items of the list that opens at `tokens[i]`, and the index after its close. */
function listAt(tokens: Token[], i: number): [Item[], number] {
  const items: Item[] = [];
  i++;
  while (!tokens[i]!.type.endsWith("_list_close")) {
    const item: Item = { children: [] };
    i++; // list_item_open
    while (tokens[i]!.type !== "list_item_close") {
      const t = tokens[i]!;
      if (t.type.endsWith("_list_open")) {
        [item.children, i] = listAt(tokens, i);
        continue;
      }
      if (t.type === "inline" && !item.inline) item.inline = t;
      i++;
    }
    items.push(item);
    i++;
  }
  return [items, i + 1];
}

/** A percentage for a style, to two places. */
const pct = (x: number) => `${Number(x.toFixed(2))}%`;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The plain text of inline `children`, to match a part or a state by its name. */
const plain = (children: Token[]) =>
  children
    .map((c) => (c.type === "text" || c.type === "code_inline" ? c.content : ""))
    .join("")
    .trim();

/** A link from a part to a part: `From → To`, the two parts named as they are in the diagram, and
 * the text after `: ` as its label, if it has one. */
export type Wire = { from: string; to: string; label?: string };

/** The tokens of a diagram, drawn: `figure` holds the layout, and the title is its caption. */
function draw(layout: string, title: string, inner: Token[], Tok: TokenOf): Token[] {
  const out: Token[] = [];
  const html = (content: string) => out.push(Object.assign(new Tok("html_block", "", 0), { content }));
  const inline = (children: Token[]) =>
    out.push(Object.assign(new Tok("inline", "", 0), { children, content: children.map((c) => c.content).join("") }));
  const text = (content: string) => Object.assign(new Tok("text", "", 0), { content });

  /** `children` cut at each `sep` in its text. */
  const cut = (children: Token[], sep: string): Token[][] => {
    const parts: Token[][] = [[]];
    for (const c of children) {
      if (c.type !== "text" || !c.content.includes(sep)) {
        parts.at(-1)!.push(c);
        continue;
      }
      c.content.split(sep).forEach((piece, k) => {
        if (k > 0) parts.push([]);
        if (piece !== "") parts.at(-1)!.push(text(piece));
      });
    }
    return parts.filter((p) => p.some((t) => t.type !== "text" || t.content.trim() !== ""));
  };
  // markdown-it starts an inline that opens with a tag with an empty text token.
  const tokensOf = (item: Item) =>
    (item.inline?.children ?? []).filter((t) => !(t.type === "text" && t.content === ""));
  /** `tokens` with `lead` taken off the start of its first text. */
  const strip = (tokens: Token[], lead: RegExp) =>
    tokens[0]?.type === "text" ? [text(tokens[0].content.replace(lead, "")), ...tokens.slice(1)] : tokens;
  const bold = (tokens: Token[]) =>
    tokens[0]?.type === "strong_open" && tokens.at(-1)?.type === "strong_close" ? tokens.slice(1, -1) : undefined;

  /** A Machine: its states in a row, in the order of the flow. `●` before the first state marks it
   * the initial state, `◉` marks a final state, and a bold state is the state that the run is in.
   * Each item in the part is a transition, `from → to: event`: to the next state it labels the
   * arrow, and to any other state it is a loop under the row. */
  const machine = (steps: Token[][], edges: Item[]) => {
    const initial = plain(steps[0] ?? []) === "●";
    if (initial) steps = steps.slice(1);
    const states = steps.map((seg) => {
      const now = bold(seg);
      const name = strip(now ?? seg, /^◉\s*/);
      return { tokens: name, name: plain(name), now: !!now, final: plain(seg).startsWith("◉") };
    });
    const at = (name: string) => states.findIndex((s) => s.name === name);
    const n = states.length;
    const center = (i: number) => ((i + 0.5) / n) * 100;
    const arrows: { after: number; label: Token[] }[] = [];
    const loops: { from: number; to: number; label: Token[] }[] = [];
    for (const e of edges) {
      const [head, ...label] = cut(tokensOf(e), ": ");
      const [from, to] = cut(head ?? [], " → ").map((t) => at(plain(t)));
      if (from === undefined || to === undefined || from < 0 || to < 0) continue;
      const l = label.flatMap((t, k) => (k ? [text(": "), ...t] : t));
      if (to === from + 1) arrows.push({ after: from, label: l });
      else loops.push({ from, to, label: l });
    }
    loops.sort((x, y) => Math.abs(x.from - x.to) - Math.abs(y.from - y.to));
    html(`<div class="dg-part dg-machine" style="--dg-n: ${n}; --dg-loops: ${loops.length}">`);
    html('<div class="dg-states">');
    states.forEach((st, i) => {
      const cls = ["dg-state", st.now && "dg-now", st.final && "dg-final", i === 0 && initial && "dg-initial"];
      html(`<span class="dg-cell"><span class="${cls.filter(Boolean).join(" ")}" data-name="${escape(st.name)}">`);
      inline(st.tokens);
      html("</span></span>");
    });
    html("</div>");
    for (const a of arrows) {
      html(`<span class="dg-arrow-label" style="left: ${pct(((a.after + 1) / n) * 100)}">`);
      inline(a.label);
      html("</span>");
    }
    loops.forEach((l, depth) => {
      const left = Math.min(center(l.from), center(l.to));
      const width = Math.abs(center(l.from) - center(l.to));
      const side = l.to < l.from ? "dg-loop-back" : "dg-loop-on";
      html(`<span class="dg-loop ${side}" style="left: ${pct(left)}; width: ${pct(width)}; --dg-depth: ${depth}">`);
      html('<span class="dg-loop-label">');
      inline(l.label);
      html("</span></span>");
    });
    html("</div>");
  };

  /** One part: `**Name**: role` or `**Name** (Kind): role`, a name only, a Machine (its text has
   * ` → `), or a group of the parts in it. */
  const part = (item: Item, cls: string) => {
    const c = tokensOf(item);
    const flow = cut(c, " → ");
    if (flow.length > 1 && cls === "dg-part") return machine(flow, item.children);
    const lead = c[0]?.type === "strong_open" ? c.findIndex((t) => t.type === "strong_close") : -1;
    const name = lead < 0 ? c : c.slice(1, lead);
    const after = lead < 0 ? [] : c.slice(lead + 1);
    // `**coder** (Agent): …`: the kind of the part, as a badge, and as a class that the theme can
    // give a colour.
    const kind = after[0]?.type === "text" ? /^\s*\(([^)]+)\)/.exec(after[0].content)?.[1] : undefined;
    const role = strip(after, /^\s*(?:\([^)]+\))?:?\s*/);
    const group = cls === "dg-part" && item.children.length > 0;
    const classes = [cls, group && "dg-group", kind && `dg-kind-${kind.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`];
    html(`<div class="${classes.filter(Boolean).join(" ")}" data-name="${escape(plain(name))}">`);
    html('<span class="dg-name">');
    inline(name);
    if (kind) html(` <span class="dg-kind">${escape(kind)}</span>`);
    html("</span>");
    if (role.some((t) => t.type !== "text" || t.content.trim() !== "")) {
      html('<span class="dg-role">');
      inline(role);
      html("</span>");
    }
    if (group) {
      html('<div class="dg-parts">');
      for (const child of item.children) part(child, "dg-part");
      html("</div>");
    }
    html("</div>");
  };

  html(`<figure class="dg dg-${layout}">`);
  if (layout === "steps") {
    const ol = inner.find((t) => t.type === "ordered_list_open");
    ol?.attrSet("class", "dg-steps-list");
    out.push(...inner);
  } else {
    const at = inner.findIndex((t) => t.type === "bullet_list_open");
    const [items] = at < 0 ? [[]] : listAt(inner, at);
    const isLink = (item: Item) => ARROW.test(item.inline?.content ?? "");
    // An item that holds a link holds bands, not parts: it is a bracket around those bands.
    const isBracket = (item: Item) => item.children.some(isLink);
    const count = (list: Item[]): number =>
      list.reduce((n, i) => n + (isLink(i) ? 0 : isBracket(i) ? count(i.children) : 1), 0);
    const total = count(items);
    let n = 0;
    const layer = (list: Item[]) => {
      for (const band of list) {
        const c = band.inline?.children ?? [];
        if (isLink(band)) {
          const labels = cut(c, " · ");
          // `↓ From → To`: a label that names two parts is a line between them (theme/wires.ts), and
          // any other label is text. The text of the lines stays, for a reader with no script.
          const pairs = labels.map((l) => cut(strip(l, /^[↓↑]\s*/), " → ").map(plain));
          const wired = labels.filter((_, k) => pairs[k]!.length === 2);
          if (wired.length) {
            const list: Wire[] = pairs
              .filter((w) => w.length === 2)
              .map(([from, to]) => {
                const [name, ...label] = to!.split(": ");
                return label.length ? { from: from!, to: name!, label: label.join(": ") } : { from: from!, to: to! };
              });
            html(`<div class="dg-link dg-wires"><DiagramWires wires="${encodeURIComponent(JSON.stringify(list))}" />`);
          } else html('<div class="dg-link">');
          labels.forEach((label, k) => {
            if (pairs[k]!.length === 2) return;
            html('<span class="dg-link-label">');
            inline(label);
            html("</span>");
          });
          if (wired.length) {
            html('<span class="dg-wires-text">');
            inline(wired.length === labels.length ? c : wired.flatMap((l, k) => (k ? [text(" · "), ...l] : l)));
            html("</span>");
          }
          html("</div>");
          continue;
        }
        if (isBracket(band)) {
          html('<div class="dg-bracket">');
          part(band, "dg-bracket-head");
          html('<div class="dg-bracket-body">');
          layer(band.children);
          html("</div></div>");
          continue;
        }
        // Each band has a colour of its own, in the order of the bands, and the last band is grey.
        n++;
        html(`<section class="dg-band dg-tone-${n === total ? "last" : ((n - 1) % 5) + 1}">`);
        part(band, "dg-head");
        if (band.children.length) {
          html('<div class="dg-parts">');
          for (const child of band.children) part(child, "dg-part");
          html("</div>");
        }
        html("</section>");
      }
    };
    layer(items);
  }
  if (title) html(`<figcaption>${escape(title)}</figcaption>`);
  html("</figure>");
  return out;
}

/** The diagram rule and its drawing, on the site's renderer. */
export function diagramPlugin(md: MarkdownRenderer): void {
  md.block.ruler.before("fence", "jr2_diagram", diagramBlock as never, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.core.ruler.push("jr2-diagram", (state) => {
    const tokens = state.tokens as unknown as Token[];
    const out: Token[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.type !== "diagram_open") {
        out.push(t);
        continue;
      }
      let depth = 1;
      let j = i + 1;
      for (; j < tokens.length; j++) {
        if (tokens[j]!.type === "diagram_open") depth++;
        if (tokens[j]!.type === "diagram_close" && --depth === 0) break;
      }
      out.push(...draw(t.info, t.content, tokens.slice(i + 1, j), state.Token as unknown as TokenOf));
      i = j;
    }
    state.tokens = out as never;
  });
}
