# The Console unlocks with the Instance token, and the bands do not move

[ADR-0014](0014-observation-is-open-run-state-is-not.md) built the three-band HTTP surface on one premise: the
visualizer page is a browser, and a browser holds no token — so it got a projection instead of a credential, and "give
the page a token" was explicitly rejected. That page is now growing into the **Console**: it starts runs and answers
Gates, both of which are writes on the guarded surface. This ADR records how a browser earns those writes without moving
a single band — and it can stay this small because of a fact ADR-0014 did not lean on: the Instance token is already one
`kubectl get secret` away for exactly the audience the Console serves. There is no new distribution problem, only a new
presentation surface.

## Decision

- **The human presents the token; the page never ships with one.** The Console's nav carries a password field. Empty,
  the page is precisely ADR-0014's observer: open structure and observation, no control rendered. Filled, the page sends
  `Authorization: Bearer` on the guarded surface — which unlocks both directions at once: the writes
  (`POST /workflows/:name/runs`, `POST /runs/:id/gates/:gate/events`) and the `instanceOnly` reads the control UI needs
  anyway (`GET /runs`, and `GET /runs/:id` — where `GateView` lives). The page as _served_ stays open and inert;
  ADR-0014's rejection stands, because what it rejected was baking the credential into the page.
- **The token lives in `sessionStorage`** — survives a reload, dies with the tab, never a cookie (no ambient credential,
  no CSRF surface). It is validated on entry with a cheap guarded read so the field shows live/invalid immediately; any
  later 401 drops the UI back to observer mode rather than failing per-widget.
- **Gate discovery is a frame-triggered guarded read, not an open-band extension.** A Gate exists exactly while its
  invoking state is entered (ADR-0011), and every entry/exit lands a status frame on the open workflow feed (ADR-0022) —
  so on each frame, a token-holding Console re-fetches `GET /runs/:id` for the affected run and folds `gates` into its
  store. Perfectly synchronized, no polling loop, and the observation projection is untouched. A delivery's success is
  likewise confirmed by the next frame emptying the card, never by local bookkeeping.
- **Page addresses content-negotiate; JSON is the default dialect.** `/` and `/workflows/:name` serve the Console shell
  to `Accept: text/html` and JSON to everything else — so the workflow-detail resource keeps its natural address (the
  run-input schema's home, [ADR-0033](0033-a-machine-declares-the-input-that-starts-it.md)) and no future page has to
  squat on a mangled sibling path. Nothing existing moves: EventSource asks `text/event-stream`, and the Adapter and CLI
  never ask for HTML. `/viz/*` is deleted (greenfield, no redirects); assets move to `/assets/*`, which also retires the
  "a workflow named `assets` is shadowed" hazard.

## Considered options

- **`j2 ui` — the CLI opens the browser through an authenticated local proxy.** A convenience layer worth building _on
  top of_ the token field later, not a substitute: it has no answer for the deployed j2 Application behind an ingress,
  where the browser talks to the Service directly and the CLI is not in the path.
- **A fourth, scoped credential** ("may answer gates, may not cancel or read context"). Still rejected, as in ADR-0014 —
  but the calculus has narrowed: it becomes worth writing only when gate-answering is delegated to people who must _not_
  hold cluster RBAC. That is a real future (an approval inbox for non-operators); it is not this one.
- **Announce gates on the open observation feed** (even just `{runId, gate}`). Rejected: it widens the projection for a
  convenience the token already solves, and the open band has an unresolved exposure question as it stands (spawn ids —
  the ADR-0014 open call). The projection stays the one place the line is drawn.
- **A `/ui` path prefix, or moving the API under `/api`.** Rejected for negotiation: the first is ceremony on the
  address a human types, the second churns the Adapter, the CLI, and the ADR-0009/0013 route tables for cosmetics.

## Consequences

- **Zero new server surface except negotiation.** No new token, no new band, no new route class; `auth.test.ts`'s
  boundary assertions are untouched. The server-side diff is: negotiate two addresses, serve the shell, retire `/viz/*`.
- **Possession remains cluster RBAC.** Whoever can read the instance Secret could already do everything the Console
  unlocks; the field changes where the token is typed, not who holds it.
- **The XSS caveat is the real one and is bounded by what the page is:** a token in `sessionStorage` is readable by
  scripts on the page, so the Console must keep serving only its own assets — no CDN, no third-party script, exactly the
  constraint the viz page already lives under.
- **CONTEXT.md**: **Console** becomes a glossary term (visualizer, dashboard, UI, viz on its Avoid list).
- **The Console's UX gets a browser tier** — `@console`-tagged Cucumber scenarios holding a Playwright page, in
  `@j2/e2e`, excluded from the default profile ([ADR-0010](0010-bdd-acceptance-tests.md) as amended). What the page
  _believes_ stays unit-tested in `console-store.test.ts`; the browser tier asserts what a user does and sees.
