// The link rules of the bundle (ADR-0072). A file of the bundle is read in node_modules, offline,
// and on the site, so every relative link in it must land on a file of the bundle:
//
//   - a link to a file in the docs set becomes that file's bundle path, relative to the linking
//     file: docs/adr/X.md is reference/decisions/X.md, GLOSSARY.md is reference/glossary.md, and a
//     docs/site page is its slug. The anchor is kept, and one into the Glossary or the Reference
//     must exist there;
//   - a link to any other repo file becomes a GitHub URL at the release tag, `v<version>`;
//   - a link that resolves to nothing fails the build, with its file and line.
//
// An absolute URL passes unchecked. A link to a page that --partial skipped becomes its text: the
// bundle holds no such file, so a link there would be broken.

import { existsSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { proseLines, type BuildError } from "./markdown.ts";

export const GITHUB = "https://github.com/snapwich/jr2";

/** The docs set as the link rules see it. Paths are POSIX, repo-relative for a source and
 * bundle-relative for a bundle file. */
export type DocsSet = {
  /** The Kit version: links out of the set point at its tag, `v<version>`. */
  version: string;
  /** The repo root on disk. */
  repo: string;
  /** The bundle path of each source file in the set: GLOSSARY.md, each ADR. */
  aliases: ReadonlyMap<string, string>;
  /** Every bundle path the build writes. */
  bundle: ReadonlySet<string>;
  /** The sitemap pages that --partial skipped: a link to one becomes its text, and is not
   * checked. */
  skipped: ReadonlySet<string>;
  /** The anchors of each bundle file whose anchors a link must hit: the Glossary and the
   * Reference. A file not here is not checked for anchors. */
  anchors: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Where a link's target sits: its own bundle file, a repo path out of the set, or nowhere. */
type Target = { bundle: string } | { repo: string; dir: boolean } | { missing: string };

/** The bundle path a repo path stands for, if it is in the docs set: an alias, or a docs/site
 * path that is a bundle file (a page, or a generated page linked as if it were in docs/site). */
export function bundlePathOf(repoPath: string, set: DocsSet): string | undefined {
  const alias = set.aliases.get(repoPath);
  if (alias) return alias;
  if (repoPath.startsWith("docs/site/")) {
    const rest = repoPath.slice("docs/site/".length);
    if (set.bundle.has(rest) || set.skipped.has(rest)) return rest;
    // A generated page linked from docs/site (`../reference/decisions/X.md`) is the bundle's too.
    const adr = /^reference\/decisions\/([^/]+)$/.exec(rest);
    if (adr && set.aliases.get(`docs/adr/${adr[1]}`)) return rest;
  }
  return undefined;
}

function resolve(path: string, from: string, set: DocsSet): Target {
  const repoPath = posix.normalize(posix.join(posix.dirname(from), path));
  if (repoPath.startsWith("../") || repoPath === "..") return { missing: repoPath };
  const bundle = bundlePathOf(repoPath, set);
  if (bundle) return { bundle };
  const disk = join(set.repo, repoPath);
  if (existsSync(disk)) return { repo: repoPath, dir: statSync(disk).isDirectory() };
  return { missing: repoPath };
}

/** The href a link to `target` (a bundle path) has in the bundle file `from`. */
export function relativeHref(from: string, target: string): string {
  const rel = posix.relative(posix.dirname(from), target);
  return rel === "" ? posix.basename(target) : rel;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export type LinkSource = {
  /** The path the file's relative links resolve against: the source file's repo path, or for a
   * generated page, `docs/site/<its bundle path>`. */
  from: string;
  /** The file's bundle path. */
  bundle: string;
  /** The name an error gives the file, and the line its text starts at. */
  file: string;
  firstLine?: number;
};

/** One href made a bundle href, or an error message, or `skipped` for a page that --partial
 * skipped. */
export function rewriteHref(
  href: string,
  src: LinkSource,
  set: DocsSet,
): string | { error: string } | { skipped: string } {
  if (SCHEME.test(href)) return href;
  const hash = href.indexOf("#");
  const path = hash < 0 ? href : href.slice(0, hash);
  const frag = hash < 0 ? "" : href.slice(hash + 1);
  if (path === "") return checkAnchor(src.bundle, frag, set) ?? href;
  if (path.startsWith("/")) return { error: `the link ${href} is root-absolute; write a relative path` };
  let decoded: string;
  try {
    decoded = decodeURI(path);
  } catch {
    return { error: `the link ${href} is not a valid URL` };
  }
  const t = resolve(decoded, src.from, set);
  if ("missing" in t) return { error: `the link ${href} resolves to ${t.missing}, which does not exist` };
  if ("repo" in t) return `${GITHUB}/${t.dir ? "tree" : "blob"}/v${set.version}/${t.repo}${hash < 0 ? "" : `#${frag}`}`;
  if (set.skipped.has(t.bundle)) return { skipped: t.bundle };
  if (frag !== "") {
    const bad = checkAnchor(t.bundle, frag, set);
    if (typeof bad === "object") return bad;
  }
  return relativeHref(src.bundle, t.bundle) + (hash < 0 ? "" : `#${frag}`);
}

function checkAnchor(bundle: string, frag: string, set: DocsSet): { error: string } | undefined {
  if (frag === "" || set.skipped.has(bundle)) return undefined;
  const anchors = set.anchors.get(bundle);
  if (anchors && !anchors.has(frag)) return { error: `the anchor #${frag} is not in ${bundle}` };
  return undefined;
}

/** An inline link's or image's `](href "title")`, and a reference definition's `[x]: href`. */
const INLINE = /\]\(\s*(<[^>]*>|[^\s()]*)(\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
// A footnote definition (`[^1]: text`) is not a link.
const DEFINITION = /^( {0,3}\[(?!\^)[^\]]+\]:\s*)(\S+)/;

// What stands for the `](href)` of a link to a skipped page until the label's `[` is found: a
// label can wrap over lines. No Markdown text holds these characters.
const DROP = "\u0000drop\u0000";

/** Every link in a file made a bundle link. Code — a fence or an inline span — is not touched. */
export function rewriteLinks(text: string, src: LinkSource, set: DocsSet): { text: string; errors: BuildError[] } {
  const lines = text.split("\n");
  const prose = proseLines(lines);
  const errors: BuildError[] = [];
  const first = src.firstLine ?? 1;
  let dropped = false;
  const out = lines.flatMap((line, i): string[] => {
    const masked = prose[i];
    if (masked === undefined) return [line];
    const fix = (href: string): string | undefined => {
      const r = rewriteHref(href, src, set);
      if (typeof r === "string") return r;
      if ("skipped" in r) return undefined;
      errors.push({ file: src.file, line: first + i, message: r.error });
      return href;
    };
    // Matched on the masked line, so a link inside code is no match. Outside code the masked line
    // is the line itself, so each match is the real text.
    const def = DEFINITION.exec(masked);
    if (def) {
      const href = fix(def[2]!);
      // A definition of a skipped page goes; a reference to it is then text.
      return href === undefined ? [] : [def[1] + href + line.slice(def[0].length)];
    }
    let result = "";
    let at = 0;
    for (const m of masked.matchAll(INLINE)) {
      const [whole, raw = "", title = ""] = m;
      const bracketed = raw.startsWith("<");
      const href = bracketed ? raw.slice(1, -1) : raw;
      const fixed = href === "" ? whole : fix(href);
      if (fixed === undefined) dropped = true;
      const written =
        fixed === undefined ? DROP : href === "" ? whole : `](${bracketed ? `<${fixed}>` : fixed}${title})`;
      result += line.slice(at, m.index) + written;
      at = m.index + whole.length;
    }
    return [result + line.slice(at)];
  });
  const joined = out.join("\n");
  return { text: dropped ? unlinkDropped(joined) : joined, errors };
}

/** Each link marked {@link DROP} made its label: the `[` that opens the label goes, and an image's
 * `!` with it. The label is the text back to the `[` that balances its brackets. */
function unlinkDropped(text: string): string {
  let out = text;
  for (let at = out.indexOf(DROP); at >= 0; at = out.indexOf(DROP)) {
    let depth = 0;
    let open = -1;
    for (let i = at - 1; i >= 0; i--) {
      if (out[i] === "]") depth++;
      else if (out[i] === "[" && depth-- === 0) {
        open = i;
        break;
      }
    }
    const start = open > 0 && out[open - 1] === "!" ? open - 1 : open;
    out =
      open < 0
        ? out.slice(0, at) + out.slice(at + DROP.length)
        : out.slice(0, start) + out.slice(open + 1, at) + out.slice(at + DROP.length);
  }
  return out;
}
