// The HTTP API page (ADR-0072), from `HTTP_ROUTES`: the routes grouped by access band, in the order
// the app registers them, and the named types their bodies and answers use, each rendered once from
// its declaration.

import ts from "typescript";
import { HTTP_ROUTES, type HttpBand, type HttpRoute } from "@jr2/orchestrator/internal";
import { anchor, code } from "../markdown.ts";
import { exportedSymbol, sourceFile } from "../tsdoc.ts";
import { adrLinks, anchorOf, type RefContext } from "./context.ts";
import { renderTypes, typeClosure } from "./types.ts";

export const HTTP_PAGE = "reference/http-api.md";
const ROUTES_FILE = "packages/orchestrator/src/http.ts";

/** The bands of ADR-0014 and ADR-0078, in the order of the credential each asks for. */
const BANDS: { band: HttpBand; title: string; text: string }[] = [
  { band: "open", title: "Open", text: "No token. Structure and observation: no run context, and no control." },
  {
    band: "authenticated",
    title: "Authenticated",
    text: "Any token jr2 minted: the Instance token, or a Sandbox token. A Sandbox token reaches only what its own Sandbox owns.",
  },
  {
    band: "guarded",
    title: "A Caller with a scope",
    text: "A Caller: the Instance token, a named Caller token, or a JWT. Each route needs one scope, for the Workflow of the run or the door that it addresses, and a 403 names the scope and the Workflow. The Instance token has every scope. A Sandbox token is not a Caller, and is refused. A Caller can state the party it acts for in the header `jr2-on-behalf-of`; jr2 records the claim and does not check it.",
  },
  {
    band: "instanceOnly",
    title: "Instance token only",
    text: "The Instance token alone: the routes that no scope opens. A named Caller token is refused, whatever its scopes, and so is a Sandbox token.",
  },
  {
    band: "publishOnly",
    title: "Publish token only",
    text: "The publish token alone, which `jr2 up` reads from the instance Secret. The Instance token is refused, because a publish puts code into the Orchestrator.",
  },
  {
    band: "hook",
    title: "A Hook's verifier",
    text: "No bearer token: the Hook's own verifier checks each delivery, as its kind tells (a `token` header, an `ed25519` signature or a `mac`). A delivery that fails the verifier, or whose signed time is more than 300 seconds from the Orchestrator's clock, gets 401.",
  },
];

export const routeAnchor = (r: HttpRoute): string => anchorOf(r.method, r.path.replace(/\{[^}]*\}/g, ""));

/** The type names a route's body and answer use: each capitalized word the kit's internal root
 * exports as a type. */
export function namedTypes(ctx: RefContext): string[] {
  const internal = sourceFile(ctx.program, "packages/orchestrator/src/internal.ts");
  const words = new Set(
    HTTP_ROUTES.flatMap((r) => `${r.body ?? ""} ${r.response}`.match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? []),
  );
  return [...words].filter((w) => {
    const sym = exportedSymbol(ctx.program, internal, w);
    return sym?.declarations?.some((d) => ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d));
  });
}

/** Text from the table with each named type linked to the Types section. */
function linkTypes(text: string, names: ReadonlySet<string>): string {
  return text
    .split(/(\b[A-Z][A-Za-z0-9]+\b)/)
    .map((part, i) => (i % 2 && names.has(part) ? `[${code(part)}](#${anchorOf("type", part)})` : part))
    .join("")
    .replace(/(^|[^`\]])(<[^>\s]+>)/g, (_, pre: string, tag: string) => pre + code(tag));
}

/** A guarded route's scope, as a reader asks for it. */
function scopeText(scope: NonNullable<HttpRoute["scope"]>): string {
  if (scope === "any") return "any Caller";
  if (typeof scope === "string") return code(scope);
  return `${scope.map(code).join(" or ")}; each opens its own part of the answer`;
}

function renderRoute(ctx: RefContext, r: HttpRoute, names: ReadonlySet<string>): string {
  const rows: [string, string][] = [["Summary", r.summary]];
  if (r.scope !== undefined) rows.push(["Scope", scopeText(r.scope)]);
  if (r.body) rows.push(["Body", linkTypes(r.body, names)]);
  rows.push(["Response", linkTypes(r.response, names)]);
  rows.push(["Stream", r.stream ? "yes: Server-Sent Events" : "no"]);
  if (r.adrs.length) rows.push(["Decisions", adrLinks(ctx, r.adrs, HTTP_PAGE, ROUTES_FILE)]);
  return `${anchor(routeAnchor(r))}\n\n### ${code(`${r.method} ${r.path}`)}\n\n${rows.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`;
}

export function renderHttp(ctx: RefContext): string {
  const roots = namedTypes(ctx);
  const closure = typeClosure(ctx, roots, HTTP_PAGE);
  const names = new Set(closure.types.map((t) => t.name));
  const bands = BANDS.map((b) => {
    const routes = HTTP_ROUTES.filter((r) => r.band === b.band);
    return [
      `${anchor(anchorOf("band", b.band))}\n\n## ${b.title}`,
      b.text,
      ...routes.map((r) => renderRoute(ctx, r, names)),
    ].join("\n\n");
  });
  const intro = [
    `The Orchestrator's HTTP API: what the ${code("jr2")} CLI, the Console, a webhook and the Harness call. Each route is in one access band, by the credential it asks for (${adrLinks(ctx, ["0014", "0078"], HTTP_PAGE, ROUTES_FILE)}). Send a token as ${code("Authorization: Bearer <token>")}. An error answer is ${code("{ error }")}, with the status the route gives. A path segment ${code(":name")} is a parameter; ${code(":name{regex}")} is a parameter that must match the regex.`,
    `Bands: ${BANDS.map((b) => `[${b.title}](#${anchorOf("band", b.band)})`).join(", ")}. The types the bodies and answers name are in [Types](#types).`,
  ];
  return [...intro, ...bands, renderTypes(ctx, closure, HTTP_PAGE)].join("\n\n") + "\n";
}
