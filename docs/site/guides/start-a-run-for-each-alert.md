---
title: Start a run for each alert
description: Make a standing Pool that starts one run for each alert that an outside service sends to a Hook.
---

Start one run of a [Workflow](../reference/glossary.md#workflow) for each alert that an alert service sends to a
[Hook](../reference/glossary.md#hook).

The example has three Workflows and one Hook. The alert service sends each new issue to the Hook `sentry`. The Workflow
`alerts` is a standing [Pool](../reference/glossary.md#pool) of runs: its push Source holds each alert, and the Pool
starts one run of `triage` for each alert, with at most 8 live at one time. A `triage` run waits until a person takes
the alert or dismisses it.

Install `@jr2/hooks` in your [Instance](../reference/glossary.md#instance). It has `webhook()`, which makes the kind of
a service that jr2 ships no kind for:

```sh
npm install @jr2/hooks
```

## Write the kind of the service

The alert service signs the raw body with a shared secret, and puts the HMAC-SHA256 in hex in the header
`sentry-hook-signature`. The header `sentry-hook-resource` and the field `action` give the event key, such as
`issue.created`. The header `request-id` is the id of the delivery. Save the kind as `hooks/sentry.ts`, beside
`workflows/`, because it is not a Workflow:

<<< @/examples/shared/alerts/hooks/sentry.ts

The `declare module` block adds the kind to the types of the handlers. A handler for an event key that the kind does not
give does not compile.

## Write the Workflow of one alert

Save `workflows/triage.ts`. Its door takes the issue id and the title of one alert:

<<< @/examples/shared/alerts/workflows/triage.ts

## Write the standing Pool

Save `workflows/alerts.ts`:

<<< @/examples/shared/alerts/workflows/alerts.ts

- The Source has `item` and `hooks`, and no read: it is a push Source. Its handler gives `carry(item)` for an alert of
  the level `error` or `fatal`, and `skip(reason)` for the other levels.
- The worker is `dispatch("triage", { input, wait: true })`, so each alert is a run of its own of `triage`.
- `itemId` is the key of the run. A second delivery of the same alert finds the run of the first one, and starts no
  second run.
- `standing: true`: jr2 starts the run of the Pool, and keeps one live run of it.

## Declare the Hook

Add the Hook to `jr2.config.ts`, and its secret to the `secrets` list:

<<< @/examples/shared/alerts/jr2.config.ts

`may.answer` names `alerts`, because the Hook brings items to the Pool through the Pool's `source` Gate. Put the secret
in `.env`:

```sh
SENTRY_HOOK=<secret>
```

`<secret>` is a long random value. Give the alert service the same value.

## Converge

```sh
jr2 up
```

<!-- output: not run -->

```text
…
standing: sentry → alerts → triage
…
secret SENTRY_HOOK: an Effect secret in the Instance Effector (hook sentry)
the Instance Effector: holds SENTRY_HOOK
…
standing alerts → triage: live, run 5d0c3f4e-2b7a-4c55-9a51-0f6f2f4c7d21, 0 held items
```

`jr2 up` puts the secret in the [Instance Effector](../reference/glossary.md#instance-effector) only, which checks each
signature. jr2 starts the run of `alerts` at this publish. Your run id is different.

## Set up the alert service

The address of the Hook is `POST /hooks/sentry` on the Orchestrator. `jr2 up` makes the Service `jr2-orchestrator` on
port 4000, with no address outside the cluster. Give the Service an address that the alert service can reach, such as an
ingress. Then give the service the URL `https://<host>/hooks/sentry` and the secret.

## Send a test delivery

You can sign a delivery yourself. Forward a port to the Orchestrator, and keep this command open:

```sh
kubectl -n <namespace> port-forward svc/jr2-orchestrator 4000:4000
```

In a second terminal, sign a body with the secret and send it:

```sh
BODY='{"action":"created","data":{"issue":{"id":"4505","title":"TypeError in checkout","level":"error"}}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SENTRY_HOOK" | sed 's/^.* //')
curl -s -X POST http://localhost:4000/hooks/sentry \
  -H "Content-Type: application/json" \
  -H "sentry-hook-resource: issue" \
  -H "request-id: test-1" \
  -H "sentry-hook-signature: $SIG" \
  -d "$BODY"
```

<!-- output: not run -->

```text
{"delivery":"test-1","seen":false,"delivered":[],"refused":[],"ignored":0,"sources":[{"pool":"5d0c3f4e-2b7a-4c55-9a51-0f6f2f4c7d21","workflow":"alerts","source":"source","verdict":"held","key":"sentry-4505"}]}
```

The Pool holds the alert, and starts a run of `triage` for it when a slot is free. Send the same command again. The
answer has `"seen":true`, because the Hook got the id `test-1` before, and the Pool starts no second run.

## Follow the alerts

[`jr2 runs`](../reference/cli.md#runs) lists the run of `triage` for the alert.
[`jr2 status <run id>`](../reference/cli.md#status) of that run prints, in its `dispatched by:` line, the run of the
Pool, the key `sentry-4505`, and the Hook delivery that carried the alert. The person on call answers its Gate:

```sh
jr2 send <run id> --gate waiting --event take --input '{"who":"<you>"}'
```

`<run id>` is the id of the `triage` run, and `<you>` is your name. To see what the door of the Hook did with each
delivery of the last week, print its log:

```sh
jr2 hooks sentry
```

To stop the alerts for a time, cancel the run of `alerts`. A cancel of a standing Pool is a pause: the Hook's answer has
the verdict `paused`, and the Pool holds nothing. [`jr2 run alerts`](../reference/cli.md#run) resumes it.

## Rules

- `pool()` refuses a Pool of runs that does not stand:
  ``pool("<id>"): a Pool of runs stands: give it `standing: true`. A Pool of runs that a Caller starts and that ends is not offered: its itemId is a key that lives a week past the run, so a second batch in that week does no work (ADR-0017)``
- `pool()` refuses a `dispatch` slot without `wait: true`:
  ``pool("<id>"): its dispatch slot for "<workflow>" has no `wait: true` — with `started` alone, the Pool cannot know when a run ends, and `cap` counts nothing (ADR-0017)``
- `pool()` refuses a `dispatch` slot with a `target`:
  ``pool("<id>"): its dispatch slot for "<workflow>" has a `target` — a Pool of runs on another Orchestrator is not designed: remove the target (ADR-0017)``
- `pool()` refuses a Pool of runs without `cap`:
  ``pool("<id>"): a Pool of runs states its `cap`, a whole number above 0: the most live runs at once (ADR-0017)``
- `pool()` refuses a push Source on a Pool that does not stand:
  `pool("<id>"): a push Source needs a standing Pool of runs: a Pool that ends when it drains would end at once (ADR-0017)`
- `jr2 up` refuses a standing Pool that is not the top Machine of its Workflow:
  `refusing: workflow "<workflow>": machine "<machine>" composes the standing Pool "<id>" — a standing Pool is the top Machine of its Workflow, because jr2 keeps one run of each standing Workflow: move the Pool to a file of its own in workflows/ (ADR-0017)`
- `jr2 up` warns when two standing Pools dispatch to one Workflow:
  ``warning: the standing Pools "<pool>" and "<pool>" each dispatch to "<workflow>": `cap` is for each Pool, so one item that two Sources carry can take a slot in each, and the caps add (ADR-0017)``
- The Orchestrator refuses `jr2 run` of a standing Workflow whose run is live, with the status code `409`:
  ``"<workflow>" is a standing Workflow, and its run <run id> is live: jr2 keeps its run, and `jr2 run` only resumes a paused one (ADR-0017)``
- The Orchestrator refuses a `dispatch` to a standing Workflow:
  `"<workflow>" is a standing Workflow: jr2 starts its run, and a dispatch cannot (ADR-0017)`
- When the Pool holds `hold` items (1000 by default), the door answers 429 with the verdict `hold-full`, and the service
  can send the delivery again.
- While the Pool waits for the back-off of a hand-over, it has no live run, and the door answers 503.
- A Hook whose `may.answer` does not name the Workflow of the Pool brings it nothing.

## Read next

- [Pools and Sources](../concepts/pools-and-sources.md)
- [Callers and Hooks](../concepts/callers-and-hooks.md)
- [Write a Hook kind](write-a-hook-kind.md), for a service that `webhook()` cannot read
- [Start a run from a run](start-a-run-from-a-run.md)
- Reference: [`pool()`](../reference/authoring-surface/pool.md), [`source()`](../reference/authoring-surface/source.md),
  [`carry()`](../reference/authoring-surface/carry.md), [`skip()`](../reference/authoring-surface/skip.md),
  [`dispatch()`](../reference/authoring-surface/dispatch.md) and [`webhook()`](../reference/hooks.md#webhook)
- [ADR-0017](../reference/decisions/0017-pool-over-a-source-port.md): a standing Pool, and a Hook that brings items to
  it
- [ADR-0078](../reference/decisions/0078-a-caller-comes-from-one-authenticator-seam-and-acts-within-its-scopes.md): a
  Hook, and `webhook()`
