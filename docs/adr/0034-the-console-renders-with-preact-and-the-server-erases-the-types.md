# The Console renders with Preact, and the server erases the types

The Console ([ADR-0032](0032-the-console-unlocks-with-the-instance-token.md)) outgrew its framework-free form: `main.js`
reached ~1,500 lines, much of it hand-rolled DOM reconciliation (`memo()`, `paint()`, manual list diffing) — work a view
library exists to own. Three standing constraints shaped the replacement: the repo is zero-build (Node 24 strips types;
nothing compiles), the Console serves only its own assets (ADR-0032), and `@jr2/orchestrator` is a library that serves
its files from disk wherever the process starts. A fourth arrived with this decision: Console source is TypeScript like
everything else.

## Decision

- **Preact, called through `h()` — no JSX.** JSX is codegen, and codegen needs a compiler; `h()` calls are plain
  TypeScript, typechecked against Preact's own types, so the views sit inside `tsc --noEmit` with no toolchain. Preact
  is React's API and mental model in ~4KB, shipped as browser-native ESM the orchestrator can serve verbatim.
- **Console source is `.ts`; the server erases the types.** The browser requests `/assets/*.ts` and receives the file
  with its types replaced by whitespace (`ts-blank-space`), erased once and cached in memory. Erasure is not
  compilation: positions are preserved, so browser stack traces point at the real source line with no sourcemaps, and
  import specifiers keep their `.ts` extensions — the orchestrator does for the browser exactly what Node does for
  itself. The failure class is gated where it belongs: what `ts-blank-space` cannot erase, `tsc --noEmit` already
  rejected in CI.
- **Vendor rides the dep edge.** Preact's ESM files are served at `/assets/vendor/*`, resolved through this package's
  own dependency edge and mapped to bare specifiers by an import map in `page.html` — the elkjs precedent, extended. No
  CDN, no third-party origin; ADR-0032's asset clause does not move.
- **The store stays a pure reducer; the vdom replaces the painter.** `store.js` + `store.d.ts` collapse into one
  `store.ts` read by both consumers (tests through Node's stripping, the browser through the server's). `dispatch` stays
  the one door: fold the frame, render the app from the top, and let vdom diffing do what `memo()`/`paint()` did by
  hand. Signals were rejected: finer-grained updates solve a performance problem SSE-paced frames do not have, at the
  cost of the reducer's tests and the store-first language.
- **The machine canvas stays an imperative island.** elk's layout is async and pan/zoom is a 60Hz transform; neither
  wants a vdom. A component owns the `<svg>` by ref and the existing rendering code moves house without being rebuilt.

## Considered options

- **SolidJS** (the requested starting point). Its fine-grained reactivity lives in its compiler, and the compiler is
  babel-only (`babel-plugin-jsx-dom-expressions`; `esbuild-plugin-solid` wraps babel rather than replacing it). Every
  route to it costs an invariant: babel at runtime widens the production dep chain of the token-guarded package, vite
  middleware puts a dev server in production as the asset pipeline, and a pack-time build hands the repo its only
  toolchain plus the stale-artifact problem class. Solid without its compiler has no reason to exist.
- **React.** Verified against the `react@19.2.8` / `react-dom@19.2.8` tarballs: still CJS
  (`module.exports = require(...)` behind a `process.env.NODE_ENV` branch) — a browser evaluates neither. Self-serving
  it means a resolve-and-bundle step at boot. Preact offers the same API for a page that ADR-0032 already bars from
  React's real advantage, the third-party component ecosystem.
- **Runtime vite.** Works mechanically (middleware mode); rejected because vite's dev server is explicitly not for
  production serving, and it relocates compile errors to the worst place — a 500 from a deployed orchestrator instead of
  a red CI step.
- **`htm` tagged templates.** A no-build JSX-alike, but props inside template strings sit outside the type checker — an
  untyped gap exactly where the Console's bugs live (rail rows, gate cards, schema forms). `h()` keeps the views typed.

## Consequences

- The erasable-syntax constraint (no enums, no constructor parameter properties) now applies to Console code, as it
  already does to everything Node runs in this repo.
- `ts-blank-space` and `preact` become production dependencies of `@jr2/orchestrator`; the package's `typecheck` must
  cover `console/` with DOM types.
- TSX later is additive — an `esbuild.transform()` at the same serve point — not a rework.
- The refactor is behavior-preserving: `console-store.test.ts` retargets to `store.ts`, the `@console` browser tier and
  the default e2e profile stay the acceptance bar, and no route moves except how `/assets/*` bytes are produced.
