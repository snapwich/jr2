// The two views of the Harness wire, held in agreement by the COMPILER (ADR-0027).
//
// `@j2/harness` serves the wire; `src/wire.ts` is the Orchestrator's own view of it, restated
// because `@j2/orchestrator` is published to npm and `@j2/harness` is not (ADR-0009/0043). That
// restatement is only safe if drift is caught, and `pnpm typecheck` is what catches it: every
// assignment below fails the build the moment either side's shape moves without the other.
//
// This file is the ONE place the two meet. It lives under `test/`, which is outside the package's
// `files:` list, so `@j2/harness` stays a devDependency the published package never reaches for —
// which is the whole point of the restatement.
//
// The checks are MUTUAL (each side assignable to the other), because one direction alone passes a
// server that added a required field or a client that dropped an optional one.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as harness from "@j2/harness/wire";
import * as client from "../src/wire.ts";

/** Both directions, in one expression per pair: the compiler is the assertion. */
// The `[A] extends [B]` form is load-bearing: a NAKED type parameter distributes over a union, so
// `StreamEvent extends StreamEvent` would check member-by-member and collapse a half-match to
// `boolean` — which `[true, true]` still satisfies. Wrapped, the union is compared whole.
type Mutual<A, B> = [[A] extends [B] ? true : false, [B] extends [A] ? true : false];
const agree: Mutual<true, true> = [true, true];

const settlement: Mutual<client.Settlement, harness.Settlement> = agree;
const outcome: Mutual<client.SettlementOutcome, harness.SettlementOutcome> = agree;
const error: Mutual<client.SettlementError, harness.SettlementError> = agree;
const position: Mutual<client.StreamPosition, harness.StreamPosition> = agree;
const appended: Mutual<client.MessageAppendedEvent, harness.MessageAppendedEvent> = agree;
const settled: Mutual<client.SubmissionSettledEvent, harness.SubmissionSettledEvent> = agree;
const stream: Mutual<client.StreamEvent, harness.StreamEvent> = agree;
const echoStatus: Mutual<client.EchoStatusEvent, harness.EchoStatusEvent> = agree;
const echoChild: Mutual<client.EchoStatusChild, harness.EchoStatusChild> = agree;
const echoEmit: Mutual<client.EchoEmitEvent, harness.EchoEmitEvent> = agree;
const echoAdmission: Mutual<client.EchoAdmissionEvent, harness.EchoAdmissionEvent> = agree;
const echoPick: Mutual<client.EchoPickEvent, harness.EchoPickEvent> = agree;
const echo: Mutual<client.EchoEvent, harness.EchoEvent> = agree;
const echoRequest: Mutual<client.EchoRequest, harness.EchoRequest> = agree;

test("the client's wire shapes and the Harness's are one contract", () => {
  // The type-level claims above are already asserted by `tsc`; this reads them so the file has no
  // unused bindings, and states out loud that a green typecheck is the real assertion.
  for (const pair of [
    settlement,
    outcome,
    error,
    position,
    appended,
    settled,
    stream,
    echoStatus,
    echoChild,
    echoEmit,
    echoAdmission,
    echoPick,
    echo,
    echoRequest,
  ]) {
    assert.deepEqual(pair, [true, true]);
  }
});

test("the wire's settlement-error literals are the ones the Harness stamps", () => {
  // Values, not types — the one part a `Mutual` check cannot see. The Agent actor switches on
  // `runaway` (ADR-0035) and never parses prose, so a one-character drift here is a fault class
  // that silently stops being recognized.
  assert.equal(client.SUBMISSION_ABORTED, harness.SUBMISSION_ABORTED);
  assert.equal(client.SUBMISSION_RUNAWAY, harness.SUBMISSION_RUNAWAY);
  assert.equal(client.STREAM_NEXT_OFFSET_HEADER, harness.STREAM_NEXT_OFFSET_HEADER);
  assert.equal(client.VIEW_UPDATES, harness.VIEW_UPDATES);
  assert.equal(client.LIVE_LONG_POLL, harness.LIVE_LONG_POLL);
});
