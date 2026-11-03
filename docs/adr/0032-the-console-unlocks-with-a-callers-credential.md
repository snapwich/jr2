# The Console unlocks with a Caller's credential, and shows what its scopes allow

[ADR-0014](0014-observation-is-open-run-state-is-not.md) built the HTTP surface on one premise: the visualizer page is a
browser, and a browser holds no token — so it got a projection instead of a credential, and "give the page a token" was
explicitly rejected. That page is now the **Console**: it starts runs, answers Gates and cancels runs, which are writes
on the guarded surface. This ADR records how a browser earns those writes without moving the open band. The person
presents a credential; the page never ships with one.

## Decision

- **The person presents a Caller's credential; the page never ships with one.** The Console's nav carries a password
  field, and a login button when the Instance declares a JWT issuer
  ([ADR-0078](0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md)). Empty, the page is
  precisely ADR-0014's observer: open structure and observation, no control rendered. With a credential, the page sends
  `Authorization: Bearer` on the guarded surface. The credential is any Caller's: the Instance token, a named Caller
  token, or a JWT. The login gets a JWT from the issuer with OIDC (the authorization code flow with PKCE, as a public
  client), and the page then uses it as it uses a typed token. The page as _served_ stays open and inert; ADR-0014's
  rejection stands, because what it rejected was baking the credential into the page.
- **The page shows only what the Caller's scopes allow.** On entry the page asks `GET /whoami` for the Caller record:
  its name, the name that jr2 shows, and its scopes for each Workflow. It renders a control only where a scope opens its
  route: the start form with `start` for that Workflow, Gate cards with `answer`, cancel with `cancel`, a run's full
  state with `read`, and the Steering box with `steer`. The nav shows who the page acts as. The server still checks each
  request (ADR-0014); the page hides a control so that a person does not meet a 403, not as a guard.
- **The credential lives in `sessionStorage`** — survives a reload, dies with the tab, never a cookie (no ambient
  credential, no CSRF surface). A typed token and a login's JWT live there alike. A later 401 (an expired JWT, a rotated
  token) drops the UI back to observer mode rather than failing per widget.
- **Gate discovery is a frame-triggered guarded read, not an open-band extension.** A Gate exists exactly while its
  invoking state is entered ([ADR-0011](0011-workflow-defined-events.md)), and every entry/exit lands a status frame on
  the open workflow feed (ADR-0022) — so on each frame, a Console whose Caller has `answer` re-fetches `GET /runs/:id`
  for the affected run and folds `gates` into its store. Perfectly synchronized, no polling loop, and the observation
  projection is untouched. A delivery's success is likewise confirmed by the next frame emptying the card, never by
  local bookkeeping.
- **Page addresses content-negotiate; JSON is the default dialect.** `/` and `/workflows/:name` serve the Console shell
  to `Accept: text/html` and JSON to everything else — so the workflow-detail resource keeps its natural address (the
  run-input schema's home, [ADR-0033](0033-a-machine-declares-the-input-that-starts-it.md)) and no future page has to
  squat on a mangled sibling path. Nothing existing moves: EventSource asks `text/event-stream`, and the Harness's Menu
  and the CLI never ask for HTML. `/viz/*` is deleted (greenfield, no redirects); assets move to `/assets/*`, which also
  retires the "a workflow named `assets` is shadowed" hazard.

## Considered options

- **`jr2 ui` — the CLI opens the browser through an authenticated local proxy.** A convenience layer worth building _on
  top of_ the token field later, not a substitute: it has no answer for the deployed jr2 Application behind an ingress,
  where the browser talks to the Service directly and the CLI is not in the path.
- **The Instance token alone.** Rejected (ADR-0078): a person who must answer Gates and holds no cluster RBAC would then
  hold every act on every run. A scoped Caller's credential is what that person holds.
- **Announce gates on the open observation feed** (even just `{runId, gate}`). Rejected: it widens the projection for a
  convenience the credential already solves, and the open band has an unresolved exposure question as it stands (spawn
  ids — the ADR-0014 open call). The projection stays the one place the line is drawn.
- **A `/ui` path prefix, or moving the API under `/api`.** Rejected for negotiation: the first is ceremony on the
  address a human types, the second churns the Harness's Menu, the Custodian's route allowlist, the CLI, and the
  ADR-0009/0013 route tables for cosmetics.

## Consequences

- **No new band.** The server-side diff of the Console itself is: negotiate two addresses, serve the shell, retire
  `/viz/*`. The scopes, `GET /whoami` and the login's issuers are ADR-0078's.
- **Possession follows the credential.** The Instance token stays one `kubectl get secret` away for whoever holds
  cluster RBAC; a named token is what its holder was given; a login is what the identity provider's groups grant.
- **The XSS caveat is the real one and is bounded by what the page is:** a credential in `sessionStorage` is readable by
  scripts on the page, so the Console must keep serving only its own assets — no CDN, no third-party script, exactly the
  constraint the viz page already lives under.
- **GLOSSARY.md**: **Console** is a glossary term (visualizer, dashboard, UI, viz on its Avoid list).
- **The Console's UX gets a browser tier** — `@console`-tagged Cucumber scenarios holding a Playwright page, in
  `@jr2/e2e`, excluded from the default profile ([ADR-0010](0010-bdd-acceptance-tests.md) as amended). What the page
  _believes_ stays unit-tested in `console-store.test.ts`; the browser tier asserts what a user does and sees, and the
  login against Dex in a container (ADR-0078).
